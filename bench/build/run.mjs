#!/usr/bin/env node
// Runs the build comparison this repository grades: each selected task in
// each selected setup, each on a fresh clone of the corpus bundle at the
// manifest's commit.
//
//   node bench/build/run.mjs --agent 'codex exec --ignore-user-config --ephemeral --dangerously-bypass-approvals-and-sandbox --json' \
//     [--tasks b1,b3] [--setups none,curate] [--reader 'claude -p --safe-mode'] \
//     [--models models.mjs] [--curate-from ../curate] [--time-limit 1800] [--out dir]
//
// "none" gives the agent the brief alone. "curate" first asks the published
// @curatejs packages for a memory log over the clone's git history and
// markdown, and puts it above the brief under "## Context from memory". The
// agent command runs in the clone with the brief on stdin ($BRIEF_FILE names
// the same brief on disk), under a per-attempt time limit, with the
// operator's global agent-instruction files denied to it (see the README).
// Each finished tree is graded by grade.mjs; checks a script cannot settle
// go to the reader command twice, blind, and a disagreement stays "split".
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { gradeRun } from './grade.mjs';

const BENCH = fileURLToPath(new URL('.', import.meta.url));
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BUNDLE = join(ROOT, 'corpus', 'wrenfield.bundle');
const MANIFEST = join(ROOT, 'bench', 'manifest.json');

const tail = (text, lines = 30) => String(text).trim().split('\n').slice(-lines).join('\n');
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

// ---------- the clean environment ----------

// Instruction sources the documented agents load. Codex reads
// $CODEX_HOME/AGENTS.md (or AGENTS.override.md) on every call, loads
// skills, prompts, plugins, memories and hooks.json from $CODEX_HOME,
// and picks up user skills from ~/.agents/skills and /etc/codex/skills;
// ~/.codex/config.toml can name more of them, so it is denied too.
// Claude Code reads ~/.claude/CLAUDE.md as user memory plus the rules,
// skills, agents and plugins folders; settings.json and ~/.claude.json
// can carry hooks and MCP servers, so they are denied as well. Grok
// reads global rules from ~/.grok/{Agents,Claude,AGENT,AGENTS}.md and
// rules/*.md, injects ~/.grok/memory-v2/ into the prompt, loads user
// skills, agents, plugins and hooks, and through its Claude and Cursor
// compatibility reads the ~/.claude paths and ~/.cursor/{rules,
// hooks.json}. Its files are denied anyway, but the runner refuses
// grok commands: it has no flag that skips its user files and it exits
// when ~/.grok/config.toml is unreadable, so its instructions cannot
// be hidden while it still runs. A HOME swap would hide all of it but
// takes the agent's login with it, so on macOS the agent runs under
// sandbox-exec denying exactly these paths (and each realpath, for
// linked homes). The bench/ tree is denied too: the agent must not see
// the rubric or hidden tests. Auth files stay readable so the login
// works, and the denies are reads only: what an agent may write is
// governed by its own permission settings, not by the runner.
//
// A finished attempt's transcript still holds the brief, so the
// agents' session and history stores are denied to reads as well.
// file-read-data (not file-read*) is what keeps that a read deny: the
// agent can still stat and write its own state. With grok refused,
// ~/.grok/sessions is denied whole like every other store, so a
// bucket an attempt created is unreadable to every later attempt too.
const homeOf = (env) => env.HOME ?? homedir();
const codexHomeOf = (env) => (env.CODEX_HOME ? resolve(env.CODEX_HOME) : join(homeOf(env), '.codex'));
const grokHomeOf = (env) => (env.GROK_HOME ? resolve(env.GROK_HOME) : join(homeOf(env), '.grok'));

