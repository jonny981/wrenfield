// Tests for the build runner. A fake agent and a fake reader run as real
// processes; no model is called. The corpus clones for real (local bundle)
// but the dependency install and the grader are stubbed.
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBench, instructionsProfile } from './run.mjs';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const tmpDirs = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'run-test-')); tmpDirs.push(d); return d; };

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

// The fake agent saves its stdin (the brief), what it could read of the
// "global instruction" files (one per denied path, transcript stores
// included), and whether the tree already held its marker. With
// TRANSCRIPT_PATH set it also saves its prompt there, the way a real
// agent keeps its own session file; with TRANSCRIPT_DIR it files the
// prompt in a fresh bucket and reports whether the previous attempt's
// bucket was readable.
const FAKE_AGENT = `import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const cap = process.env.FAKE_CAPTURE;
const home = process.env.HOME;
const codexHome = process.env.CODEX_HOME ?? join(home, '.codex');
const CANARY_PATHS = [
  join(codexHome, 'AGENTS.md'), join(codexHome, 'AGENTS.override.md'),
  join(codexHome, 'config.toml'), join(codexHome, 'hooks.json'),
  join(codexHome, 'skills', 'canary.md'), join(codexHome, 'memories', 'canary.md'),
  join(codexHome, 'plugins', 'canary.md'), join(codexHome, 'prompts', 'canary.md'),
  join(home, '.agents', 'skills', 'canary.md'),
  join(home, '.claude', 'CLAUDE.md'), join(home, '.claude', 'CLAUDE.local.md'),
  join(home, '.claude', 'settings.json'), join(home, '.claude', 'settings.local.json'),
  join(home, '.claude', 'rules', 'canary.md'), join(home, '.claude', 'skills', 'canary.md'),
  join(home, '.claude', 'agents', 'canary.md'), join(home, '.claude', 'plugins', 'canary.md'),
  join(home, '.claude.json'),
  join(home, '.grok', 'Agents.md'), join(home, '.grok', 'Claude.md'),
  join(home, '.grok', 'AGENT.md'), join(home, '.grok', 'AGENTS.md'),
  join(home, '.grok', 'config.toml'), join(home, '.grok', 'rules', 'canary.md'),
  join(home, '.grok', 'memory', 'canary.md'), join(home, '.grok', 'memory-v2', 'canary.md'),
  join(home, '.grok', 'skills', 'canary.md'), join(home, '.grok', 'agents', 'canary.md'),
  join(home, '.grok', 'plugins', 'canary.md'), join(home, '.grok', 'installed-plugins', 'canary.md'),
  join(home, '.grok', 'hooks', 'canary.md'), join(home, '.grok', 'hooks-paths', 'canary.md'),
  join(home, '.cursor', 'hooks.json'), join(home, '.cursor', 'rules', 'canary.mdc'),
  join(home, '.claude', 'projects', 'canary.jsonl'), join(home, '.claude', 'sessions', 'canary.json'),
  join(home, '.claude', 'history.jsonl'),
  join(codexHome, 'sessions', 'canary.jsonl'), join(codexHome, 'history.jsonl'),
  join(home, '.grok', 'memtrace', 'canary'), join(home, '.grok', 'logs', 'canary'),
  join(home, '.grok', 'sessions', 'fakewd', 'fakeid', 'canary.jsonl'),
];
let stdin = '';
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => {
  const n = readdirSync(cap).filter((f) => f.startsWith('brief-')).length;
  writeFileSync(join(cap, 'brief-' + n + '.md'), stdin);
  const found = [];
  for (const p of CANARY_PATHS) {
    try { found.push(readFileSync(p, 'utf8')); } catch (e) { found.push('UNREADABLE ' + p + ' ' + e.code); }
  }
  writeFileSync(join(cap, 'canary-' + n + '.txt'), found.join('\\n'));
  writeFileSync(join(cap, 'tree-' + n + '.txt'), existsSync('AGENT-MARKER') ? 'STALE' : 'FRESH');
  writeFileSync('AGENT-MARKER', String(n));
  writeFileSync('agent-note.txt', 'added by the fake agent\\n');
  if (process.env.TRANSCRIPT_PATH) writeFileSync(process.env.TRANSCRIPT_PATH, stdin);
  // the session store pattern: a transcript per working directory, in a
  // bucket this attempt creates. A later attempt must not read it.
  if (process.env.TRANSCRIPT_DIR) {
    const mine = join(process.env.TRANSCRIPT_DIR, 'bucket-' + n, 'session.jsonl');
    mkdirSync(dirname(mine), { recursive: true });
    writeFileSync(mine, stdin);
    let prev = 'no-prev';
    if (n > 0) {
      try { prev = 'READ ' + readFileSync(join(process.env.TRANSCRIPT_DIR, 'bucket-' + (n - 1), 'session.jsonl'), 'utf8').slice(0, 40); }
      catch (e) { prev = 'DENIED ' + e.code; }
    }
    writeFileSync(join(cap, 'prev-' + n + '.txt'), prev);
  }
  if (process.env.FAKE_SLEEP_MS) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_SLEEP_MS));
  console.log('fake-agent-done');
});
`;

