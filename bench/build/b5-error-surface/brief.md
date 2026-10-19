# B5 — proper client error for unknown customer

`POST /orders` with an unknown `customerId` currently blows up — the
response is a 500 with whatever sqlite said. Support sees this
constantly. Return a proper client error instead, consistent with how
the rest of the API reports failures.

Requirements:

- `POST /orders` with an unknown customer id returns a 4xx, not a 500.
- The error body matches the API's standard error shape.
- A validation error on the body still behaves exactly as today.
- Real-SQLite tests, existing conventions.
