# Checkout & Rewards Service

Backend for an e-commerce store: carts, checkout, and a milestone reward system in which every *n*-th successfully placed order unlocks one coupon for *x*% off.

The focus is **correct behaviour under retries and concurrency**: no overselling, no duplicate orders, no double-redeemed or lost coupons, and a report that always reconciles. The reasoning behind every choice is in **[DECISIONS.md](./DECISIONS.md)**.

- **Stack:** Node.js 22 LTS (tested on 22.23; `.nvmrc` included), TypeScript, Express 5, SQLite via **Drizzle ORM** (`drizzle-orm` + `better-sqlite3` driver, `drizzle-kit` migrations), zod, Jest + Supertest
- **No external services:** the database is a local file created and seeded on first start

---

## Quick start

Use the **latest Node 22 LTS** (`nvm use` picks it up from `.nvmrc`). On an early 22.x release (22.8 on macOS), the test run crashed with a segmentation fault, which looks like the native SQLite driver needing a newer Node.

```bash
npm install
npm run build
npm start                     # http://localhost:3000, database at data/store.db
```

Development mode (no build step): `npm run dev`

Migrations in `drizzle/` are applied automatically on startup. Other database scripts:

| Script | Does |
|---|---|
| `npm run db:migrate` | Apply pending migrations and seed products, then exit (the deploy step in production) |
| `npm run db:generate` | After editing `src/db/schema.ts`, generate a new SQL migration in `drizzle/` |
| `npm run db:studio` | Browse the database in Drizzle Studio |

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `data/store.db` | SQLite file (created on first start) |
| `ORDER_MILESTONE_N` | `5` | Every *n*-th placed order unlocks a coupon |
| `DISCOUNT_PERCENT_X` | `10` | Percent off for coupons generated from now on (integer 1–100) |

Example: `ORDER_MILESTONE_N=2 DISCOUNT_PERCENT_X=15 npm start`

To reset all data, stop the server and delete `data/store.db*`.

### Tests

```bash
npm test          # builds, then runs all tests (including the two-process test)
```

