// Hidden tests for b6-soft-delete — encode rule 24 (soft deletes).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

let proc: ChildProcess | undefined;
let dir: string;
let base: string;
let dbFile: string;

const waitReady = async (url: string, ms = 15_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`${url}/health`); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('app did not become ready');
};

const anyProduct = async () => {
  const res = await fetch(`${base}/products?limit=1`);
  const body = await res.json();
  const item = (body.items ?? body)[0];
  return item?.sku;
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wren-hidden-'));
  dbFile = join(dir, 'h.db');
  const port = 43000 + Math.floor(Math.random() * 2000);
  base = `http://127.0.0.1:${port}`;
  proc = spawn('node', ['dist/index.js'], {
    env: { ...process.env, PORT: String(port), DB_FILE: dbFile, LOG_LEVEL: 'fatal' },
    stdio: 'ignore',
  });
  await waitReady(base);
}, 30_000);

afterAll(() => { proc?.kill(); rmSync(dir, { recursive: true, force: true }); });

describe('DELETE /products/:sku', () => {
  it('hides the product from reads', async () => {
    const sku = await anyProduct();
    if (!sku) return;
    const del = await fetch(`${base}/products/${encodeURIComponent(sku)}`, { method: 'DELETE' });
    expect([200, 204]).toContain(del.status);
    const get = await fetch(`${base}/products/${encodeURIComponent(sku)}`);
    expect([404, 410]).toContain(get.status);
  });

  it('keeps the row in the database (tombstone, not DELETE FROM)', async () => {
    const sku = await anyProduct();
    if (!sku) return;
    await fetch(`${base}/products/${encodeURIComponent(sku)}`, { method: 'DELETE' });
    const db = new Database(dbFile, { readonly: true });
    const row = db.prepare('select * from products where sku = ?').get(sku) as Record<string, unknown> | undefined;
    db.close();
    expect(row).toBeTruthy();
    expect(row?.deleted_at ?? row?.deletedAt ?? row?.active).toBeTruthy();
  });

  it('returns the standard error for an unknown sku', async () => {
    const res = await fetch(`${base}/products/NO-SUCH-SKU-9`, { method: 'DELETE' });
    expect([400, 404]).toContain(res.status);
    const body = await res.json();
    expect(body.error ?? body.message).toBeTruthy();
  });
});
