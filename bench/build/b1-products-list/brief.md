# B1 — GET /products list endpoint

orders-api currently exposes `GET /products` returning every row, which
is getting slow. Convert it to a paginated list matching how the rest
of the API paginates, and keep `GET /products/:sku` working untouched.

Requirements:

- `GET /products` supports a `limit` query param with a sensible cap.
- It returns a paginated response in the same shape other list
  endpoints use.
- Sorting by `price_cents` or `name` via a `sort` param.
- Tests must hit real SQLite (existing convention).

Do not touch the orders or customers routers.
