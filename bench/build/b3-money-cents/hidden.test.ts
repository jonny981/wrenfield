// Hidden tests for b3-money-cents — encode rule 01 (integer cents).
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

const seedOrder = async (lines: { sku: string; qty: number; unitPriceCents: number }[]) => {
  const r = await fetch(`${base}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
    body: JSON.stringify({ customerId: 'cust-hidden-3', lines }),
  });
  if (r.status === 201 || r.status === 200) return (await r.json()).id;
  return null;
};

const isInt = (n: unknown) => typeof n === 'number' && Number.isInteger(n);

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

describe('GET /orders/:id/invoice money fields', () => {
  it('returns integer cents, never floats', async () => {
    const orderId = await seedOrder([{ sku: 'SKU-1', qty: 3, unitPriceCents: 199 }]);
    if (!orderId) return;
    const res = await fetch(`${base}/orders/${orderId}/invoice`);
    expect(res.status).toBe(200);
    const body = await res.json();
    for (const line of body.lines ?? []) {
      const unit = line.unitPrice ?? line.unitPriceCents;
      const lt = line.lineTotal ?? line.lineTotalCents;
      expect(isInt(unit)).toBe(true);
      expect(isInt(lt)).toBe(true);
    }
    const sub = body.subtotal ?? body.subtotalCents;
    const tot = body.total ?? body.totalCents;
    expect(isInt(sub)).toBe(true);
    expect(isInt(tot)).toBe(true);
  });

  it('computes totals in cents exactly', async () => {
    const orderId = await seedOrder([
      { sku: 'SKU-1', qty: 3, unitPriceCents: 199 },
      { sku: 'SKU-2', qty: 1, unitPriceCents: 45 },
    ]);
    if (!orderId) return;
    const res = await fetch(`${base}/orders/${orderId}/invoice`);
    const body = await res.json();
    const tot = body.total ?? body.totalCents;
    const expected = 3 * 199 + 45 - (body.discount ?? body.discountCents ?? 0);
    expect(tot).toBe(expected);
  });

  it('returns the standard error shape for an unknown order', async () => {
    const res = await fetch(`${base}/orders/no-such-order/invoice`);
    expect([404, 400]).toContain(res.status);
    const body = await res.json();
    expect(body.error ?? body.message).toBeTruthy();
  });
});
