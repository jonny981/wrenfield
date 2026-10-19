#!/usr/bin/env node
// Grades one build task: the hidden test dropped into the built copy, then
// each rubric check. Blockers gate the score to 0; quality checks add.
//
//   node bench/build/grade.mjs --task <b1..b6 or full name> --patch <change.patch> [--corpus <dir>] [--keep-copy]
//   node bench/build/grade.mjs --task <name> --copy <dir>
//
// --patch builds a fresh copy: a clone of the corpus at the manifest's
// commit, the patch applied, `npm ci`. --copy grades a working tree you
// built yourself; its HEAD must be that commit, with the change left
// uncommitted. Prints the grade as JSON. Checks no script can settle come
// back as "needs-reader": a person reads the change and decides them.
import { spawn, execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function sh(cmd, args, { cwd } = {}) {
  return new Promise((resolveSh, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => resolveSh({ code, out, err }));
  });
}

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
const tail = (text, lines = 30) => String(text).trim().split('\n').slice(-lines).join('\n');
const clip = (text, n = 400) => String(text ?? '').slice(0, n);
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

// ---------- grading ----------

// "npm test with hidden.test.ts dropped in", on a fresh dist build. The file
// lands at the copy's root: tsc only compiles src/, vitest picks it up there,
// and a hidden test that walks src/ never trips on the test file itself.
// A JSON report beside the usual output gives each hidden test its own
// verdict (`tests`, keyed by its it() title), so a rubric check can read the
// one test it names.
async function defaultSuite({ copyDir, taskDir, runDir }) {
  const build = await sh('npm', ['run', 'build'], { cwd: copyDir });
  if (build.code !== 0) return { pass: false, tail: `npm run build failed:\n${tail(build.err)}`, tests: {} };
  await copyFile(join(taskDir, 'hidden.test.ts'), join(copyDir, 'hidden.test.ts'));
  const report = join(runDir ?? await mkdtemp(join(tmpdir(), 'hidden-tests-')), 'hidden-tests.json');
  const res = await sh('npm', ['test', '--', '--reporter=default', '--reporter=json', `--outputFile.json=${report}`], { cwd: copyDir });
  await rm(join(copyDir, 'hidden.test.ts'), { force: true }); // grading data, not the builder's change
  if (runDir) await writeFile(join(runDir, 'hidden-tests.log'), res.out + res.err);
  const tests = {};
  try {
    for (const file of (await readJson(report)).testResults ?? []) {
      if (basename(file.name) !== 'hidden.test.ts') continue;
      for (const t of file.assertionResults ?? []) {
        tests[t.title] = { pass: t.status === 'passed', detail: clip((t.failureMessages ?? []).join('\n'), 600) };
      }
    }
  } catch { /* no report: the run never got as far as the tests; every named test reads as not run */ }
  return { pass: res.code === 0, tail: tail(res.out + res.err), tests };
}

