# B6 — DELETE /products/:sku

Add `DELETE /products/:sku`. Products get discontinued but must stay
traceable — old orders reference them, and ops occasionally asks "was
this product ever real?". Deleting a product must not break
`GET /orders/:id` responses or lose the row.

Requirements:

- Deleted products disappear from `GET /products` and
  `GET /products/:sku` (the API's not-found behavior).
- Order responses referencing the product keep working.
- Deleting an already-deleted or unknown product returns the standard
  error response.
- Real-SQLite tests, existing conventions.
