---
id: w08-comments-dedupe
held_out: false
asks: subtle-behavior
---

POST /orders/:id/comments is retried with a *different* Idempotency-Key but the same author and body. Is a second comment created?
