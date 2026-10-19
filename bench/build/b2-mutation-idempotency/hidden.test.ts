// Hidden tests for b2-mutation-idempotency — encode rule 18.
// Spawns the built app; asserts the Idempotency-Key contract.
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

const seedOrder = async () => {
  const r = await fetch(`${base}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
    body: JSON.stringify({ customerId: 'cust-hidden-1', lines: [{ sku: 'SKU-1', qty: 2, unitPriceCents: 500 }] }),
  });
  if (r.status === 201 || r.status === 200) return (await r.json()).id;
  return null;
};

// The repository refunds only orders that took payment
// (handbook/api/orders-refund.md; src/routes/orders.ts answers "only paid
// orders can be refunded"), and a new order starts as draft. So the order is
// placed and paid before any refund: a build that keeps that rule must not
// fail for it. Each step sends its own Idempotency-Key in case the build
// requires one on every mutation (rule 18).
const seedPaidOrder = async () => {
  const id = await seedOrder();
  if (!id) return null;
  const placed = await fetch(`${base}/orders/${id}/place`, {
    method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() },
  });
  const paid = await fetch(`${base}/orders/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
    body: JSON.stringify({ status: 'paid' }),
  });
  return placed.ok && paid.ok ? id : null;
};

// The repository names money fields in cents (unitPriceCents, totalCents), so
// a refund row may carry the amount as `amountCents` instead of `amount`.
const amountOf = (r: { amount?: number; amountCents?: number }) => r.amount ?? r.amountCents;

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

describe('POST /orders/:id/refunds idempotency', () => {
  it('rejects a mutation without an Idempotency-Key', async () => {
    const orderId = await seedPaidOrder();
    expect(orderId, 'create, place and pay an order').toBeTruthy();
    const res = await fetch(`${base}/orders/${orderId}/refunds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: 200 }),
    });
    expect([400, 422]).toContain(res.status);
  });

  it('replays the same key instead of double-applying', async () => {
    const orderId = await seedPaidOrder();
    expect(orderId, 'create, place and pay an order').toBeTruthy();
    const key = crypto.randomUUID();
    const req = () => fetch(`${base}/orders/${orderId}/refunds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ amount: 200 }),
    });
    const r1 = await req();
    expect([200, 201]).toContain(r1.status);
    const r2 = await req();
    expect([200, 201]).toContain(r2.status);
    const b1 = await r1.json();
    const b2 = await r2.json();
    expect(b1.id).toBeTruthy();
    expect(b2.id).toBe(b1.id);
    const list = await fetch(`${base}/orders/${orderId}/refunds`);
    const refunds = await list.json();
    const rows = Array.isArray(refunds) ? refunds : refunds.items;
    expect(rows.filter((r: { amount?: number; amountCents?: number }) => amountOf(r) === 200).length).toBe(1);
  });

  it('fails cleanly on an unknown order', async () => {
    const res = await fetch(`${base}/orders/no-such-order/refunds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ amount: 200 }),
    });
    expect([400, 404, 409, 422]).toContain(res.status);
    const body = await res.json();
    expect(body.error ?? body.message).toBeTruthy();
  });
});