The suite includes concurrent and repeated operations, not only happy paths. See [Tests](#tests-1) below.

### Seed data

| id | name | price | stock |
|---|---|---|---|
| `p-tshirt` | Cotton T-Shirt | ₹499.00 (49900) | 100 |
| `p-jeans` | Denim Jeans | ₹1,299.99 (129999) | 50 |
| `p-hoodie` | Fleece Hoodie | ₹1,899.00 (189900) | 25 |
| `p-cap` | Baseball Cap | ₹299.50 (29950) | 200 |
| `p-sneakers-ltd` | Limited Edition Sneakers | ₹7,999.00 (799900) | **3** |
| `p-poster-signed` | Signed Poster | ₹999.00 (99900) | **1** |

---

## Conventions

- **Money** is always an integer number of **paise** (₹1 = 100 paise), in fields ending in `Paise`. `*Display` fields are formatted strings for humans only.
- **Errors** always have this shape. Clients should branch on `code`, never on `message`.

  ```json
  { "error": { "code": "INSUFFICIENT_STOCK", "message": "Not enough stock for some items",
               "details": { "items": [{ "productId": "p-sneakers-ltd", "requested": 2, "available": 1 }] } } }
  ```
- **Admin operations** are everything under `/admin/*`. Authentication is out of scope; in production that prefix sits behind admin auth.
- **Idempotency:** `POST /carts/:id/checkout` requires an `Idempotency-Key` header (8–255 chars, e.g. a UUID). Send the same key when retrying.

---

## API reference

Runnable examples are in [`examples/demo.sh`](./examples/demo.sh), and a Postman collection is in [`examples/postman_collection.json`](./examples/postman_collection.json).

### Products

| Method & path | Success | Notes |
|---|---|---|
| `GET /products` | `200 { products: [...] }` | Each product: `id, name, unitPricePaise, availableStock` |
| `GET /products/:id` | `200` | `404 PRODUCT_NOT_FOUND` |

### Carts

#### `POST /carts`, which creates an empty cart → `201`

#### `GET /carts/:cartId` → `200`

```json
{
  "id": "6f1c…", "status": "OPEN", "orderId": null, "currency": "INR",
  "items": [{
    "productId": "p-jeans", "name": "Denim Jeans", "quantity": 2,
    "unitPricePaise": 129999,        // current price: what checkout would charge
    "priceSeenPaise": 129999,        // price the customer accepted for this line
    "priceChanged": false,
    "lineTotalPaise": 259998,
    "availableStock": 50, "sufficientStock": true
  }],
  "itemCount": 2, "subtotalPaise": 259998, "subtotalDisplay": "₹2,599.98",
  "warnings": []                     // PRICE_CHANGED / INSUFFICIENT_STOCK hints while OPEN
}
```

Errors: `404 CART_NOT_FOUND`. Viewing never changes the cart.

#### `POST /carts/:cartId/items` with body `{ "productId": "p-jeans", "quantity": 2 }` → `201` (cart)

| Status | code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | quantity not an integer 1–1000 (strings like `"2"` are rejected, not coerced), missing or unknown fields |
| 404 | `CART_NOT_FOUND` | |
| 409 | `CART_NOT_OPEN` | cart already checked out |
| 409 | `ITEM_ALREADY_IN_CART` | product already in cart; use PATCH. This makes a retried "add" safe. |
| 409 | `INSUFFICIENT_STOCK` | quantity exceeds current stock (early feedback; stock is not reserved) |
| 422 | `PRODUCT_NOT_FOUND` | unknown productId |

#### `PATCH /carts/:cartId/items/:productId` with body `{ "quantity": 3 }` → `200` (cart)

Sets an absolute quantity, so repeating it is harmless. It also records the current price as accepted for that line. Errors are the same as add, plus `404 ITEM_NOT_IN_CART`.

#### `DELETE /carts/:cartId/items/:productId` → `200` (cart)

Errors: `404 CART_NOT_FOUND`, `404 ITEM_NOT_IN_CART`, `409 CART_NOT_OPEN`.

#### `POST /carts/:cartId/accept-current-prices` → `200` (cart)

After checkout returns `PRICE_CHANGED`, the customer reviews the cart and explicitly accepts the new prices. Errors: `404`, `409 CART_NOT_OPEN`.

### Checkout

#### `POST /carts/:cartId/checkout`

Headers: `Idempotency-Key: <unique per checkout attempt>`, plus optionally `X-Simulate-Payment: decline` (a demo hook for the fake payment gateway).
Body: `{ "couponCode": "REWARD-M1-7KQ2XD" }` (optional; trimmed, case-insensitive).

| Status | Meaning |
|---|---|
| **201** | Order placed. Header `Idempotent-Replayed: false`. Body = order (below). |
| **200** | Retry of an already-successful request with the same key and body. Same order returned, nothing new charged. Header `Idempotent-Replayed: true`. |

| Status | code | When | Side effects |
|---|---|---|---|
| 400 | `IDEMPOTENCY_KEY_REQUIRED` / `VALIDATION_ERROR` | header missing or invalid, bad body | none |
| 402 | `PAYMENT_DECLINED` | fake payment declined | none (stock, coupon, cart untouched) |
| 404 | `CART_NOT_FOUND` | | none |
| 409 | `CART_ALREADY_CHECKED_OUT` | cart already produced an order (`details.orderId`) | none |
| 409 | `PRICE_CHANGED` | a price changed since the customer saw it (`details.items`) | none |
| 409 | `INSUFFICIENT_STOCK` | not enough stock; **every** short line is listed in `details.items` | none |
| 409 | `COUPON_ALREADY_REDEEMED` | coupon was used by another order | none |
| 422 | `CART_EMPTY` | | none |
| 422 | `COUPON_NOT_FOUND` | unknown code | none |
| 422 | `IDEMPOTENCY_KEY_REUSED` | same key previously used for a different cart or coupon | none |
| 503 | `SERVICE_BUSY` | database lock wait exceeded 5 s; safe to retry with the same key | none |

Every failure is a full rollback. Only successful checkouts are recorded against an idempotency key, so retrying a failed attempt with the same key re-evaluates it.

### Orders

#### `GET /orders/:orderId` → `200`

```json
{
  "id": "a1b2…", "orderNumber": 7, "cartId": "6f1c…", "status": "PLACED", "currency": "INR",
  "items": [{ "productId": "p-jeans", "name": "Denim Jeans", "unitPricePaise": 129999, "quantity": 1, "lineTotalPaise": 129999 }],
  "subtotalPaise": 129999,
  "discount": { "couponCode": "REWARD-M1-7KQ2XD", "percent": 10, "amountPaise": 12999,
                "rule": "floor(subtotalPaise * percent / 100)" },
  "discountPaise": 12999,
  "totalPaise": 117000, "totalDisplay": "₹1,170.00",
  "payment": { "reference": "fakepay_…" },
  "createdAt": "…"
}
```

Orders are read only from their own snapshot, so later product changes never alter them. Errors: `404 ORDER_NOT_FOUND`.

### Admin

| Method & path | Success | Errors |
|---|---|---|
| `POST /admin/coupons` | `201 { coupon, remainingEligibleMilestones }` | `409 NO_ELIGIBLE_MILESTONE` (details: `placedOrders`, `nextMilestoneAtOrder`) |
| `GET /admin/coupons` | `200 { coupons: [...] }` | |
| `GET /admin/report` | `200` (below) | |
| `PATCH /admin/products/:id` with body `{ "unitPricePaise"?: int, "stock"?: int }` | `200` product | `400`, `404 PRODUCT_NOT_FOUND` |

**Coupon generation:** milestone *k* is reached at *k × n* placed orders. Each call creates the coupon for the earliest reached milestone that has none. Calling again after that returns `409`. If the admin falls behind, repeated calls catch up one milestone at a time.

`GET /admin/report`:

```json
{
  "currency": "INR",
  "totalOrders": 6,
  "purchasedByProduct": [{ "productId": "p-cap", "name": "Baseball Cap", "quantity": 5, "grossRevenuePaise": 149750 }],
  "totalItemsPurchased": 9,
  "grossRevenuePaise": 700000,     // sum of order subtotals (before discounts)
  "totalDiscountPaise": 12999,
  "netRevenuePaise": 687001,       // = gross - discount = sum of order totals
  "display": { "grossRevenue": "₹7,000.00", "totalDiscount": "₹129.99", "netRevenue": "₹6,870.01" },
  "ordersWithCoupon": 1,
  "coupons": { "generated": 1, "available": 0, "redeemed": 1 },
  "milestones": { "n": 5, "discountPercentForNewCoupons": 10, "reached": 1, "rewarded": 1,
                  "awaitingGeneration": 0, "nextMilestoneAtOrder": 10 }
}
```

The report is read in one consistent snapshot and never writes.

---

## Project layout

```
src/
  server.ts                 entry point (Express 5 listen with error handling, graceful shutdown)
  config.ts                 env config (n, x, port, db path), validated at startup
  db/schema.ts              Drizzle schema: tables, UNIQUE and CHECK constraints (the invariants)
  db/database.ts            connection (WAL, busy timeout), migrations, seeding
  db/migrate.ts             `npm run db:migrate` entry point
  db/seed.ts                seed catalogue
drizzle/                    generated SQL migrations (from schema.ts via drizzle-kit)
  domain/money.ts           integer-paise arithmetic and discount rounding
  domain/errors.ts          AppError + error codes
  services/cartService.ts   cart operations
  services/checkoutService.ts  the atomic checkout (read this first)
  services/couponService.ts milestone coupon generation
  services/reportService.ts admin summary
  services/orderService.ts  order read model
  services/payment.ts       payment interface + fake
  api/                      Express app, routes, request validation, error handler (the HTTP API layer)
tests/                      Jest + Supertest, including a two-process test
examples/                   demo.sh (curl walkthrough), Postman collection
```

## Tests

| File | What it protects |
|---|---|
| `checkout.test.ts` | 10 concurrent checkouts for stock 3 produce exactly 3 orders; one key retried 5× concurrently produces 1 order and 1 charge; a cart is checked out once even with different keys; a payment decline leaves no trace; a price change blocks checkout until accepted; multi-line shortages are reported and nothing is partially decremented; key reuse is rejected; order snapshot survives product changes |
| `coupons.test.ts` | milestone gating, one coupon per milestone, catch-up, concurrent generation produces 1 coupon, two checkouts racing for one coupon produce 1 redemption, coupon keeps its percent after x changes, 100% never goes negative |
| `report-and-validation.test.ts` | report reconciles with `GET /orders`; failed checkouts never appear; repeated reports don't mutate state; invalid input never enters a cart; error envelope |
| `money.test.ts` | rounding rule, non-negative totals, no fractional money |
| `multiprocess.test.ts` | **two server processes on one database file** with overlapping checkouts, retries and coupon redemptions, plus four instances starting at once on a new database. This proves the invariants come from the database, not from Node being single-threaded. |
| `startup.test.ts` | startup steps retry when they lose a lock race with another instance starting at the same moment, and nothing else is retried |

The tests were checked by deliberately breaking the code (mutation testing). Details are in DECISIONS.md.

## Time spent

About 2.5 hours of my own time over four days: directing the work, reviewing changes and testing on my machine. Most of the code was generated with Claude (see DECISIONS.md §10).