// The fake reader saves its stdin (the payload), follows the clone path
// the test output echoes and tries the brief beside it (a live read would
// leak the setup), tries the output root READER_OUT names when set (its
// retained folders, briefs and logs name the setups), tries the agent
// transcript TRANSCRIPT_PATH names when set (it holds the prompt), then
// answers from the comma list READER_REPLY (default pass, then fail).
const FAKE_READER = `import { readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const cap = process.env.READER_CAPTURE;
let stdin = '';
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => {
  const n = readdirSync(cap).filter((f) => f.startsWith('reader-')).length;
  writeFileSync(join(cap, 'reader-' + n + '.json'), stdin);
  let leak = 'no-path';
  try {
    const cloneDir = /(\\/\\S+\\/clone)/.exec(JSON.parse(stdin).testOutput)?.[1];
    if (cloneDir) {
      try { leak = readFileSync(join(dirname(cloneDir), 'brief.md'), 'utf8'); }
      catch (e) { leak = 'UNREADABLE ' + e.code; }
    }
  } catch (e) { leak = 'BAD-PAYLOAD ' + e.code; }
  writeFileSync(join(cap, 'leak-' + n + '.txt'), leak);
  if (process.env.READER_OUT) {
    let seen;
    try {
      // resolve first: the deny must hold through the real path, not
      // only the name --out was passed as
      const root = realpathSync(process.env.READER_OUT);
      const files = readdirSync(root, { recursive: true })
        .filter((f) => /brief\\.md$|curate\\.log$/.test(f));
      seen = 'LISTED ' + files
        .map((f) => { try { return readFileSync(join(root, f), 'utf8').slice(0, 30); } catch (e) { return 'ERR ' + e.code; } })
        .join(' | ');
    } catch (e) { seen = 'DENIED ' + e.code; }
    writeFileSync(join(cap, 'outread-' + n + '.txt'), seen);
  }
  if (process.env.TRANSCRIPT_PATH) {
    let t;
    try { t = 'READ ' + readFileSync(process.env.TRANSCRIPT_PATH, 'utf8').slice(0, 60); }
    catch (e) { t = 'DENIED ' + e.code; }
    writeFileSync(join(cap, 'tran-' + n + '.txt'), t);
  }
  const replies = (process.env.READER_REPLY ?? 'pass,fail').split(',');
  console.log(replies[n] ?? replies.at(-1));
});
`;

const writeTool = (dir, name, src) => {
  const file = join(dir, name);
  writeFileSync(file, src);
  return `node ${file}`;
};

// The stubs return the grader's real output shape: for a reader check that
// is {id, verdict} only; the check text lives in the task's rubric.
const gradeOk = () => ({
  hiddenTests: { pass: true },
  blockers: [{ id: 'hidden-tests-pass', verdict: 'pass', detail: '' }],
  quality: [], score: 1, needsReader: [],
});
const gradeWithReader = () => ({
  hiddenTests: { pass: true },
  blockers: [{ id: 'hidden-tests-pass', verdict: 'pass', detail: '' }],
  quality: [{ id: 'same-shape', verdict: 'needs-reader' }],
  score: null, needsReader: ['same-shape'],
});

// env carries a fake home so the canary files live only in the temp folder.
const fakeHomeEnv = (home, extra = {}) => ({
  ...process.env, HOME: home, CODEX_HOME: join(home, '.codex'), ...extra,
});