export function instructionsProfile(env = process.env) {
  const home = homeOf(env);
  const codexHome = codexHomeOf(env);
  const grokHome = grokHomeOf(env);
  const literals = new Set();
  const subpaths = new Set();
  const dataFiles = new Set();
  const dataDirs = new Set();
  const add = (set) => (path) => {
    set.add(path);
    try { set.add(realpathSync(path)); } catch { /* absent: the literal still stands */ }
  };
  [
    join(codexHome, 'AGENTS.md'), join(codexHome, 'AGENTS.override.md'),
    join(codexHome, 'hooks.json'), join(codexHome, 'config.toml'),
    join(home, '.claude', 'CLAUDE.md'), join(home, '.claude', 'CLAUDE.local.md'),
    join(home, '.claude', 'settings.json'), join(home, '.claude', 'settings.local.json'),
    join(home, '.claude.json'),
    join(grokHome, 'Agents.md'), join(grokHome, 'Claude.md'),
    join(grokHome, 'AGENT.md'), join(grokHome, 'AGENTS.md'),
    join(grokHome, 'config.toml'),
    join(home, '.cursor', 'hooks.json'),
  ].forEach(add(literals));
  [
    // codexHome/rules is exec policy (command approval), not prompt
    // instructions, and codex exits when it cannot load it
    join(codexHome, 'skills'), join(codexHome, 'memories'), join(codexHome, 'plugins'),
    join(codexHome, 'prompts'),
    join(home, '.agents', 'skills'), '/etc/codex/skills',
    join(home, '.claude', 'rules'), join(home, '.claude', 'skills'),
    join(home, '.claude', 'agents'), join(home, '.claude', 'plugins'),
    join(grokHome, 'memory'), join(grokHome, 'memory-v2'), join(grokHome, 'skills'),
    join(grokHome, 'agents'), join(grokHome, 'plugins'), join(grokHome, 'installed-plugins'),
    join(grokHome, 'hooks'), join(grokHome, 'hooks-paths'),
    join(grokHome, 'rules'),
    join(home, '.cursor', 'rules'),
    join(ROOT, 'bench'),
  ].forEach(add(subpaths));
  [
    join(home, '.claude', 'history.jsonl'),
    join(codexHome, 'history.jsonl'), join(codexHome, 'session_index.jsonl'),
    join(codexHome, 'transcription-history.jsonl'), join(codexHome, 'external_agent_session_imports.json'),
    join(grokHome, 'active_sessions.json'), join(grokHome, 'worktrees.db'), join(grokHome, 'last-copy.txt'),
  ].forEach(add(dataFiles));
  [
    join(home, '.claude', 'projects'), join(home, '.claude', 'sessions'),
    join(home, '.claude', 'todos'), join(home, '.claude', 'tasks'),
    join(home, '.claude', 'file-history'), join(home, '.claude', 'plans'),
    join(home, '.claude', 'session-env'), join(home, '.claude', 'backups'),
    join(home, '.claude', 'telemetry'), join(home, '.claude', 'debug'),
    join(home, '.claude', 'uploads'),
    join(codexHome, 'sessions'), join(codexHome, 'archived_sessions'),
    join(codexHome, 'log'), join(codexHome, 'sqlite'), join(codexHome, 'shell_snapshots'),
    join(codexHome, 'dictation-history'), join(codexHome, '.chatgpt-projects'),
    join(grokHome, 'memtrace'), join(grokHome, 'logs'), join(grokHome, 'relocations'),
    join(grokHome, 'sessions'),
  ].forEach(add(dataDirs));
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return '(version 1)\n(allow default)\n'
    + [...literals].map((p) => `(deny file-read* (literal ${JSON.stringify(p)}))`).join('\n') + '\n'
    + [...subpaths].map((p) => `(deny file-read* (subpath ${JSON.stringify(p)}))`).join('\n') + '\n'
    + [...dataFiles].map((p) => `(deny file-read-data (literal ${JSON.stringify(p)}))`).join('\n') + '\n'
    + [...dataDirs].map((p) => `(deny file-read-data (subpath ${JSON.stringify(p)}))`).join('\n') + '\n'
    + `(deny file-read-data (regex #"^${esc(codexHome)}/.*\\.sqlite"))` + '\n';
}

export function sandboxAvailable() {
  return process.platform === 'darwin'
    && spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true']).status === 0;
}

// Appends subpath read-denies (each path and its realpath) to a profile.
// The tests' '' profile, meaning no sandbox at all, stays as it is.
function denySubpaths(profile, paths) {
  if (!profile) return profile;
  const lines = [profile.trimEnd()];
  for (const p of new Set(paths.flatMap((p) => {
    try { return [p, realpathSync(p)]; } catch { return [p]; }
  }))) {
    lines.push(`(deny file-read* (subpath ${JSON.stringify(p)}))`);
  }
  return lines.join('\n') + '\n';
}

// ---------- process runner ----------

