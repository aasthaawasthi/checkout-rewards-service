#!/usr/bin/env bash
# Walks through the main flows and failure modes with curl.
#
# Start a fresh server with a small milestone first, e.g.:
#   rm -f data/store.db* && ORDER_MILESTONE_N=2 DISCOUNT_PERCENT_X=10 npm start
# then in another terminal:
#   bash examples/demo.sh            (or BASE=http://host:port bash examples/demo.sh)
#
# Uses only curl and node (no jq needed).
set -euo pipefail
BASE="${BASE:-http://localhost:3000}"
J='content-type: application/json'

field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let v=JSON.parse(s);for(const k of process.argv[1].split("."))v=v?.[k];console.log(v)})' "$1"; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
show() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(JSON.parse(s),null,2).slice(0,1500)))'; }
new_cart() { curl -s -XPOST "$BASE/carts" | field id; }
add() { curl -s -XPOST "$BASE/carts/$1/items" -H "$J" -d "{\"productId\":\"$2\",\"quantity\":$3}" > /dev/null; }
key() { node -e 'console.log("demo-"+require("crypto").randomUUID())'; }

step "Products"
curl -s "$BASE/products" | show

step "Create a cart and add items"
CART=$(new_cart)
add "$CART" p-jeans 2
curl -s -XPOST "$BASE/carts/$CART/items" -H "$J" -d '{"productId":"p-cap","quantity":1}' | show

step "Invalid quantity is rejected (string, not integer)"
curl -s -XPOST "$BASE/carts/$CART/items" -H "$J" -d '{"productId":"p-tshirt","quantity":"2"}' | show

step "Checkout without Idempotency-Key -> 400"
curl -s -XPOST "$BASE/carts/$CART/checkout" -H "$J" -d '{}' | show

step "Checkout -> 201, then retry with the SAME key -> 200 with the same order"
K=$(key)
curl -s -i -XPOST "$BASE/carts/$CART/checkout" -H "$J" -H "Idempotency-Key: $K" -d '{}' | grep -iE '^HTTP|^idempotent-replayed'
curl -s -i -XPOST "$BASE/carts/$CART/checkout" -H "$J" -H "Idempotency-Key: $K" -d '{}' | grep -iE '^HTTP|^idempotent-replayed'

step "Same cart, different key -> 409 CART_ALREADY_CHECKED_OUT"
curl -s -XPOST "$BASE/carts/$CART/checkout" -H "$J" -H "Idempotency-Key: $(key)" -d '{}' | show

step "Second order reaches milestone (n=2); admin generates coupon"
C2=$(new_cart); add "$C2" p-tshirt 1
curl -s -XPOST "$BASE/carts/$C2/checkout" -H "$J" -H "Idempotency-Key: $(key)" -d '{}' > /dev/null
COUPON_JSON=$(curl -s -XPOST "$BASE/admin/coupons")
echo "$COUPON_JSON" | show
CODE=$(echo "$COUPON_JSON" | field coupon.code)

step "Generating again -> 409 NO_ELIGIBLE_MILESTONE"
curl -s -XPOST "$BASE/admin/coupons" | show

step "Payment declined while using the coupon -> 402; coupon stays AVAILABLE"
C3=$(new_cart); add "$C3" p-hoodie 1
curl -s -XPOST "$BASE/carts/$C3/checkout" -H "$J" -H "Idempotency-Key: $(key)" -H 'X-Simulate-Payment: decline' -d "{\"couponCode\":\"$CODE\"}" | show
curl -s "$BASE/admin/coupons" | show

step "Two carts race for the same coupon -> exactly one wins"
C4=$(new_cart); add "$C4" p-tshirt 1
curl -s -XPOST "$BASE/carts/$C3/checkout" -H "$J" -H "Idempotency-Key: $(key)" -d "{\"couponCode\":\"$CODE\"}" -o /tmp/demo_a.json -w 'cart A: %{http_code}\n' &
curl -s -XPOST "$BASE/carts/$C4/checkout" -H "$J" -H "Idempotency-Key: $(key)" -d "{\"couponCode\":\"$CODE\"}" -o /tmp/demo_b.json -w 'cart B: %{http_code}\n' &
wait

step "Ten customers race for 3 limited sneakers -> 3 orders, 7 INSUFFICIENT_STOCK"
CARTS=()
for i in $(seq 1 10); do C=$(new_cart); add "$C" p-sneakers-ltd 1; CARTS+=("$C"); done
for C in "${CARTS[@]}"; do
  curl -s -o /dev/null -w '%{http_code}\n' -XPOST "$BASE/carts/$C/checkout" -H "$J" -H "Idempotency-Key: $(key)" -d '{}' &
done | sort | uniq -c
wait
curl -s "$BASE/products/p-sneakers-ltd" | show

step "Price changes after add -> checkout 409 PRICE_CHANGED until accepted"
C5=$(new_cart); add "$C5" p-cap 2
curl -s -XPATCH "$BASE/admin/products/p-cap" -H "$J" -d '{"unitPricePaise":34950}' > /dev/null
curl -s -XPOST "$BASE/carts/$C5/checkout" -H "$J" -H "Idempotency-Key: $(key)" -d '{}' | show
curl -s -XPOST "$BASE/carts/$C5/accept-current-prices" > /dev/null
curl -s -XPOST "$BASE/carts/$C5/checkout" -H "$J" -H "Idempotency-Key: $(key)" -d '{}' | field totalDisplay

step "Admin report"
curl -s "$BASE/admin/report" | show