// One canary file per path the sandbox denies: each tells the agent to
// begin every reply with a marker. The transcript-store canaries stand
// for the state a real agent accumulates.
const fakeHome = () => {
  const home = tmp();
  const files = {
    '.codex/AGENTS.md': 'CANARY-CODEX',
    '.codex/AGENTS.override.md': 'CANARY-CODEX-OVERRIDE',
    '.codex/config.toml': 'CANARY-CODEX-CONFIG',
    '.codex/hooks.json': 'CANARY-CODEX-HOOKS',
    '.codex/skills/canary.md': 'CANARY-CODEX-SKILLS',
    '.codex/memories/canary.md': 'CANARY-CODEX-MEMORIES',
    '.codex/plugins/canary.md': 'CANARY-CODEX-PLUGINS',
    '.codex/prompts/canary.md': 'CANARY-CODEX-PROMPTS',
    '.agents/skills/canary.md': 'CANARY-AGENTS-SKILLS',
    '.claude/CLAUDE.md': 'CANARY-CLAUDE',
    '.claude/CLAUDE.local.md': 'CANARY-CLAUDE-LOCAL',
    '.claude/settings.json': 'CANARY-CLAUDE-SETTINGS',
    '.claude/settings.local.json': 'CANARY-CLAUDE-SETTINGS-LOCAL',
    '.claude/rules/canary.md': 'CANARY-CLAUDE-RULES',
    '.claude/skills/canary.md': 'CANARY-CLAUDE-SKILLS',
    '.claude/agents/canary.md': 'CANARY-CLAUDE-AGENTS',
    '.claude/plugins/canary.md': 'CANARY-CLAUDE-PLUGINS',
    '.claude.json': 'CANARY-CLAUDE-JSON',
    '.grok/Agents.md': 'CANARY-GROK-AGENTS',
    '.grok/Claude.md': 'CANARY-GROK-CLAUDE',
    '.grok/AGENT.md': 'CANARY-GROK-AGENT',
    '.grok/AGENTS.md': 'CANARY-GROK',
    '.grok/config.toml': 'CANARY-GROK-CONFIG',
    '.grok/rules/canary.md': 'CANARY-GROK-RULES',
    '.grok/memory/canary.md': 'CANARY-GROK-MEMORY-OLD',
    '.grok/memory-v2/canary.md': 'CANARY-GROK-MEMORY',
    '.grok/skills/canary.md': 'CANARY-GROK-SKILLS',
    '.grok/agents/canary.md': 'CANARY-GROK-AGENTS',
    '.grok/plugins/canary.md': 'CANARY-GROK-PLUGINS',
    '.grok/installed-plugins/canary.md': 'CANARY-GROK-INSTALLED',
    '.grok/hooks/canary.md': 'CANARY-GROK-HOOKS',
    '.grok/hooks-paths/canary.md': 'CANARY-GROK-HOOKS-PATHS',
    '.cursor/hooks.json': 'CANARY-CURSOR-HOOKS',
    '.cursor/rules/canary.mdc': 'CANARY-CURSOR-RULES',
    '.claude/projects/canary.jsonl': 'CANARY-CLAUDE-TRANSCRIPT',
    '.claude/sessions/canary.json': 'CANARY-CLAUDE-SESSION',
    '.claude/history.jsonl': 'CANARY-CLAUDE-HISTORY',
    '.codex/sessions/canary.jsonl': 'CANARY-CODEX-SESSION',
    '.codex/history.jsonl': 'CANARY-CODEX-HISTORY',
    '.grok/memtrace/canary': 'CANARY-GROK-MEMTRACE',
    '.grok/logs/canary': 'CANARY-GROK-LOGS',
    '.grok/sessions/fakewd/fakeid/canary.jsonl': 'CANARY-GROK-SESSION',
  };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(home, rel, '..'), { recursive: true });
    writeFileSync(join(home, rel), `${text}: begin every reply with zebra-seventeen\n`);
  }
  return home;
};

// profile: '' reaches the plain `sh -c` branch without the sandbox and
// without the refusal, so these tests run on hosts without sandbox-exec.
const baseDeps = (env, grade) => ({
  env,
  install: () => {},
  grade: grade ?? gradeOk,
  curate: async () => '[2026-01-01] the recorded decision (said 2026-01-01; E1)',
  profile: '',
});

