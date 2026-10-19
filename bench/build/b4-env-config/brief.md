# B4 — slow-request logging knob

Ops wants a knob: requests slower than a configurable threshold should
log a `slow request` warning. Add an env var `SLOW_MS` (integer,
default 500) and warn in the request-logging middleware when a request
exceeds it.

Requirements:

- `SLOW_MS` configurable via environment, documented alongside the
  existing env vars.
- Warn carries the request's route and elapsed ms through the existing
  structured logger.
- Tests cover at least the config side (env parsing).