// One fresh process per call, stdin fed `input`, killed at the time limit.
// The child is spawned detached so the timer can signal the whole process
// group it started: a `sh -c` that spawns a pipeline or a `;` chain does
// not hand itself over, so signalling only the shell would leave the agent
// running with the output pipe held open and `close` would wait on it. A
// kill by the timer reports timedOut rather than a crash.
export function runShell(cmd, { cwd, env = process.env, input = '', timeoutMs = 30 * 60 * 1000, profile }) {
  const [bin, args] = profile
    ? ['/usr/bin/sandbox-exec', ['-p', profile, 'sh', '-c', cmd]]
    : ['sh', ['-c', cmd]];
  return new Promise((resolveRun, reject) => {
    const started = Date.now();
    const child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const kill = (sig) => {
      try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* already gone */ } }
    };
    let out = '', err = '', timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      kill('SIGTERM');
      setTimeout(() => kill('SIGKILL'), 5_000).unref();
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.stdin.on('error', () => { /* the command may never read stdin */ });
    child.stdin.end(input);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveRun({ code, timedOut, out, err, ms: Date.now() - started });
    });
  });
}

// ---------- curate ----------

// The packages reach the runner through a private prefix, so the
// repository holds no dependency on them. `from` is a Curate checkout
// (its packages/* install as links and must be built) or a folder of
// packed tarballs (unpacked into the prefix's node_modules, so the
// packages resolve each other without a registry); without it the
// published packages install by name.
async function installCurate(from) {
  const dir = await mkdtemp(join(tmpdir(), 'curate-pkgs-'));
  await writeFile(join(dir, 'package.json'), '{"name":"curate-run","private":true}\n');
  const tarballs = from === undefined ? [] : (await readdir(from).catch(() => []))
    .filter((f) => /^@?curatejs.*\.tgz$/.test(f)).map((f) => join(from, f));
  if (tarballs.length) {
    for (const tgz of tarballs) {
      const pkg = JSON.parse(execFileSync('tar', ['-xOf', tgz, 'package/package.json'], { encoding: 'utf8' }));
      const dest = join(dir, 'node_modules', pkg.name);
      await mkdir(dest, { recursive: true });
      execFileSync('tar', ['-xzf', tgz, '-C', dest, '--strip-components=1']);
    }
  } else {
    const specs = from === undefined
      ? ['@curatejs/core', '@curatejs/git', '@curatejs/markdown']
      : ['core', 'git', 'markdown'].map((p) => join(from, 'packages', p));
    execFileSync('npm', ['install', '--prefix', dir, '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error', ...specs]);
  }
  const require = createRequire(join(dir, 'index.cjs'));
  const load = (name) => import(pathToFileURL(require.resolve(name)).href);
  return {
    core: await load('@curatejs/core'),
    git: await load('@curatejs/git'),
    markdown: await load('@curatejs/markdown'),
    dir,
  };
}

// Package defaults end to end: git history and the handbook notes as
// knowledge, each kind's fitted cascade, and the caller's decide and
// write. The clone's rules folder is not a source: picked rules stay in
// `picked.selected` and never reach the writer or the agent's prompt.
async function curateLog({ mods, cloneDir, brief, modelsFile }) {
  const models = await import(pathToFileURL(modelsFile).href);
  if (typeof models.decide !== 'function' || typeof models.write !== 'function') {
    throw new Error('the models file must export decide and write functions');
  }
  const sources = [
    mods.git.gitHistory(cloneDir),
    mods.markdown.knowledgeBase(join(cloneDir, 'handbook')),
  ];
  const picked = await mods.core.pickFromSources(sources, { task: brief }, {
    task: brief,
    decide: models.decide,
    cascadesByKind: { 'git-history': mods.git.GIT_HISTORY_CASCADE, markdown: mods.markdown.MARKDOWN_CASCADE },
  });
  if (picked.reads.some((read) => read.status !== 'read' || !read.complete)
    || picked.record.candidates.some((item) => item.status === 'unanswered' || item.status === 'unassessed')) {
    throw new Error('curate: context collection did not finish; inspect the source and decision records.');
  }
  return (await mods.core.curate(brief, picked, { write: models.write })).log;
}

// ---------- readers ----------

