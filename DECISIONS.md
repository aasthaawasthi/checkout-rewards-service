# Design Decisions

This document explains what the service guarantees, where each guarantee is enforced, which ambiguities I resolved and how, and what I deliberately left out.

**Contents**
1. [System invariants](#1-system-invariants)
2. [Ambiguities and chosen semantics](#2-ambiguities-and-chosen-semantics)
3. [Material design decisions](#3-material-design-decisions)
4. [Transactions, concurrency and idempotency](#4-transactions-concurrency-and-idempotency)
5. [Money and rounding](#5-money-and-rounding)
6. [Error model](#6-error-model)
7. [Implemented vs deferred](#7-implemented-vs-deferred)
8. [Multiple instances and production scale](#8-multiple-instances-and-production-scale)
9. [How the tests were validated](#9-how-the-tests-were-validated)
10. [Use of AI tools](#10-use-of-ai-tools)
11. [With two more hours](#11-with-two-more-hours)

---

## 1. System invariants

Each invariant is listed with **where it is enforced**. Most have two layers: the transaction logic, and a database constraint that would still hold if a code path were wrong.

| # | Invariant | Enforced by |
|---|---|---|
| I1 | Stock never goes below zero (no overselling) | Pre-check inside the checkout transaction; conditional `UPDATE … WHERE stock >= qty`; `CHECK (stock >= 0)` |
| I2 | A cart produces at most one order | Cart status checked and flipped `OPEN → CHECKED_OUT` with `WHERE status = 'OPEN'` in the same transaction; `orders.cart_id UNIQUE` |
| I3 | A retried checkout never creates a second order or charges stock/payment twice | `idempotency_keys` row written in the same transaction as the order; looked up first on every request |
| I4 | A coupon is redeemed at most once | `UPDATE coupons … WHERE status = 'AVAILABLE'` must change exactly 1 row; `redeemed_order_id UNIQUE`; `CHECK` linking status and order |
| I5 | A failed checkout consumes nothing (stock, coupon, cart, key) | All checks and writes in one transaction; any failure throws → rollback |
| I6 | At most one coupon per milestone; a coupon exists only for a reached milestone | Generation logic inside an IMMEDIATE transaction; `coupons.milestone UNIQUE` |
| I7 | An order fully explains what was bought and how the total was computed, forever | `order_items` snapshot (name, unit price, qty, line total); order stores subtotal, discount, percent, coupon; reads never join live products |
| I8 | `total = subtotal − discount`, `0 ≤ discount ≤ subtotal` | `percentDiscount` caps at subtotal; `CHECK (total_paise = subtotal_paise - discount_paise)`; non-negative `CHECK`s |
| I9 | Money is exact | Integer paise everywhere; `Number.isSafeInteger` guards; input bounds |
| I10 | A placed order's contents equal the cart at checkout; a cart can't change after checkout | Every cart write re-checks `OPEN` inside an IMMEDIATE transaction, serialised with checkout |
| I11 | Order numbers are unique and gap-free, so milestone counting is unambiguous | `MAX(order_number)+1` computed under the write lock; `order_number UNIQUE`; failed checkouts never allocate a number |
| I12 | The report reconciles with orders and coupons and never mutates | Single read transaction (one snapshot) over the same tables the order/coupon endpoints read; no writes |

---

## 2. Ambiguities and chosen semantics

| Question | Choice | Reason |
|---|---|---|
| What counts as a "successfully placed order" for milestones? | Every committed order, including those that used a coupon or totalled ₹0 | It's the simplest rule that's easy to explain and audit; "successfully placed" says nothing about payment amount |
| When does a coupon come into existence? | Only when an admin calls `POST /admin/coupons`; reaching a milestone alone does not create one | The spec says "an administrator can request coupon generation". The report shows `awaitingGeneration` so nothing is invisible |
| Admin is behind and several milestones are pending | Each call generates **one** coupon for the **earliest** unrewarded milestone; response includes `remainingEligibleMilestones` | One call creates one resource (a clean 201), and it is deterministic. Batch generation is an easy extension |
| Who can use a coupon? | Anyone holding the code (store-wide bearer coupon), once | There are no customer identities in scope. Binding coupons to the customer who placed the n-th order is listed under deferred |
| Which percent does a coupon carry if `x` changes? | The `x` at generation time, stored on the coupon | Issued coupons are a promise; reconfiguration must not silently change them |
| What if `n` changes? | Treated as fixed for the life of a database (documented assumption) | Changing n re-maps which order numbers are milestones. Doing that safely needs a migration policy, not a silent recount |
| How many coupons per order? | At most one | Avoids compounding rules nobody asked for |
| What does the discount apply to? | The whole order subtotal, rounded down to the paisa | Deterministic and simple; see §5 |
| Coupon expiry? | None | Not specified; listed as deferred |
| Coupon code case/whitespace | Trimmed and case-insensitive; generated codes are uppercase without ambiguous characters (no 0/O/1/I) | Codes get read aloud and typed |
| Price changes between add-to-cart and checkout | Checkout fails `409 PRICE_CHANGED` (no side effects). The customer must call `accept-current-prices` (or PATCH the line), then check out | Never charge a price the customer hasn't seen, and never let a blind retry do it. See Decision 4 |
| Stock drops after add-to-cart | Not reserved. Checkout fails `409 INSUFFICIENT_STOCK` listing every short line; the cart stays open for the customer to adjust | See Decision 3 |
| Adding a product that is already in the cart | `409 ITEM_ALREADY_IN_CART`; use PATCH | Makes a retried "add" harmless instead of doubling the quantity |
| Removing the last item / quantity 0 | DELETE removes a line; PATCH requires quantity ≥ 1 | One way to do each thing |
| Is a declined payment "a checkout that ultimately fails"? | Yes: full rollback, coupon remains available, cart stays open | Directly required |

---

## 3. Material design decisions

### Decision 1: SQLite with real transactions instead of an in-memory store

**Context:** The core risks are overselling, double orders and double redemption under overlapping requests. The store has to make "check then write" atomic.

**Options considered:**
- **In-memory maps + a mutex/queue.** Allowed by the brief, and simple. But atomicity has to be hand-built: an exception halfway through a checkout needs manual undo. And it only works inside one process, so it can't demonstrate anything about multiple instances.
- **PostgreSQL.** The production answer, but it needs Docker or an install for whoever evaluates this.
- **SQLite via `better-sqlite3`.** A real ACID database in a local file. No setup, real transactions, real constraints, and several processes can share it.

**Choice:** SQLite (WAL mode, `busy_timeout = 5000`, foreign keys on).

**Why:** Rollback-on-throw gives "a failing checkout consumes nothing" for free, and constraints give a second line of defence for every invariant. Because two processes can open the same file, the test suite can run two service instances against one database and show the invariants hold across processes (§9). Data access goes through Drizzle ORM (Decision 11), whose schema and query builder also exist for Postgres, so the move in §8 is mostly a dialect change.

**Consequences:** SQLite allows one writer at a time. That's fine at this scale, and it makes reasoning simple, but it caps write throughput (§8). `better-sqlite3` is synchronous, so the fake payment must be synchronous too (Decision 6).

### Decision 2: One IMMEDIATE transaction for the whole checkout

**Context:** Checkout reads the cart, prices, stock and coupon, then writes stock, order, items, coupon, cart and idempotency key. Any interleaving between the reads and writes could oversell, double-redeem, or charge a cart twice.

**Options considered:**
- **Optimistic:** read without locks, then write with version checks and retry on conflict.
- **Deferred transaction:** `BEGIN`, take the write lock lazily at the first write.
- **`BEGIN IMMEDIATE`:** take the write lock up front.

**Choice:** `BEGIN IMMEDIATE` for every write path (checkout, cart edits, coupon generation, product admin). Inside it, writes are still conditional (`WHERE stock >= ?`, `WHERE status = 'AVAILABLE'`, `WHERE status = 'OPEN'`) and checked for `changes === 1`.

**Why:** With the lock taken first, every check sees data that cannot change before commit, so the logic reads top to bottom with no retry loop. With a deferred transaction in WAL mode, two transactions can both read and then one fails to upgrade (`SQLITE_BUSY`), which turns contention into client-visible errors. With IMMEDIATE, the second writer simply waits up to `busy_timeout`. The conditional writes and constraints mean correctness doesn't rest on the lock mode alone. Mutation testing confirmed that matters (§9).

**Consequences:** Checkouts are serialised. That's appropriate here and simple to reason about; §8 covers what changes at scale.

### Decision 3: Validate stock at add-to-cart, enforce and decrement only at checkout (no reservation)

**Context:** "The system must not sell more inventory than is available." Stock can change while items sit in carts.

**Options considered:**
- **Reserve stock when items are added**, released on removal or cart expiry. This stops the "out of stock at checkout" surprise, but abandoned carts lock inventory and need an expiry job. One customer could also hold all 3 limited sneakers indefinitely.
- **No reservation; check atomically at checkout.**

**Choice:** No reservation. Add and update give early feedback (`409 INSUFFICIENT_STOCK` if the quantity exceeds current stock). The authoritative check and decrement happen inside the checkout transaction. If any line is short, the error lists **every** short line and nothing is decremented.

**Why:** It has no background jobs or expiry state, and abandoned carts can't hoard limited stock. Overselling is impossible either way, because the decrement is atomic and conditional.

**Consequences:** A customer can lose a race at checkout. They get a precise, actionable error and their cart stays open. A short reservation at checkout start (e.g. 10 minutes) is the natural extension if the business wants it.

### Decision 4: Price changes block checkout until the customer explicitly accepts them

**Context:** "Decide what happens when price or availability changes after an item was added." Each cart line stores `price_seen_paise`, the price the customer was shown.

**Options considered:**
- **Lock in the add-time price.** Customer-friendly, but a stale cart could buy at an old price indefinitely, which a business usually won't accept.
- **Silently charge the current price.** Simple, but the customer pays an amount they never saw.
- **Fail with `PRICE_CHANGED`, and refresh the cart's prices as a side effect of that failed checkout.** This was my first design. I rejected it because a client that blindly retries the same request (exactly what the brief says clients do) would succeed on the second attempt at a price the customer never saw.
- **Fail with `PRICE_CHANGED` with no side effects; require an explicit accept step.**

**Choice:** The last option. The cart view always shows current price, seen price and a `priceChanged` flag. Checkout returns `409 PRICE_CHANGED` with old and new prices per line. `POST /carts/:id/accept-current-prices`, or a PATCH of the line, records acceptance.

**Why:** It keeps "every failed checkout has zero side effects" true without exception, which keeps the idempotency story simple (Decision 5). And money only moves at a price the customer has seen.

**Consequences:** One extra round trip after a price change. Price *decreases* are also blocked, which is conservative. Auto-accepting decreases is a small change but adds a branch to explain.

### Decision 5: Idempotency key per checkout, recorded atomically with the order, success only

**Context:** "A retry must not accidentally create another order or charge inventory twice."

**Options considered:**
- **Rely on the cart:** one order per cart, so a retry returns `CART_ALREADY_CHECKED_OUT`. That's safe, but the retry gets an *error* instead of its order. A client whose response was lost can't tell "my order succeeded" from "someone else checked out this cart".
- **Idempotency-Key header (Stripe-style), storing every outcome including failures.**
- **Idempotency-Key header, storing only successful outcomes.**

**Choice:** A required `Idempotency-Key` header. Inside the checkout transaction the key is looked up first:
- same key and same request (hash of cart id + normalised coupon) → `200` with the original order and `Idempotent-Replayed: true`
- same key and different request → `422 IDEMPOTENCY_KEY_REUSED`

On success, the key row is inserted **in the same transaction** as the order, so "order exists" and "key recorded" can never disagree. Failures are not recorded. On top of this, the cart-level guard (I2) still applies to requests with different keys.

**Why:** Because every failure has zero side effects (Decisions 2 and 4), re-evaluating a failed request is safe. It is also more useful: a retry after a payment decline or a restock can succeed. Storing failures would freeze a transient failure into the key.

**Consequences:** Keys have no TTL yet (deferred). Keys are global, so two clients choosing the same key for different carts get a 422. UUIDs make that practically impossible. A key can't be "in progress" here because the lock makes the whole check-and-write atomic. In a system where the payment call happens outside the transaction, an `IN_PROGRESS` state is needed (§8).

### Decision 6: Payment through a small synchronous interface with a fake, inside the transaction

**Context:** No real payment is required, but "a coupon must not be consumed by a checkout that ultimately fails" is easiest to demonstrate if checkout *can* fail late.

**Options considered:**
- **No payment concept;** successful checkout means paid.
- **A fake gateway behind an interface,** called inside the transaction.
- **A realistic async flow:** a PENDING order, charge outside the transaction, then confirm or compensate.

**Choice:** A `PaymentGateway` interface with a `FakePaymentGateway` that approves, or declines when the test toggles it or the `X-Simulate-Payment: decline` header is sent. It is charged after all validation and before any write. A decline throws `402 PAYMENT_DECLINED` and everything rolls back.

**Why:** It gives a genuine late failure for tests to prove I5 (stock, coupon, cart and key untouched) without building a saga the brief doesn't need. The gateway receives the idempotency key, as a real provider would.

**Consequences:** **A real payment provider must not be called inside a DB transaction**: it's a slow network call that could hold the write lock. The production flow is described in §8. The interface is the seam where that change happens.

### Decision 7: Coupons are generated on admin request, one per milestone, earliest first, with fixed value

**Context:** "Generate a coupon only if the configured milestone has been reached and a coupon has not already been generated for that milestone."

**Options considered:**
- **Auto-generate inside the n-th checkout.** Nothing is ever missed, but it contradicts the explicit admin operation and couples checkout to rewards.
- **Admin generates for the *latest* milestone only.** Older unrewarded milestones would be skipped forever.
- **Admin generates for the *earliest* unrewarded milestone, one per call.**

**Choice:** The last option. Milestone *k* is reached at *k × n* placed orders. Coupons are keyed by milestone (`UNIQUE`) and store the order count that unlocked them plus their own percent.

**Why:** It's deterministic, idempotent under races (concurrent admin calls produce one coupon; tested across processes), and nothing is lost if the admin is late. Storing the percent on the coupon makes later `x` changes safe.

**Consequences:** If `n` changes, existing milestone numbers no longer line up with order counts, so `n` is documented as fixed per database. The report shows `awaitingGeneration` so pending rewards are visible.

### Decision 8: Orders store an immutable snapshot and are never joined to live product data

**Context:** "An order must retain enough information to explain what the customer purchased and how its total was calculated."

**Options considered:**
- **Store product ids and quantities and join to products on read.** Wrong as soon as a price or name changes.
- **Store a full snapshot per line and per order.**

**Choice:** Snapshot. `order_items` holds the name, unit price, quantity and line total. `orders` holds the subtotal, discount, percent, coupon code, total and payment reference. `GET /orders/:id` reads only these. The response also states the discount rule.

**Why:** The order becomes a self-contained receipt. The report's per-product revenue comes from the same snapshot, so it reconciles.

**Consequences:** Some duplication, which is intentional for a financial record.

### Decision 9: Make retried cart writes safe by API shape, not by more idempotency keys

**Context:** Cart writes can be retried too. A naive "add 2" retried becomes 4.

**Options considered:**
- **Idempotency keys on every write.**
- **An "add" that increments.**
- **An "add" that rejects duplicates, plus a PATCH that sets an absolute quantity.**

**Choice:** `POST /items` rejects a product already in the cart (`409 ITEM_ALREADY_IN_CART`). `PATCH` sets an absolute quantity, and `DELETE` removes.

**Why:** Absolute operations are naturally idempotent, and a retried add can't double anything, with no extra infrastructure. Keys are kept for the one operation with external effects (checkout).

**Consequences:** A client wanting "+1" must read and then PATCH. That's acceptable for a cart.

### Decision 10: Validate strictly at the edge with zod; reject rather than coerce

**Context:** "Invalid products or quantities must not silently enter a cart."

**Choice:** Strict schemas. Quantity must be a JSON integer from 1 to 1000; `"2"`, `2.5`, `0`, negatives and unknown fields (e.g. a client-sent `price`) are rejected with `400 VALIDATION_ERROR` and a list of issues. Prices are never accepted from the cart API. Unknown product → `422 PRODUCT_NOT_FOUND`. Config (`n`, `x`) is validated at startup, so the service refuses to start with `x = 150` or `n = 0`.

**Why:** Coercion hides client bugs, and silently accepting extra fields invites "send your own price" mistakes. Bounds also keep all money arithmetic inside safe-integer range (§5).

---

### Decision 11: Drizzle ORM for data access, with constraints and migrations in the schema

**Context:** The first version used hand-written SQL through `better-sqlite3`. That's explicit, but there's no typing between queries and the schema, and schema changes have no migration history. I wanted typed queries, a single schema definition and versioned migrations, without losing control over the exact statements the concurrency guarantees rely on.

**Options considered:**
- **Raw SQL (status quo).** Full control, but no types, and the schema lives in a string.
- **Prisma.** The most popular choice. But its SQLite interactive transactions don't let you choose `BEGIN IMMEDIATE`, so concurrent writers would fail with `SQLITE_BUSY` instead of waiting. It also adds a generate step and a query engine.
- **TypeORM.** Entity classes and decorators, familiar from NestJS. It's heavier, and `IMMEDIATE` transactions need workarounds.
- **Drizzle ORM.** A thin, typed query builder over the same `better-sqlite3` driver; `drizzle-kit` generates SQL migrations from a TypeScript schema.

**Choice:** Drizzle.
- The schema in `src/db/schema.ts` declares every table, `UNIQUE` and `CHECK` constraint.
- `npm run db:generate` produces the SQL migration in `drizzle/`, which the service applies on startup (`npm run db:migrate` runs it as a separate step).
- All application queries use the query builder; there is no hand-written SQL in the services. The only `sql` fragments are the CHECK definitions and the atomic decrement `stock = stock - q`, which Drizzle has no helper for.

**Why:** Drizzle keeps what correctness depends on:
- synchronous transactions with `{ behavior: 'immediate' }`
- conditional updates whose `.run().changes` we check
- constraints declared in the schema and visible in the generated migration

It also adds compile-time checking of every column and query. After the switch, all 39 tests and every mutation check in §9 behaved exactly as before.

**Consequences:**
- Drizzle's migrator reads which migrations were applied *before* opening its transaction. In principle, two instances starting on an empty database at the same instant could both try to apply the first migration, and the loser would fail with "table already exists". I didn't reproduce this in 15 simultaneous starts, but re-running the migrator is safe, so startup retries on that error (`runMigrations` in `database.ts`). In production, migrations would run once as a deploy step.
- Aggregates like `SUM()` come back as strings (to avoid overflow); the report maps them to numbers, which is safe within our money bounds (§5).

---

## 4. Transactions, concurrency and idempotency

**Write paths** (checkout, add/update/remove item, accept prices, coupon generation, product admin) all run in `BEGIN IMMEDIATE` transactions. SQLite has one write lock per database file, so these are serialised across all connections and **all processes** on the same file. A writer that finds the lock held waits up to 5 s (`busy_timeout`). If it still can't get it, the client gets `503 SERVICE_BUSY` with `Retry-After`, and nothing has changed, so a retry with the same key is safe.

**Read paths** (cart view, order view, report) don't take the write lock. In WAL mode a read transaction sees one consistent snapshot, which is why the report always reconciles even while checkouts commit.

**Checkout, in order, inside one transaction** (`src/services/checkoutService.ts`):

1. Look up the idempotency key, then replay or reject reuse.
2. Load the cart: it must exist, be `OPEN` and be non-empty (else `404` / `409 CART_ALREADY_CHECKED_OUT` with the order id / `422 CART_EMPTY`).
3. Every line's current price must equal the seen price (else `409 PRICE_CHANGED`).
4. Every line must have enough stock (else `409 INSUFFICIENT_STOCK`, listing every short line).
5. The coupon, if given, must exist (`422`) and be available (`409`).
6. Compute totals in integer paise.
7. Charge the fake payment (decline → `402`).
8. Conditional stock decrements, order + snapshot items, conditional coupon redemption, conditional cart close, idempotency record.
9. Commit.

A throw at any step rolls back steps 1–8.

**Races and their outcomes:**

| Race | Outcome |
|---|---|
| N checkouts for the last K units (N > K) | Exactly K succeed; the rest get `409 INSUFFICIENT_STOCK`; their carts stay open |
| Same checkout retried concurrently, same key | One `201`, the others `200` with the same order; one payment charge |
| Same cart, two different keys | One `201`, one `409 CART_ALREADY_CHECKED_OUT` carrying the winner's order id |
| Two checkouts with the same coupon | One succeeds with the discount; the other gets `409 COUPON_ALREADY_REDEEMED`, its cart stays open, and it can retry without the coupon |
| Checkout fails late (payment) while holding a coupon | Rolled back; coupon still `AVAILABLE` |
| Add-item racing a checkout of the same cart | Serialised: the item is either in the order or rejected with `409 CART_NOT_OPEN`, never lost |
| Concurrent admin coupon generation | One coupon per milestone; others get `409 NO_ELIGIBLE_MILESTONE` |
| Report during checkouts | Consistent snapshot; never a half-committed order |

---

## 5. Money and rounding

- **Representation:** integer paise in the database, the code and the API (`…Paise` fields). There are no floats anywhere in arithmetic; formatted strings are display-only.
- **Line total** = `unitPricePaise × quantity`, which is exact.
- **Subtotal** = sum of line totals.
- **Discount** = `floor(subtotalPaise × percent / 100)`, applied once to the subtotal (not per line). The multiplication happens first, so it is exact, then integer floor.
  - Rounding *down* means the customer never gets more than the advertised percent, and the result is identical every time (no banker's rounding, no float drift).
  - Per-order rather than per-line rounding avoids summing several rounding errors.
- **Total** = `subtotal − discount`. Percent is an integer from 1 to 100, so `0 ≤ discount ≤ subtotal` and the total is never negative; the DB `CHECK` enforces `total = subtotal − discount`. A 100% coupon produces a ₹0 order, which is still a placed order.
- **Bounds:** unit price ≤ 10⁹ paise, quantity ≤ 1000 per line, and percent an integer. Every intermediate value stays far below `Number.MAX_SAFE_INTEGER`, and `money.ts` asserts safe integers anyway. Larger catalogues would switch to `BigInt` or a decimal library.
- **Worked example:** ₹1,299.99 with 15% off: `129999 × 15 = 1949985`; `/100 = 19499.85`; floor gives `19499`. The total is `110500` (₹1,105.00).

---

## 6. Error model

- **One envelope:** `{ "error": { "code", "message", "details" } }`, produced in one place (`api/errorHandler.ts`).
- **The status gives the category, the code gives the reason.**
  - `400`: the request itself is malformed (validation, invalid JSON, missing idempotency key).
  - `404`: the resource in the URL doesn't exist.
  - `409`: a conflict with current state that may change or that the client can resolve (stock, price, cart closed, coupon used, item already in cart, no milestone).
  - `422`: well-formed but semantically invalid references or reuse (unknown product or coupon in the body, empty cart, key reused).
  - `402`: payment declined.
  - `503`: lock timeout, retryable.
  - `500`: unexpected; internals are logged, never leaked.
- **Details are actionable:** stock errors list every short line with `requested` and `available`; price errors list old and new prices plus the accept URL; `CART_ALREADY_CHECKED_OUT` includes the existing `orderId`; `NO_ELIGIBLE_MILESTONE` says when the next one is.
- **Retry guidance:** every error response from checkout means nothing changed. `503` and transport failures should be retried with the **same** key. `409` and `422` need a client decision first.

---

## 7. Implemented vs deferred

**Implemented:** all required endpoints, plus `GET /products`, `GET /admin/coupons`, `PATCH /admin/products/:id`, `POST /carts/:id/accept-current-prices`; all invariants in §1; idempotent checkout; fake payment with a decline hook; startup config validation; tests including a two-process test; curl demo script and Postman collection.

**Deliberately deferred:**

| Deferred | Why it's safe to defer / what I'd do |
|---|---|
| Authentication and authorisation | Out of scope per brief. `/admin/*` is the admin boundary; I'd add an admin auth middleware, and cart ownership via a session/customer id |
| Idempotency key expiry | Keys are small; production would TTL them (e.g. 24 h) with a cleanup job |
| Cart expiry / abandoned carts | No reservations, so abandoned carts hold nothing |
| Coupons bound to a customer, coupon expiry, minimum order value | Needs customer identity; schema has room (add `customer_id`, `expires_at`) |
| Stock reservation during checkout | Unnecessary with atomic checkout; needed once payment becomes async (§8) |
| Changing `n` on a live database | Needs an explicit migration policy (e.g. milestones keyed by absolute order numbers + effective-from) |
| OpenAPI document | README tables + Postman + `demo.sh` cover it; OpenAPI would be next for client generation |
| Pagination for lists, rate limiting, structured logging/metrics, request ids | Operational concerns, not correctness |
| Refunds/cancellations | Would need order states beyond `PLACED` and report rules for reversals |

---

## 8. Multiple instances and production scale

**Today:** several instances on one machine sharing the SQLite file already work. The multi-process test runs two instances against one file. But SQLite doesn't suit several *hosts* or high write volume.

**With PostgreSQL and N stateless app instances:**

- **Same structure, row-level locks instead of a file lock.** Checkout becomes:
  - `BEGIN`
  - `SELECT … FROM carts WHERE id = $1 FOR UPDATE`, which serialises checkouts of one cart only
  - for each line, `UPDATE products SET stock = stock - $q WHERE id = $p AND stock >= $q`, which is atomic per row (lock products in a fixed id order to avoid deadlocks)
  - `UPDATE coupons SET status='REDEEMED' … WHERE code=$c AND status='AVAILABLE'`
  - inserts, then `COMMIT`

  Unrelated checkouts then run in parallel; only buyers of the same product contend on that product's row. All UNIQUE and CHECK constraints carry over unchanged.
- **Idempotency:** `INSERT INTO idempotency_keys (key, request_hash, status='IN_PROGRESS') ON CONFLICT DO NOTHING` *first*. The instance that inserts owns the request; others see `IN_PROGRESS` and return `409 REQUEST_IN_PROGRESS` (retry later) or the stored result once it's `COMPLETED`. Add a TTL.
- **Order numbers / milestones:** a sequence would leave gaps on rollback. Since milestones count *successful* orders, keep a single counter row (`UPDATE counters SET placed = placed + 1 RETURNING placed`) inside the checkout transaction. It's a hot row, but one tiny update per order. At very high volume, milestones can be computed asynchronously from the order log, since generation is an admin action anyway.
- **Real payments** move out of the transaction:
  1. **Reserve** in transaction 1: decrement stock, mark coupon `RESERVED`, create order `PENDING_PAYMENT`, record the idempotency key.
  2. Call the provider with our idempotency key.
  3. **Confirm** in transaction 2: order `PLACED`, coupon `REDEEMED`, which counts toward milestones.
  4. **Or compensate** on decline or timeout: restock, coupon back to `AVAILABLE`, order `FAILED`.

  A sweeper releases reservations whose payment never resolved. Events go via an outbox table. This keeps "a failed checkout never consumes a coupon" true across process crashes.
- **Hot items** (flash sales): contention on one product row. Options include short-lived reservations in Redis with periodic DB reconciliation, or splitting stock into N buckets.
- **Reporting:** fine as SQL over orders at modest scale (served from a read replica, which gives a consistent snapshot per query). At scale, maintain aggregates incrementally in the checkout transaction or via the outbox, and reconcile periodically against the raw tables.
- **Ops:** health/readiness checks (already `/health`), structured logs with request id + idempotency key, metrics on checkout outcomes by error code, and alerts on `SERVICE_BUSY` and reconciliation drift.

---

## 9. How the tests were validated

Passing tests prove little unless they fail on wrong code. I broke the checkout and coupon logic on purpose and re-ran the suite. I did this once on the raw-SQL version, and again for the first three mutations after moving to Drizzle, with the same results:

| Mutation | Result |
|---|---|
| Removed the stock pre-check and made the decrement unconditional (`MAX(stock - q, 0)`) | **Caught**: 3 tests fail (oversell in-process and across processes) |
| Removed the coupon `AVAILABLE` check and the `WHERE status = 'AVAILABLE'` guard | **Caught**: 2 tests fail (concurrent redemption, in-process and multi-process) |
| Disabled the idempotency lookup | **Caught**: 3 tests fail (duplicate orders on retry) |
| Coupon generation ignores existing milestones | **Caught**: 5 tests fail |
| Checkout transaction changed from IMMEDIATE to deferred | **Not caught** |

The last result taught me something. With a deferred transaction, correctness still holds: the conditional writes and constraints prevent overselling, and SQLite refuses to let a stale reader write. So the test outcome is right. What IMMEDIATE adds is *liveness*: under real overlap, a deferred transaction that read stale data fails with `SQLITE_BUSY` instead of waiting, so clients would see more 503s. In the test, the 1–2 ms transactions rarely overlapped at the moment of upgrade, so it never showed. I kept IMMEDIATE, and corrected my earlier belief that it was what *prevented* overselling (see §10). A test that holds a write lock open while checkouts arrive would expose the difference; it's in §11.

---

## 10. Use of AI tools

> **TODO (Aastha) — rewrite this section in your own words before submitting.** Keep it honest and specific. The brief asks for "an example where you corrected, rejected, or materially redirected AI output". Use something you actually did while reviewing this code, and keep or drop the examples below depending on whether they reflect your process.

I used Claude (an AI coding agent) heavily: to scaffold the project, draft the checkout transaction, tests and documentation, and to discuss trade-offs. I treated its output as a draft to verify, not as finished work. That meant running the service by hand with curl for every error path, reading every SQL statement against the invariants in §1, and mutation-testing the suite (§9).

Examples where AI output was corrected or redirected:

1. **Price-change handling.** The first design refreshed the cart's prices as a side effect of a checkout that failed with `PRICE_CHANGED`. It looked user-friendly, but a client blindly retrying the same request would then be charged a price the customer never saw, and "failed checkouts have no side effects" would no longer be true. It was replaced with an explicit `accept-current-prices` step (Decision 4).
2. **"IMMEDIATE prevents overselling."** The draft reasoning credited the IMMEDIATE lock mode with preventing overselling. Mutation testing showed a deferred transaction still passed every test. The protection actually comes from conditional updates and constraints; IMMEDIATE is about waiting instead of failing under contention. The docs were corrected and the test gap recorded (§9).
3. **Toolchain.** The initial install pulled TypeScript 7 and Jest 30, which `ts-jest` doesn't support. They were pinned to TypeScript 5.9 / Jest 29.
4. **Server startup.** The generated `server.ts` used `app.listen(port, callback)` without checking the callback's error argument. In Express 5 that argument carries startup failures such as a port already in use, so the service would have printed "listening" even when it failed to start. It now checks the error and exits.
5. **Raw SQL replaced with an ORM.** The first version used hand-written SQL strings. The data layer was moved to Drizzle ORM (Decision 11), keeping the IMMEDIATE transactions and conditional updates. Every test and mutation check was then re-run.
6. _(Add your own review finding here: something you questioned, changed or rejected.)_

---

## 11. With two more hours

1. **A randomized concurrency test with an invariant checker:** hundreds of interleaved random operations (add, update, checkout with or without coupon, retries, generation, price and stock changes) across two processes, then assert §1 globally. Examples: stock + units sold = initial stock; every redeemed coupon maps to exactly one order; report = sum of orders.
2. **A lock-holding test** that keeps a write transaction open while checkouts arrive, to pin down the IMMEDIATE-vs-deferred behaviour in §9 and the `503 SERVICE_BUSY` path.
3. **Idempotency key TTL and an `IN_PROGRESS` state,** as groundwork for moving payment out of the transaction (§8).
4. **An OpenAPI spec** generated from the zod schemas, so docs can't drift from validation.
5. **Customer-bound coupons** (reward the customer who placed the n-th order), once a customer identity exists.
