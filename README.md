# Wrenfield

A test for engineering memory: can an agent find and use what a team
recorded in its git history, handbook and rules?

Wrenfield is a synthetic company repository for a small orders service
(TypeScript, Express, SQLite). It has 345 commits by four fictional
engineers, 147 handbook notes (some stale on purpose), 40 one-rule files
and 28 source files. Decisions get reversed, notes go stale, and a bug
ships twice. The benchmark asks questions and sets build tasks whose
right answers depend on that record.

## What is in this repository

```text
corpus/wrenfield.bundle     the corpus: a git bundle with its full history
bench/
  manifest.json             corpus commit, held-out list, rules for a harness
  tasks/<id>.md             40 question tasks
  gold/<id>.json            expected answer, gold commits and files, the check
  answer-fixtures.json      right and deliberately reversed answers
  check.mjs                 dataset self-check
  check-answers.mjs         proves the checks pass right answers and fail reversed ones
  score-answers.mjs         scores a file of answers
  lib/score.mjs             the scoring function
  build/                    6 build tasks, the grader and its tests
```

### Why the corpus is a bundle

The corpus's commit history is test data. Gold items cite commits by
their IDs, so the history must arrive exactly as written. A git bundle
is one file that carries every commit with its original ID, and `git
clone` reads it directly. A script that rebuilt the history would need
to reproduce every author, date and tree byte for byte to keep the IDs.

## Quick start

Needs Node.js 22 or later and git.

```bash
npm install
npm run corpus     # clones corpus/wrenfield.bundle into corpus/wrenfield
npm run check      # dataset self-check and answer-check fixtures
npm test           # build grader tests (no network, no model calls)
```

## Question tasks

40 questions a careful engineer answers from the repository, not from
general knowledge. 30 are open; the 10 listed in `bench/manifest.json`
under `held_out` are for final scoring only. Never tune on them.

Each `gold/<id>.json` holds:

- **`expected`**: a reference answer.
- **`gold`**: the commits and files a careful engineer reads first.
- **`check`**: how an answer passes.
  - `must_mention`: every group needs at least one matching pattern
    (case-insensitive).
  - `forbid_mention`: no pattern may match. Trap tasks use this to
    reject the reversed claim, for example "deploy.md is current".
  - `cite_path`: the answer must cite a matching path that exists in
    the corpus.
  - `cite_commit`: the answer must cite a matching commit ID that
    resolves in the corpus.

No language model judges an answer. To score a run, write a JSON file
that maps each task ID to the answer text:

```json
{
  "w01-deploy": "Deploys run docker ... (commit 53e9d62)",
  "w02-order-states": "..."
}
```

```bash
node bench/score-answers.mjs answers.json
```

It prints a verdict per task and the totals for open and held-out tasks.
`lib/score.mjs` also reports which gold items reached the context, if
your harness passes the delivered items.

### Rules for a harness

- **Hide `bench/` from the agent.** This repository holds the answers.
  Give the agent only the corpus clone.
- **Pin the corpus to `8ec324a`**, the `repo_rev` in the manifest.
- **Report open and held-out scores apart.** With 10 held-out tasks, one
  task moves the held-out score by 10 points.

## Build tasks

Six briefs whose right answer depends on a recorded decision. Hidden
tests and a rubric grade each build. See
[`bench/build/README.md`](bench/build/README.md).

