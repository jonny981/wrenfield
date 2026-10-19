// Hidden tests for b5-error-surface — encode rules 12/16/17.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';

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
}, 30_000);

afterAll(() => { proc?.kill(); rmSync(dir, { recursive: true, force: true }); });

describe('POST /orders unknown customer', () => {
  it('returns a 4xx, never a 500', async () => {
    const res = await fetch(`${base}/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ customerId: 'no-such-customer-xyz', lines: [{ sku: 'SKU-1', qty: 1, unitPriceCents: 100 }] }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('returns the standard error body {error, message}', async () => {
    const res = await fetch(`${base}/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ customerId: 'no-such-customer-xyz', lines: [{ sku: 'SKU-1', qty: 1, unitPriceCents: 100 }] }),
    });
    const body = await res.json();
    // the errorHandler's whole shape: a string code and a human message, nothing else
    expect(Object.keys(body).sort()).toEqual(['error', 'message']);
    expect(typeof body.error).toBe('string');
    expect(typeof body.message).toBe('string');
  });

  it('does not write the order', async () => {
    const res = await fetch(`${base}/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ customerId: 'no-such-customer-xyz', lines: [{ sku: 'SKU-1', qty: 1, unitPriceCents: 100 }] }),
    });
    const body = await res.json().catch(() => ({}));
    if (body.id) {
      const get = await fetch(`${base}/orders/${body.id}`);
      expect(get.status).not.toBe(200);
    }
  });
});
