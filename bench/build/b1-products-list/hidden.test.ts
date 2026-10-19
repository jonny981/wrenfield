// Hidden tests for b1-products-list — encode the cursor decision.
// Dropped into the built copy's root at grading time; spawns
// the built app (PORT + DB_FILE are env-configured through src/config.ts)
// and checks the live HTTP contract.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    env: { ...process.env, PORT: String(port), DB_FILE: join(dir, 'h.db'), LOG_LEVEL: 'fatal' },
    stdio: 'ignore',
  });
  await waitReady(base);
  // Seed past rule 20's 200 cap: on an empty table every limit check passes
  // vacuously, so the rows are what give the assertions below teeth.
  const db = new Database(join(dir, 'h.db'));
  const ins = db.prepare('insert into products (sku, name, unit_price_cents, active) values (?, ?, ?, 1)');
  for (let i = 0; i < 250; i++) ins.run(`SKU-H${i}`, `hidden product ${i}`, 100);
  db.close();
}, 30_000);

afterAll(() => { proc?.kill(); rmSync(dir, { recursive: true, force: true }); });

describe('GET /products pagination', () => {
  it('returns the same paginated shape as other list endpoints', async () => {
    const res = await fetch(`${base}/products?limit=2`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBe(2);
    expect('nextCursor' in body || 'cursor' in body).toBe(true);
  });

  it('follows the cursor to the next page without repeating rows', async () => {
    const r1 = await fetch(`${base}/products?limit=2`);
    const b1 = await r1.json();
    const cursor = b1.nextCursor ?? b1.cursor;
    // 250 seeded rows under limit=2: a single page cannot hold them, so a
    // correct build must point at the next one
    expect(cursor).toBeTruthy();
    const r2 = await fetch(`${base}/products?limit=2&cursor=${encodeURIComponent(cursor)}`);
    const b2 = await r2.json();
    // products are keyed by sku — items carry no id
    const key = (i: { sku?: string; id?: string }) => i.sku ?? i.id;
    const ids1 = new Set(b1.items.map(key));
    expect(b2.items.length).toBe(2);
    for (const item of b2.items) {
      const k = key(item);
      expect(k).toBeDefined();
      expect(ids1.has(k)).toBe(false);
    }
    expect(new Set(b2.items.map(key)).size).toBe(b2.items.length);
  });

  it('does not expose offset pagination', async () => {
    const res = await fetch(`${base}/products?offset=5&limit=1`);
    expect([200, 400]).toContain(res.status);
    if (res.status === 200) {
      const body = await res.json();
      // offset must not silently drive pagination — a cursor field is
      // what other list endpoints return
      expect('nextCursor' in body || 'cursor' in body || body.items.length === 0).toBe(true);
    }
  });

  it('caps or rejects an oversized limit', async () => {
    const res = await fetch(`${base}/products?limit=100000`);
    expect([200, 400]).toContain(res.status);
    if (res.status === 200) expect((await res.json()).items.length).toBeLessThanOrEqual(200);
  });
});