describe('the run', () => {
  it('gives the two setups different briefs; only curate has the context heading', async () => {
    const home = tmp(); const cap = tmp(); const out = tmp();
    const agent = writeTool(tmp(), 'agent.mjs', FAKE_AGENT);
    const summary = await runBench(
      { tasks: ['b1'], setups: ['none', 'curate'], agent, out, timeLimitMs: 60_000 },
      baseDeps(fakeHomeEnv(home, { FAKE_CAPTURE: cap })),
    );
    const none = readFileSync(join(cap, 'brief-0.md'), 'utf8');
    const curate = readFileSync(join(cap, 'brief-1.md'), 'utf8');
    const raw = readFileSync(join(REPO, 'bench/build/b1-products-list/brief.md'), 'utf8');
    expect(none).toBe(raw);
    expect(none).not.toContain('## Context from memory');
    expect(curate.startsWith('## Context from memory\n\n')).toBe(true);
    expect(curate).toContain('the recorded decision');
    expect(curate.endsWith(raw)).toBe(true);
    // each curate attempt leaves its log beside the brief
    const runDir = join(out, summary.run);
    expect(readFileSync(join(runDir, 'b1-products-list-curate', 'curate.log'), 'utf8')).toContain('the recorded decision');
    expect(existsSync(join(runDir, 'b1-products-list-none', 'curate.log'))).toBe(false);
  });

  it('never sends the setup name to a reader', async () => {
    const home = tmp(); const cap = tmp(); const out = tmp();
    const agent = writeTool(tmp(), 'agent.mjs', FAKE_AGENT);
    const reader = writeTool(tmp(), 'reader.mjs', FAKE_READER);
    await runBench(
      { tasks: ['b1'], setups: ['none', 'curate'], agent, reader, out, timeLimitMs: 60_000 },
      {
        ...baseDeps(fakeHomeEnv(home, { FAKE_CAPTURE: cap, READER_CAPTURE: cap, READER_REPLY: 'pass' })),
        // the real grader's log echoes the clone and report paths it ran
        // under, so the stub writes one too; a path carrying the setup
        // name would then slip into the reader payload
        grade: async ({ copyDir, runDir }) => {
          writeFileSync(join(runDir, 'hidden-tests.log'), [
            '> orders-api@0.9.0 test',
            `> vitest run --reporter=default --reporter=json --outputFile.json=${join(runDir, 'hidden-tests.json')}`,
            '',
            ` RUN  v3.2.7 ${copyDir}`,
            '',
          ].join('\n'));
          return gradeWithReader();
        },
      },
    );
    const payloads = readdirSync(cap).filter((f) => f.startsWith('reader-')).sort()
      .map((f) => readFileSync(join(cap, f), 'utf8'));
    expect(payloads.length).toBe(4); // two readers per setup
    for (const raw of payloads) {
      expect(raw).not.toContain('curate');
      expect(raw).not.toContain('-none');
      const payload = JSON.parse(raw);
      expect(payload).not.toHaveProperty('setup');
      expect(Object.keys(payload).sort()).toEqual(['check', 'diff', 'instruction', 'task', 'testOutput']);
      // the instruction tells the reader what to do and how to answer
      expect(payload.instruction).toMatch(/pass.*fail.*unsure/);
      expect(payload.check.id).toBe('same-shape');
      expect(payload.check.check).toBe('response shape matches existing list endpoints (items + nextCursor)');
      expect(payload.check.why).toBe('consistency with the cursor convention');
      expect(payload.testOutput).toContain('RUN');
    }
    // the clone path the test output echoes is dead by the time a reader
    // runs, so the brief beside it (which names the setup) cannot be read
    const leaks = readdirSync(cap).filter((f) => f.startsWith('leak-')).sort()
      .map((f) => readFileSync(join(cap, f), 'utf8'));
    expect(leaks.length).toBe(4);
    for (const leak of leaks) {
      expect(leak.startsWith('UNREADABLE')).toBe(true);
      expect(leak).not.toContain('Context from memory');
    }
  });

  it('keeps a reader disagreement split instead of guessing', async () => {
    const home = tmp(); const cap = tmp(); const out = tmp();
    const agent = writeTool(tmp(), 'agent.mjs', FAKE_AGENT);
    const reader = writeTool(tmp(), 'reader.mjs', FAKE_READER); // first pass, then fail
    const summary = await runBench(
      { tasks: ['b1'], setups: ['none'], agent, reader, out, timeLimitMs: 60_000 },
      baseDeps(fakeHomeEnv(home, { FAKE_CAPTURE: cap, READER_CAPTURE: cap }), gradeWithReader),
    );
    const record = summary.tasks['b1-products-list'].none;
    expect(record.status).toBe('graded');
    const check = record.grade.quality[0];
    expect(check.id).toBe('same-shape');
    expect(check.verdict).toBe('split');
    expect(check.readers).toEqual(['pass', 'fail']);
    expect(record.score).toBeNull();
  });

  it('leaves a check needs-reader when a reader is unsure or unreadable', async () => {
    const home = tmp(); const out = tmp();
    const agent = writeTool(tmp(), 'agent.mjs', FAKE_AGENT);
    const reader = writeTool(tmp(), 'reader.mjs', FAKE_READER);
    // pass against unsure, and pass against a reply that is no verdict:
    // only a pass against a fail records split
    for (const [reply, readers] of [['unsure', ['unsure', 'unsure']], ['pass,unsure', ['pass', 'unsure']], ['pass,junk', ['pass', null]]]) {
      const cap = tmp(); // the reply index counts calls per capture folder
      const summary = await runBench(
        { tasks: ['b1'], setups: ['none'], agent, reader, out, timeLimitMs: 60_000 },
        baseDeps(fakeHomeEnv(home, { FAKE_CAPTURE: cap, READER_CAPTURE: cap, READER_REPLY: reply }), gradeWithReader),
      );
      const check = summary.tasks['b1-products-list'].none.grade.quality[0];
      expect(check.readers).toEqual(readers);
      expect(check.verdict).toBe('needs-reader');
      expect(summary.tasks['b1-products-list'].none.score).toBeNull();
    }
  });

  it('records a timed-out agent as a failed attempt, not a crash', async () => {
    const home = tmp(); const cap = tmp(); const out = tmp();
    const agent = writeTool(tmp(), 'agent.mjs', FAKE_AGENT);
    const summary = await runBench(
      { tasks: ['b1'], setups: ['none'], agent, out, timeLimitMs: 400 },
      baseDeps(fakeHomeEnv(home, { FAKE_CAPTURE: cap, FAKE_SLEEP_MS: '30000' })),
    );
    const record = summary.tasks['b1-products-list'].none;
    expect(record.status).toBe('timeout');
    expect(record.score).toBeUndefined();
    const written = JSON.parse(readFileSync(join(out, summary.run, 'summary.json'), 'utf8'));
    expect(written.tasks['b1-products-list'].none.status).toBe('timeout');
  }, 30_000);

  it('kills the whole process group when the time limit hits', async () => {
    const home = tmp(); const cap = tmp(); const out = tmp();
    const agent = writeTool(tmp(), 'agent.mjs', FAKE_AGENT);
    // a pipeline: `sh -c` does not hand itself over to the agent, so
    // signalling only the shell would leave the agent running with the
    // output pipe open and the attempt would sit until its 30s sleep ended
    const summary = await runBench(
      { tasks: ['b1'], setups: ['none'], agent: `${agent} | cat`, out, timeLimitMs: 400 },
      baseDeps(fakeHomeEnv(home, { FAKE_CAPTURE: cap, FAKE_SLEEP_MS: '30000' })),
    );
    const record = summary.tasks['b1-products-list'].none;
    expect(record.status).toBe('timeout');
    expect(record.agent.ms).toBeLessThan(15_000);
  }, 30_000);

  it('starts every attempt from a fresh clone at the pinned commit', async () => {
    const home = tmp(); const cap = tmp(); const out = tmp();
    const agent = writeTool(tmp(), 'agent.mjs', FAKE_AGENT);
    let graded = 0;
    const summary = await runBench(
      { tasks: ['b1'], setups: ['none', 'curate'], agent, out, timeLimitMs: 60_000 },
      {
        ...baseDeps(fakeHomeEnv(home, { FAKE_CAPTURE: cap })),
        grade: async ({ copyDir }) => {
          graded++;
          // a reused clone would keep the marker and the earlier change
          expect(execFileSync('git', ['-C', copyDir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim())
            .toBe(JSON.parse(readFileSync(join(REPO, 'bench/manifest.json'), 'utf8')).repo_rev);
          return gradeOk();
        },
      },
    );
    expect(graded).toBe(2);
    expect(readFileSync(join(cap, 'tree-0.txt'), 'utf8')).toBe('FRESH');
    expect(readFileSync(join(cap, 'tree-1.txt'), 'utf8')).toBe('FRESH');
    // and the two attempts were different directories
    const dirs = readdirSync(join(out, summary.run)).filter((d) => d.startsWith('b1-'));
    expect(dirs.sort()).toEqual(['b1-products-list-curate', 'b1-products-list-none']);
  });

  it('refuses to run where no isolation mechanism applies', async () => {
    const home = tmp(); const cap = tmp(); const out = tmp();
    const agent = writeTool(tmp(), 'agent.mjs', FAKE_AGENT);
    // profile: null is what a host without working sandbox-exec resolves to
    await expect(runBench(
      { tasks: ['b1'], setups: ['none'], agent, out },
      { ...baseDeps(fakeHomeEnv(home, { FAKE_CAPTURE: cap })), profile: null },
    )).rejects.toThrow(/cannot hide your global agent-instruction files/);
  });

  it('refuses an agent or reader command that would load the user files', async () => {
    const home = tmp(); const cap = tmp(); const out = tmp();
    const agent = writeTool(tmp(), 'agent.mjs', FAKE_AGENT);
    const env = fakeHomeEnv(home, { FAKE_CAPTURE: cap });
    // without their skip flags claude and codex read the operator's
    // instructions before the sandbox deny is the only thing left;
    // refuse instead of relying on the profile alone. grok has no flag
    // at all, so it is refused outright, as agent and as reader.
    await expect(runBench({ tasks: ['b1'], setups: ['none'], agent: 'claude -p', out }, baseDeps(env)))
      .rejects.toThrow(/--safe-mode/);
    await expect(runBench({ tasks: ['b1'], setups: ['none'], agent: 'codex exec', out }, baseDeps(env)))
      .rejects.toThrow(/--ignore-user-config/);
    await expect(runBench({ tasks: ['b1'], setups: ['none'], agent: 'grok -p do', out }, baseDeps(env)))
      .rejects.toThrow(/does not support it/);
    await expect(runBench(
      { tasks: ['b1'], setups: ['none'], agent, reader: 'claude -p', out }, baseDeps(env),
    )).rejects.toThrow(/--safe-mode/);
    await expect(runBench(
      { tasks: ['b1'], setups: ['none'], agent, reader: 'grok -p read', out }, baseDeps(env),
    )).rejects.toThrow(/does not support it/);
  });
});

describe('the clean environment', () => {
  // sandbox-exec is the mechanism; where it cannot run the test cannot run
  const darwin = process.platform === 'darwin'
    && spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true']).status === 0;

  it.skipIf(!darwin)('lets the fake agent read its canary outside the runner, and denies it inside', async () => {
    const home = fakeHome();
    const capDirect = tmp(); const capRunner = tmp(); const out = tmp();
    const agent = writeTool(tmp(), 'agent.mjs', FAKE_AGENT);
    const env = fakeHomeEnv(home, { FAKE_CAPTURE: capDirect });
    // control: the same command, same env, no runner; reads the canary
    const direct = spawnSync('sh', ['-c', agent], { env, cwd: tmp(), input: 'do something' });
    expect(direct.status).toBe(0);
    const exposed = readFileSync(join(capDirect, 'canary-0.txt'), 'utf8');
    expect(exposed).toContain('CANARY-CODEX');
    expect(exposed).toContain('CANARY-CLAUDE');
    expect(exposed).toContain('CANARY-GROK-SKILLS');
    // through the runner the same files are unreadable: the real sandbox
    // profile, built for the fake home
    const runnerEnv = { ...env, FAKE_CAPTURE: capRunner };
    await runBench(
      { tasks: ['b1'], setups: ['none'], agent, out, timeLimitMs: 60_000 },
      { ...baseDeps(runnerEnv), profile: instructionsProfile(runnerEnv) },
    );
    const denied = readFileSync(join(capRunner, 'canary-0.txt'), 'utf8');
    expect(denied).not.toContain('CANARY-');
    expect(denied.match(/UNREADABLE/g)?.length).toBe(42);
  }, 30_000);

  it.skipIf(!darwin)('denies the reader the retained outputs wherever --out points', async () => {
    const home = fakeHome();
    const cap = tmp();
    // --out names a folder that does not exist yet, under the temp
    // root, which macOS reaches through a symlink: a deny recorded only
    // under that unresolved name would let the reader in through the
    // resolved path
    const out = join(tmp(), 'results');
    const agent = writeTool(tmp(), 'agent.mjs', FAKE_AGENT);
    const reader = writeTool(tmp(), 'reader.mjs', FAKE_READER);
    // READER_OUT names the run's output root for the fake reader: out
    // sits outside this repository, so the reader profile must deny it
    // explicitly. A live read would list the <task>-<setup> folders and
    // read their briefs and curate logs.
    const env = fakeHomeEnv(home, {
      FAKE_CAPTURE: cap, READER_CAPTURE: cap, READER_OUT: out, READER_REPLY: 'pass',
    });
    await runBench(
      { tasks: ['b1'], setups: ['none', 'curate'], agent, reader, out, timeLimitMs: 60_000 },
      { ...baseDeps(env), profile: instructionsProfile(env), grade: gradeWithReader },
    );
    const reads = readdirSync(cap).filter((f) => f.startsWith('outread-')).sort()
      .map((f) => readFileSync(join(cap, f), 'utf8'));
    expect(reads.length).toBe(4); // two readers per setup
    for (const seen of reads) expect(seen.startsWith('DENIED')).toBe(true);
  }, 30_000);

  it.skipIf(!darwin)('denies a later attempt the session folder an earlier attempt created', async () => {
    const home = fakeHome();
    const cap = tmp(); const out = tmp();
    const agent = writeTool(tmp(), 'agent.mjs', FAKE_AGENT);
    // each attempt writes its transcript into a session bucket that did
    // not exist when the run started. The deny covers the whole store,
    // so the next attempt's agent cannot read it even though the write
    // itself went through (the denies are reads only).
    const sessions = join(home, '.grok', 'sessions');
    const env = fakeHomeEnv(home, { FAKE_CAPTURE: cap, TRANSCRIPT_DIR: sessions });
    await runBench(
      { tasks: ['b1'], setups: ['none', 'curate'], agent, out, timeLimitMs: 60_000 },
      { ...baseDeps(env), profile: instructionsProfile(env) },
    );
    const raw = readFileSync(join(REPO, 'bench/build/b1-products-list/brief.md'), 'utf8');
    expect(readFileSync(join(sessions, 'bucket-0', 'session.jsonl'), 'utf8')).toBe(raw);
    expect(readFileSync(join(cap, 'prev-1.txt'), 'utf8').startsWith('DENIED')).toBe(true);
  }, 30_000);

  it.skipIf(!darwin)('denies the reader the agent session store', async () => {
    const home = fakeHome();
    const cap = tmp(); const out = tmp();
    const agent = writeTool(tmp(), 'agent.mjs', FAKE_AGENT);
    const reader = writeTool(tmp(), 'reader.mjs', FAKE_READER);
    // the store is denied to reads but not writes, so the transcript
    // lands there holding the prompt, including the curate attempt's
    // memory heading, and a reader must not get at it
    const transcript = join(home, '.grok', 'sessions', 'live-transcript.jsonl');
    const env = fakeHomeEnv(home, {
      FAKE_CAPTURE: cap, READER_CAPTURE: cap, READER_REPLY: 'pass', TRANSCRIPT_PATH: transcript,
    });
    await runBench(
      { tasks: ['b1'], setups: ['none', 'curate'], agent, reader, out, timeLimitMs: 60_000 },
      { ...baseDeps(env), profile: instructionsProfile(env), grade: gradeWithReader },
    );
    expect(readFileSync(transcript, 'utf8')).toContain('Context from memory');
    const reads = readdirSync(cap).filter((f) => f.startsWith('tran-')).sort()
      .map((f) => readFileSync(join(cap, f), 'utf8'));
    expect(reads.length).toBe(4); // two readers per setup
    for (const seen of reads) expect(seen.startsWith('DENIED')).toBe(true);
  }, 30_000);
});
