# B2 — POST /orders/:id/refunds

orders-api needs a refunds endpoint: `POST /orders/:id/refunds` records
a refund against an order (`amount` in the request body), so support
can replay partial refunds without touching the order itself.

Requirements:

- Each refund is a row: id, order id, amount, created timestamp.
- `GET /orders/:id/refunds` lists them, newest first.
- Retrying the same request must not record the refund twice — the
  service's clients retry aggressively.
- A refund on a non-existent or cancelled order must fail cleanly.
- Real-SQLite tests, existing conventions.
