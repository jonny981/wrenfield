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

## Running the comparison

`run.mjs` builds each task twice: once with no memory (`none`), once with
Curate's context above the brief (`curate`). Every attempt gets a fresh
clone of the corpus bundle at the pinned commit and one run of your agent
command in a fresh process.

```bash
node bench/build/run.mjs \
  --agent 'codex exec --ignore-user-config --ephemeral --dangerously-bypass-approvals-and-sandbox --json' \
  --reader 'claude -p --safe-mode' \
  --models models.mjs \
  --curate-from ../curate
```

- **`--tasks b1,b3`** picks tasks; the default is all six.
- **`--setups none,curate`** picks setups; the default is both.
- **`--agent <cmd>`** is required. It runs as `sh -c` in the clone, with
  the brief on stdin. `$BRIEF_FILE` names the same brief on disk, in a
  temporary folder outside this repository, for agents that want a file.
  Give the agent its JSON flag (`codex --json`,
  `claude -p --output-format json --safe-mode`) so token usage, cost and
  duration reach the summary.
- **`--time-limit <seconds>`** caps each attempt (default 1800). A
  timed-out attempt is recorded with status `timeout`, and the run
  continues.
- **`--reader <cmd>`** answers the checks no script can settle. Its
  stdin is a JSON payload whose `instruction` field tells it what to
  judge and how to answer, so a plain `claude -p --safe-mode` works.
  Without it, those checks stay `needs-reader`.
