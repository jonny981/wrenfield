// Hidden tests for b4-env-config — encode rule 30 (env through config).
// The behavioral side is checked by booting the built app with SLOW_MS
// set and unset; the structural side is a static read of src/config.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

let proc: ChildProcess | undefined;
let dir: string;
let base: string;

const waitReady = async (url: string, ms = 15_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`${url}/health`); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('app did not become ready');
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wren-hidden-'));
  const port = 43000 + Math.floor(Math.random() * 2000);
  base = `http://127.0.0.1:${port}`;
  proc = spawn('node', ['dist/index.js'], {
    env: { ...process.env, PORT: String(port), DB_FILE: join(dir, 'h.db'), LOG_LEVEL: 'fatal', SLOW_MS: '1' },
    stdio: 'ignore',
  });
  await waitReady(base);
}, 30_000);

afterAll(() => { proc?.kill(); rmSync(dir, { recursive: true, force: true }); });

describe('SLOW_MS configuration', () => {
  it('the app boots with SLOW_MS set to a tiny value and still serves', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
  });

  it('SLOW_MS is declared in the config module', () => {
    // the env read must live in src/config.ts, not inline elsewhere
    const cfg = readFileSync(join(process.cwd(), 'src/config.ts'), 'utf8');
    expect(/SLOW_MS/.test(cfg)).toBe(true);
  });

  // Rule 30 forbids NEW reads. At the build commit src/log.ts and
  // src/store/db.ts already read process.env, and no build touches them, so a
  // process.env line counts only when its file did not have it at HEAD (the
  // build commit; the builder's change is uncommitted in the graded copy).
  it('no source file outside src/config.ts adds a process.env read', () => {
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap(e =>
        e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.ts') ? [join(d, e.name)] : []);
    const envLines = (text: string) => text.split('\n').map(l => l.trim()).filter(l => l.includes('process.env'));
    const atBase = (rel: string) => {
      try {
        return execFileSync('git', ['show', `HEAD:${rel}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      } catch { return ''; } // a file the build added
    };
    for (const f of walk(join(process.cwd(), 'src'))) {
      const rel = relative(process.cwd(), f);
      if (rel === join('src', 'config.ts')) continue;
      const before = envLines(atBase(rel));
      const added = envLines(readFileSync(f, 'utf8')).filter(l => {
        const i = before.indexOf(l);
        if (i === -1) return true;
        before.splice(i, 1);
        return false;
      });
      expect(added, `${rel} reads process.env directly`).toEqual([]);
    }
  });
});