// Lines the builder added, per path, skipping excluded files: lines of a
// changed or new file that its base version (HEAD) did not have. A line
// counts only beyond the copies the base file already held, compared without
// indentation, so a moved or re-indented line is not new code (a diff shows
// a moved line as added: b3's build moved the display formatter's toFixed
// below new helpers and was failed for it). Deleted files add nothing.
async function defaultGitAdded(copyDir, paths, exclude) {
  const tracked = git(copyDir, 'diff', '--name-only', 'HEAD', '--', ...paths).split('\n').filter(Boolean);
  const untracked = git(copyDir, 'ls-files', '--others', '--exclude-standard', '--', ...paths).split('\n').filter(Boolean);
  const lines = [];
  for (const f of [...tracked, ...untracked].filter((f) => !exclude.includes(f))) {
    let now;
    try { now = await readFile(join(copyDir, f), 'utf8'); } catch { continue; } // deleted or unreadable
    const base = new Map();
    try {
      for (const l of execFileSync('git', ['-C', copyDir, 'show', `HEAD:${f}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n')) {
        base.set(l.trim(), (base.get(l.trim()) ?? 0) + 1);
      }
    } catch { /* not in the base commit: every line is new */ }
    for (const l of now.split('\n')) {
      const left = base.get(l.trim()) ?? 0;
      if (left) base.set(l.trim(), left - 1);
      else lines.push({ file: f, line: l });
    }
  }
  return lines;
}

// A rubric check is mechanical when it spells out a grep that must come back
// empty. Anything else is for a reader, not a guess.
export function mechanicalCheck(check) {
  const m = /grep\s+[^'\n]*'((?:[^'\\]|\\.)*)'/.exec(check);
  if (!m || !/returns nothing|no matches|empty/i.test(check)) return null;
  const outside = /outside\s+(\S+)/.exec(check)?.[1];
  const dirs = new Set();
  for (const t of check.matchAll(/\b(?:src|tests?|scripts|migrations)(?:\/[\w.-]+)*\/?/g)) {
    if (t[0] === outside || /\.[a-z0-9]+$/.test(t[0])) continue;
    dirs.add(t[0]);
  }
  return {
    pattern: m[1].replace(/\\\|/g, '|'),
    paths: dirs.size ? [...dirs] : ['src'],
    exclude: outside ? [outside] : [],
  };
}

// Test files are not the shipped change: a builder's test that asserts the
// wrong path is refused names the very text a grep bans (a b1 build was
// once scored 0 for `expect((await get('?offset=50')).status).toBe(400)`).
// Grep checks skip *.test.ts and anything under a test/ or tests/ folder.
const isTestFile = (f) => /\.test\.ts$/.test(f) || /(^|\/)tests?\//.test(f);

// Blockers gate to 0: a failed blocker scores the run 0, and any check left
// undecided leaves the score pending (null) until a reader verdicts it.
const scoreChecks = (blockers, quality) => {
  if (blockers.some((b) => b.verdict === 'fail')) return 0;
  if ([...blockers, ...quality].some((c) => c.verdict === 'needs-reader')) return null;
  return quality.length ? quality.filter((q) => q.verdict === 'pass').length / quality.length : null;
};

export async function gradeRun({ copyDir, rubric, runSuite = defaultSuite, gitAdded, taskDir, runDir }) {
  const added = gitAdded ?? ((paths, exclude) => defaultGitAdded(copyDir, paths, exclude));
  const suite = await runSuite({ copyDir, taskDir, runDir });
  const suiteVerdict = (id) => ({ id, verdict: suite.pass ? 'pass' : 'fail', detail: suite.pass ? '' : suite.tail });
  const testVerdict = (id, title) => {
    const t = suite.tests?.[title];
    if (!t) return { id, verdict: 'fail', detail: `hidden test "${title}" did not run` };
    return t.pass ? { id, verdict: 'pass' } : { id, verdict: 'fail', detail: t.detail };
  };
  const checkOne = async ({ id, check, test }) => {
    if (id === 'hidden-tests-pass') return suiteVerdict(id);
    const spec = mechanicalCheck(check);
    if (spec) {
      const re = new RegExp(spec.pattern);
      // the dropped hidden test is grading data, not the builder's change
      const hits = (await added(spec.paths, [...spec.exclude, 'hidden.test.ts'])).filter((l) => !isTestFile(l.file) && re.test(l.line));
      return hits.length
        ? { id, verdict: 'fail', detail: hits.slice(0, 3).map((h) => `${h.file}: ${h.line.trim()}`).join(' | ') }
        : { id, verdict: 'pass' };
    }
    // a check the rubric delegates to the hidden tests takes the verdict of
    // the one test it names, never the whole suite's: b2's key-required
    // failed while its own test passed, because another test failed.
    // Anything else is for a reader, not a guess.
    if (/asserted by hidden tests/i.test(check)) {
      if (!test) throw new Error(`rubric check ${id} is asserted by hidden tests but names no "test" (its it() title)`);
      return testVerdict(id, test);
    }
    return { id, verdict: 'needs-reader' };
  };
  const blockers = await Promise.all(rubric.blockers.map(checkOne));
  const quality = await Promise.all(rubric.quality.map(checkOne));
  const score = scoreChecks(blockers, quality);
  const needsReader = [...blockers, ...quality].filter((c) => c.verdict === 'needs-reader').map((c) => c.id);
  return { hiddenTests: { pass: suite.pass }, blockers, quality, score, needsReader };
}

// ---------- entry ----------

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const BENCH = fileURLToPath(new URL('.', import.meta.url));
  const ROOT = fileURLToPath(new URL('../../', import.meta.url));
  const opts = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const take = () => argv[++i];
    switch (argv[i]) {
      case '--task': opts.task = take(); break;
      case '--patch': opts.patch = resolve(take()); break;
      case '--copy': opts.copy = resolve(take()); break;
      case '--corpus': opts.corpus = resolve(take()); break;
      case '--keep-copy': opts.keepCopy = true; break;
      default: throw new Error(`unknown argument ${argv[i]}`);
    }
  }
  const task = (await readdir(BENCH)).find((t) => t === opts.task || t.startsWith(`${opts.task}-`));
  if (!task || !existsSync(join(BENCH, task, 'rubric.json'))) throw new Error(`no build task ${opts.task}`);
  if (!opts.patch === !opts.copy) throw new Error('pass exactly one of --patch <file> or --copy <dir>');
  let copyDir = opts.copy;
  if (opts.patch) {
    const corpus = opts.corpus ?? join(ROOT, 'corpus', 'wrenfield');
    const { repo_rev: sha } = JSON.parse(readFileSync(join(ROOT, 'bench', 'manifest.json'), 'utf8'));
    copyDir = await mkdtemp(join(tmpdir(), `wrenfield-${task}-`));
    execFileSync('git', ['clone', '--quiet', corpus, copyDir]);
    git(copyDir, 'checkout', '--quiet', '--detach', sha);
    if (readFileSync(opts.patch, 'utf8').trim()) git(copyDir, 'apply', '--whitespace=nowarn', opts.patch);
    execFileSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: copyDir, stdio: 'ignore' });
  }
  const rubric = JSON.parse(await readFile(join(BENCH, task, 'rubric.json'), 'utf8'));
  const grade = await gradeRun({ copyDir, taskDir: join(BENCH, task), rubric });
  console.log(JSON.stringify({ task, ...grade }, null, 2));
  if (opts.patch && !opts.keepCopy) await rm(copyDir, { recursive: true, force: true });
}
