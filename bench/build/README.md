# Build tasks

Six build briefs on the Wrenfield corpus. Each brief's right answer
depends on a recorded decision or a replaced note. A builder that does
not read the repository's history and handbook picks the plausible
wrong path.

## The six

| Task | Decision it encodes | The wrong path |
|------|--------------------|----------------|
| `b1-products-list` | cursor pagination (rules 19, 20, 21) | offset, the replaced convention |
| `b2-mutation-idempotency` | `Idempotency-Key` on mutations (rule 18) | plain POST; a retry applies twice |
| `b3-money-cents` | integer cents (rule 01) | floats, the reversed decision |
| `b4-env-config` | environment read through `src/config.ts` (rule 30) | `process.env` inline in middleware |
| `b5-error-surface` | `AppError` and `{error, message}` (rules 12, 16, 17) | ad-hoc `res.status().json()` |
| `b6-soft-delete` | `deleted_at` tombstone (rule 24) | `DELETE FROM`; the row is gone |

Each task folder holds:

- **`brief.md`**: what the builder is given.
- **`hidden.test.ts`**: tests that start the built app (`node dist/index.js`
  with `PORT` and `DB_FILE`) and check the live contract. Never show
  this file to the builder.
- **`rubric.json`**: blockers and quality checks.

## How a build is graded

- **Blockers gate to 0.** A failed hidden test, a broken rule or a
  missing contract scores the build 0, whatever else it did.
- **Quality checks add.** The score is the share of quality checks that
  pass.
- **A check that names a `grep`** is run by the grader over the lines the
  build added (moved lines and test files do not count).
- **A check "asserted by hidden tests"** takes the verdict of the one
  hidden test it names.
- **Any other check reads `needs-reader`.** A person reads the change and
  decides it. Until then the score is pending (`null`), unless a blocker
  has already failed.

```bash
# grade a patch made against the corpus at 8ec324a
node bench/build/grade.mjs --task b3 --patch change.patch

# grade a working tree you built yourself (HEAD at 8ec324a, change uncommitted)
node bench/build/grade.mjs --task b3 --copy path/to/build
```

Build from the corpus clone at `8ec324a`, never from this repository:
the builder must not see `bench/`.
