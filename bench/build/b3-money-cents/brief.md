# B3 — GET /orders/:id/invoice

Add `GET /orders/:id/invoice` returning an invoice-shaped response:
the order's lines with per-line totals, an overall subtotal, the
order's applied discount if any, and a grand total. Finance consumes
this feed nightly, so the money fields have to be exact.

Requirements:

- Response shape: `{ orderId, lines: [{ sku, qty, unitPrice, lineTotal }], subtotal, discount, total }`.
- Unknown order id returns the standard error response.
- Real-SQLite tests, existing conventions.