// A reader sees an instruction, the check, the change and the test output,
// never the setup name, and answers "pass", "fail" or "unsure" on its last
// line. Two calls, same payload; agreement on pass or fail settles the
// check, a disagreement stays split, and an unsure or unreadable reply
// leaves it needs-reader.
async function readerVerdicts(readerCmd, payload, ctx) {
  // each call starts in a fresh empty folder outside the run's own trees,
  // which the reader profile denies: a clean working directory only
  const call = async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'wrenfield-reader-'));
    try {
      return await runShell(readerCmd, {
        cwd, env: ctx.env, input: JSON.stringify(payload), timeoutMs: ctx.timeoutMs, profile: ctx.profile,
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  };
  const verdictOf = (res) => {
    const last = res.out.trim().split('\n').at(-1)?.toLowerCase();
    return (res.code === 0 && !res.timedOut && ['pass', 'fail', 'unsure'].includes(last)) ? last : null;
  };
  const [a, b] = [verdictOf(await call()), verdictOf(await call())];
  // an unsure or unreadable answer cannot settle the check; only a
  // pass against a fail records "split", everything else stays open
  const final = a && b && a !== 'unsure' && b !== 'unsure' ? (a === b ? a : 'split') : 'needs-reader';
  return { verdicts: [a, b], final };
}

// A failed blocker gates to 0; a check nobody decided (needs-reader, or a
// split the readers could not settle) leaves the score pending.
const scoreOf = (grade) =>
  grade.blockers.some((b) => b.verdict === 'fail') ? 0
    : [...grade.blockers, ...grade.quality].some((c) => c.verdict === 'needs-reader' || c.verdict === 'split') ? null
    : grade.quality.length ? grade.quality.filter((q) => q.verdict === 'pass').length / grade.quality.length : null;

// ---------- one attempt ----------

async function attempt({ task, taskDir, setup, brief, opts, workDir, runDir, deps }) {
  // the clone, the grader's report folder and $BRIEF_FILE all live in a
  // randomly named attempt folder: the grader echoes those paths into the
  // hidden-test log, the log reaches the reader, and a folder named
  // <task>-<setup> would tell the reader which setup built the change.
  // The published folder keeps the <task>-<setup> name.
  const attemptDir = await mkdtemp(join(workDir, 'attempt-'));
  const cloneDir = join(attemptDir, 'clone');
  const gradeDir = join(attemptDir, 'grade');
  await mkdir(gradeDir, { recursive: true });
  const outDir = join(runDir, `${task}-${setup}`);
  await mkdir(outDir, { recursive: true });
  const record = { task, setup, dir: `${task}-${setup}` };
  try {
    await deps.clone(cloneDir);
    await deps.install(cloneDir);
    const base = git(cloneDir, 'rev-parse', 'HEAD').trim();
    let prompt = brief;
    if (setup === 'curate') {
      const log = await deps.curate({ cloneDir, brief });
      await writeFile(join(outDir, 'curate.log'), log);
      prompt = `## Context from memory\n\n${log}\n\n${brief}`;
    }
    // $BRIEF_FILE sits outside this repository: next to the results tree
    // it would invite the agent to read the rubric and hidden tests
    const briefPath = join(attemptDir, 'brief.md');
    await writeFile(briefPath, prompt);
    await writeFile(join(outDir, 'brief.md'), prompt);
    const agent = await deps.agent(opts.agent, {
      cwd: cloneDir, input: prompt,
      env: { ...deps.env, BRIEF_FILE: briefPath },
      timeoutMs: opts.timeLimitMs, profile: deps.profile,
    });
    // cost and time land only when the agent prints them: JSONL events with
    // a usage object (codex --json's turn.completed, claude -p --output-format
    // json) are collected, along with the cost and duration fields those
    // reports carry; ms is always the runner's own clock
    const events = agent.out.split('\n')
      .map((line) => { try { return JSON.parse(line); } catch { return undefined; } })
      .filter((e) => e !== null && typeof e === 'object');
    const usage = events.map((e) => e.usage).filter((u) => u !== undefined);
    const costUsd = events.map((e) => e.total_cost_usd ?? e.cost_usd ?? e.cost).filter((v) => typeof v === 'number').at(-1);
    const durationMs = events.map((e) => e.duration_ms).filter((v) => typeof v === 'number').at(-1);
    record.agent = { code: agent.code, ms: agent.ms,
      ...(usage.length ? { usage } : {}),
      ...(costUsd !== undefined ? { total_cost_usd: costUsd } : {}),
      ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
      ...(agent.timedOut ? { timedOut: true } : {}) };
    await writeFile(join(outDir, 'agent.stdout'), agent.out);
    await writeFile(join(outDir, 'agent.stderr'), agent.err);
    if (agent.timedOut) {
      record.status = 'timeout';
      record.error = `agent exceeded the ${opts.timeLimitMs / 1000}s limit`;
      return record;
    }
    if (agent.code !== 0) {
      record.status = 'agent-failed';
      record.error = `agent exited ${agent.code}`;
      return record;
    }
    // the agent may commit its work: put HEAD back on the commit the run
    // started from, tree and index untouched, so the grader's added-lines
    // scan and the reader's diff measure all of it
    git(cloneDir, 'reset', '--soft', base);
    const rubric = await readJson(join(taskDir, 'rubric.json'));
    const grade = await deps.grade({ copyDir: cloneDir, taskDir, rubric, runDir: gradeDir });
    for (const f of ['hidden-tests.log', 'hidden-tests.json']) {
      if (existsSync(join(gradeDir, f))) await copyFile(join(gradeDir, f), join(outDir, f));
    }
    // intent-to-add so the reader's diff shows new files; index only, the
    // tree the grader already measured is untouched
    git(cloneDir, 'add', '-N', '.');
    const diff = git(cloneDir, 'diff', 'HEAD');
    const testLog = existsSync(join(outDir, 'hidden-tests.log'))
      ? tail(readFileSync(join(outDir, 'hidden-tests.log'), 'utf8'), 120) : '';
    await writeFile(join(outDir, 'change.patch'), diff);
    // the attempt folder is spent: the payload and outDir hold everything
    // left. Remove it before the readers launch: the hidden-test log
    // echoes the clone's absolute path, and the brief beside it on disk
    // reveals the setup. The reader profile denies this folder's parent
    // and the output root too, so even a surviving copy stays closed.
    await rm(attemptDir, { recursive: true, force: true });
    const rubricChecks = [...rubric.blockers, ...rubric.quality];
    const readers = {};
    for (const check of [...grade.blockers, ...grade.quality]) {
      if (check.verdict !== 'needs-reader') continue;
      if (!opts.reader) continue;
      // the grader returns only {id, verdict} for a reader check; the
      // check's text and reason come from the rubric
      const source = rubricChecks.find((c) => c.id === check.id) ?? {};
      const payload = {
        instruction: 'You are judging one check on a code change: "check" names it and why it matters, "diff" is the change, "testOutput" is the tail of the test log. Decide whether the change satisfies the check, explain briefly, then end your reply with a verdict line: the last line is exactly "pass", "fail" or "unsure".',
        task,
        check: { id: check.id, check: source.check ?? check.check, ...(source.why ?? check.why ? { why: source.why ?? check.why } : {}) },
        diff,
        testOutput: testLog,
      };
      readers[check.id] = await readerVerdicts(opts.reader, payload, { env: deps.env, timeoutMs: opts.timeLimitMs, profile: deps.readerProfile });
      check.verdict = readers[check.id].final;
      check.readers = readers[check.id].verdicts;
    }
    // the grade's own score and needsReader list were computed before
    // the readers answered; restate both so the file and the summary agree
    grade.score = scoreOf(grade);
    grade.needsReader = [...grade.blockers, ...grade.quality]
      .filter((c) => c.verdict === 'needs-reader').map((c) => c.id);
    await writeFile(join(outDir, 'grade.json'), JSON.stringify(grade, null, 2));
    record.status = 'graded';
    record.grade = grade;
    record.score = grade.score;
  } catch (error) {
    record.status = 'failed';
    record.error = String(error?.message ?? error);
  } finally {
    // the clone (with its node_modules) lives only as long as its attempt
    await rm(attemptDir, { recursive: true, force: true });
  }
  return record;
}

// ---------- the run ----------

export async function runBench(opts, deps = {}) {
  opts.timeLimitMs ??= 30 * 60 * 1000;
  // each documented agent leaves its user's customizations out only
  // through its own flag: claude --safe-mode skips all of them, codex
  // --ignore-user-config skips the config.toml that can wire more in
  // (the profile denies the rest). Grok has no such flag and exits
  // when its config is unreadable, so it is refused outright (see the
  // README).
  for (const cmd of [opts.agent, opts.reader]) {
    if (!cmd) continue;
    if (/\bgrok\b/.test(cmd))
      throw new Error('grok cannot run with your global instruction files hidden and stay logged in, so this runner does not support it; see bench/build/README.md');
    if (/\bclaude\b/.test(cmd) && !cmd.includes('--safe-mode'))
      throw new Error('claude loads your global customizations unless its command passes --safe-mode');
    if (/\bcodex\b/.test(cmd) && !cmd.includes('--ignore-user-config'))
      throw new Error('codex loads your $CODEX_HOME/config.toml unless its command passes --ignore-user-config');
  }
  const runDeps = {
    env: deps.env ?? process.env,
    clone: deps.clone ?? (async (dir) => {
      execFileSync('git', ['clone', '--quiet', BUNDLE, dir]);
      git(dir, 'checkout', '--quiet', '--detach', JSON.parse(readFileSync(MANIFEST, 'utf8')).repo_rev);
    }),
    install: deps.install ?? ((dir) => execFileSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'ignore' })),
    agent: deps.agent ?? runShell,
    grade: deps.grade ?? gradeRun,
    curate: deps.curate,
    profile: deps.profile !== undefined ? deps.profile : (sandboxAvailable() ? instructionsProfile(deps.env ?? process.env) : null),
  };
  if (runDeps.profile === null) {
    throw new Error('refusing to run: this host cannot hide your global agent-instruction files (sandbox-exec is unavailable); see bench/build/README.md');
  }
  const known = (await readdir(BENCH)).filter((t) => existsSync(join(BENCH, t, 'rubric.json')));
  const tasks = opts.tasks ?? known;
  for (const t of tasks) {
    const match = known.find((k) => k === t || k.startsWith(`${t}-`));
    if (!match) throw new Error(`no build task ${t}`);
    if (match !== t) tasks[tasks.indexOf(t)] = match;
  }
  const setups = opts.setups ?? ['none', 'curate'];
  for (const s of setups) if (!['none', 'curate'].includes(s)) throw new Error(`no setup ${s}`);
  const mods = setups.includes('curate') && !runDeps.curate
    ? await installCurate(opts.curateFrom)
    : undefined;
  if (setups.includes('curate') && !runDeps.curate) {
    if (!opts.models) throw new Error('the curate setup needs --models <file> exporting decide and write');
    runDeps.curate = ({ cloneDir, brief }) => curateLog({ mods, cloneDir, brief, modelsFile: opts.models });
  }
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const outRoot = resolve(opts.out ?? join(BENCH, 'results'));
  const runDir = join(outRoot, runId);
  const workDir = await mkdtemp(join(tmpdir(), 'wrenfield-run-'));
  // The output root keeps every attempt's labelled folder, its brief and
  // its curate log on disk. It is denied to the agent (a later "none" run
  // must not read an earlier "curate" log) and to the reader; the reader
  // is denied the work folder too, so even an attempt folder that
  // survived its cleanup could not be read.
  await mkdir(outRoot, { recursive: true });
  runDeps.profile = denySubpaths(runDeps.profile, [outRoot]);
  runDeps.readerProfile = denySubpaths(runDeps.profile, [workDir]);
  const summary = { run: runId, agent: opts.agent, ...(opts.reader ? { reader: opts.reader } : {}),
    instructionsHidden: Boolean(runDeps.profile), tasks: {} };
  try {
    await mkdir(runDir, { recursive: true });
    for (const task of tasks) {
      const taskDir = join(BENCH, task);
      const brief = await readFile(join(taskDir, 'brief.md'), 'utf8');
      summary.tasks[task] = {};
      for (const setup of setups) {
        const record = await attempt({ task, taskDir, setup, brief, opts, workDir, runDir, deps: runDeps });
        summary.tasks[task][setup] = record;
        console.error(`${task}/${setup}: ${record.status}${record.score === undefined ? '' : ` score=${record.score}`}`);
      }
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
    if (mods) await rm(mods.dir, { recursive: true, force: true });
  }
  await writeFile(join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
  return summary;
}

// ---------- entry ----------

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const opts = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const take = () => argv[++i];
    switch (argv[i]) {
      case '--tasks': opts.tasks = take().split(','); break;
      case '--setups': opts.setups = take().split(','); break;
      case '--agent': opts.agent = take(); break;
      case '--reader': opts.reader = take(); break;
      case '--models': opts.models = resolve(take()); break;
      case '--curate-from': opts.curateFrom = resolve(take()); break;
      case '--time-limit': opts.timeLimitMs = Number(take()) * 1000; break;
      case '--out': opts.out = resolve(take()); break;
      default: throw new Error(`unknown argument ${argv[i]}`);
    }
  }
  if (!opts.agent) throw new Error('pass --agent <command>, the agent to run on each clone');
  opts.timeLimitMs ??= 30 * 60 * 1000;
  const summary = await runBench(opts);
  console.log(JSON.stringify(summary, null, 2));
  console.error(`results: ${join(opts.out ?? join(BENCH, 'results'), summary.run)}`);
}