- **`--models <file>`** is required by the `curate` setup. It is a small
  module exporting the two model functions Curate needs, `decide` and
  `write`. Curate's README gives copy-paste recipes under
  [Bring your own models](https://github.com/jonny981/curate#bring-your-own-models).
  The runner holds no keys; your file reads its own environment.
- **`--curate-from <path>`** installs `@curatejs/core`, `@curatejs/git`
  and `@curatejs/markdown` from a Curate checkout (build it first) or a
  folder of packed tarballs. Without it the runner installs the
  published packages.
- **`--out <dir>`** changes the output root (default
  `bench/build/results/`).

The `curate` setup calls `pickFromSources` over the clone's
`gitHistory` and `knowledgeBase('handbook')` sources with each kind's
fitted cascade, then `curate()`, all at the package defaults. The
clone's `rules/` folder is not a source: rules Curate selects stay in
`picked.selected` as exact text and never reach the writer or the
agent's prompt, so asking the decide model about them would spend calls
for nothing the run uses. The returned log sits above the brief under
`## Context from memory`.

### Keeping your own agent instructions out

The agent must not see your global instruction files, and a finished
attempt's transcript still holds its brief, so it must not read the
agents' old session and history stores either. Swapping `HOME` hides
all of it but takes the agent's login with it, so the runner uses two
mechanisms instead:

1. **The agent's own skip flag.** Each documented command carries the
   flag that leaves your user config out while the login still works,
   and the runner refuses a `claude` or `codex` command without it:
   `--safe-mode` for `claude`, `--ignore-user-config` for `codex`.
   Grok has no such flag, so the runner refuses `grok` commands
   outright.
2. **A `sandbox-exec` profile** (`allow default` minus named read
   denies) wraps the agent and the reader on macOS. Where
   `sandbox-exec` does not run, the runner refuses to start: a warning
   would let the agent read your instructions with nothing to stop it.

The denies are reads only. What an agent may write, its own session
and state files included, is governed by that agent's own permission
settings, not by the runner. Auth files, the settings a login needs,
and the clone's own instruction files stay readable.

#### What each agent reads, and what the profile denies

- **Claude Code** reads `~/.claude/CLAUDE.md` as user memory plus the
  `rules/`, `skills/`, `agents/` and `plugins/` folders under
  `~/.claude`, per its
  [memory docs](https://docs.claude.com/en/docs/claude-code/memory).
  `--safe-mode` disables every customization (CLAUDE.md, hooks, skills,
  plugins, MCP servers) while authentication, model selection and
  permissions keep working, per its
  [CLI reference](https://docs.claude.com/en/docs/claude-code/cli-reference).
  `~/.claude/settings.json`, `settings.local.json` and `~/.claude.json`
  can carry hooks and MCP servers of their own, so the profile denies
  them too; under `--safe-mode` claude only warns that they failed to
  load.
- **Codex** reads `$CODEX_HOME/AGENTS.md` or `AGENTS.override.md` on
  every call, loads `skills/`, `prompts/`, `plugins/`, `memories/` and
  `hooks.json` from `$CODEX_HOME`, and merges `~/.agents/skills`
  (USER) and `/etc/codex/skills` (ADMIN), per its
  [AGENTS.md guide](https://developers.openai.com/codex/guides/agents-md)
  and
  [skills docs](https://developers.openai.com/codex/skills). The
  profile denies every one of those paths, and the deny is what does
  the work: under the documented command codex still tries
  `AGENTS.md` at startup, logs the refused read on stderr, and runs
  on. The runner also requires `--ignore-user-config`, which
  `codex exec --help` describes as "Do not load
  `$CODEX_HOME/config.toml`; auth still uses `CODEX_HOME`". The flag
  matters because that one file is how codex enables skills and wires
  MCP servers, a surface no path list can enumerate; the profile
  denies the file itself as a backstop. `--ephemeral` writes no
  session files; the examples carry it. `$CODEX_HOME/rules/` stays
  readable: it holds exec-policy (command approval) files, not prompt
  instructions, and `codex exec` exits when it cannot load them.
- **Grok is unsupported.** It reads global rules from
  `~/.grok/{Agents,Claude,AGENT,AGENTS}.md` and `rules/*.md`, injects
  `~/.grok/memory/` and `memory-v2/` into the prompt, loads `skills/`,
  `agents/`, `plugins/`, `installed-plugins/`, `hooks/` and
  `hooks-paths/`, and through its Claude and Cursor compatibility
  reads the `~/.claude` folders above plus `~/.cursor/rules` and
  `~/.cursor/hooks.json`, per its
  [repository](https://github.com/xai-org/grok-build) and
  [docs](https://docs.x.ai/build/overview). Grok offers no flag that
  skips these files, and it exits when `~/.grok/config.toml` is
  unreadable, so there is no way to hide its instructions while it
  still runs. The runner refuses a `grok` command outright; the
  profile still denies its files, so no other agent can be pointed at
  them either.
- **Session and history stores.** Denied for reading
  (`file-read-data`, which leaves stats and writes alone): `~/.claude`
  `projects/`, `sessions/`, `todos/`, `tasks/`, `file-history/`,
  `plans/`, `session-env/`, `backups/`, `telemetry/`, `debug/`,
  `uploads/` and `history.jsonl`; `$CODEX_HOME` `sessions/`,
  `archived_sessions/`, `log/`, `sqlite/`, `shell_snapshots/`,
  `dictation-history/`, `.chatgpt-projects/`, `*.sqlite` and its
  `history.jsonl`, `session_index.jsonl`,
  `transcription-history.jsonl` and
  `external_agent_session_imports.json`; `~/.grok` `memtrace/`,
  `logs/`, `relocations/`, `sessions/`, `active_sessions.json`,
  `worktrees.db` and `last-copy.txt`. No supported agent needs a
  session store open, so each store is denied whole: a folder an
  attempt creates there is unreadable to every later attempt too.
- This repository's `bench/` tree, so the agent cannot read the rubric
  or the hidden tests.
- The output root, wherever `--out` points. Its `<task>-<setup>`
  folders, briefs and Curate logs name the setup that produced them, so
  a later `none` attempt must not read an earlier `curate` attempt's
  files and a reader must not see either. The reader is also denied the
  run's temporary work folder the attempts ran in.

The canary test in `run.test.mjs` proves a file under a fake home is
readable without the runner and unreadable through it, and that a fake
agent can still write its own session file where neither a fake reader
nor the next attempt's agent can read it.

### The reader

A `needs-reader` check goes to `--reader` twice. Each call runs in a
fresh empty folder, which only gives the reader a clean working
directory. The reader sees a JSON payload on stdin:
`{instruction, task, check: {id, check, why}, diff, testOutput}`. The
`instruction` tells it to judge that one check against the diff and the
test output, and to end its reply with a verdict line: the last line is
`pass`, `fail` or `unsure`. `testOutput` is the tail of the hidden-test
log. That log echoes the clone's absolute path, so the attempt's whole
working folder (clone, grade output and the brief on disk) is deleted
before the readers launch. A reader that follows the path finds it
gone, and the random folder names mean the echo carries no setup name
either. The reader never sees which setup produced the change. Two
agreeing `pass` or `fail` answers settle the check; a `pass` against a
`fail` is recorded `split` and never guessed. An `unsure` answer or a
reply that cannot be read leaves the check `needs-reader`.

### Reading the results

One `bench/build/results/<run-id>/` folder per run:

- **`summary.json`** holds, per task and setup: `status`, `score`
  (`null` while a check is undecided or split, `0` on a failed blocker,
  otherwise the share of quality checks passed), the grade's check
  verdicts, the two reader answers under `readers`, and the agent's exit
  code and milliseconds (plus reported token `usage`, `total_cost_usd`
  and `duration_ms` when the agent prints them). `status` is `graded`
  when the agent finished and the tree was graded, `timeout` when the
  agent hit the time limit, `agent-failed` on a nonzero exit, and
  `failed` when the runner itself errored (for example a Curate or
  grader exception).
- **`<task>-<setup>/`** per attempt holds `brief.md` as sent,
  `curate.log` for the curate setup, `agent.stdout`/`agent.stderr`,
  `change.patch` (the diff readers saw), `grade.json` and the grader's
  `hidden-tests.log`.
