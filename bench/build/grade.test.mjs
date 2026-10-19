// Tests for the build grader and the hidden tests it runs. Uses real git
// repositories and stub servers in temporary folders; calls no model.
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gradeRun } from './grade.mjs';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const tmpDirs = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'grade-test-')); tmpDirs.push(d); return d; };

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe('grading', () => {
  it('scores 0 when the hidden tests fail', async () => {
    const rubric = {
      task: 'x',
      blockers: [
        { id: 'hidden-tests-pass', check: 'npm test with hidden.test.ts dropped in' },
        { id: 'no-delete-from', check: "grep -rn 'DELETE FROM' src/store/ src/routes/ returns nothing" },
      ],
      quality: [{ id: 'q1', check: 'a judgement call, not a grep' }],
    };
    const g = await gradeRun({
      copyDir: '/nonexistent',
      rubric,
      runSuite: async () => ({ pass: false, tail: 'FAIL src/hidden.test.ts' }),
      gitAdded: async () => [],
    });
    expect(g.score).toBe(0);
    expect(g.blockers.find((b) => b.id === 'hidden-tests-pass').verdict).toBe('fail');
    expect(g.blockers.find((b) => b.id === 'no-delete-from').verdict).toBe('pass');
    expect(g.quality[0].verdict).toBe('needs-reader');
  });

  it('leaves the score pending while a blocker still needs a reader', async () => {
    const rubric = {
      task: 'x',
      blockers: [
        { id: 'hidden-tests-pass', check: 'npm test with hidden.test.ts dropped in' },
        { id: 'sort-whitelist', check: 'sort param rejects unknown fields — a judgement call' },
      ],
      quality: [],
    };
    const g = await gradeRun({
      copyDir: '/nonexistent',
      rubric,
      runSuite: async () => ({ pass: true, tail: '' }),
      gitAdded: async () => [],
    });
    expect(g.score).toBeNull();
    expect(g.needsReader).toEqual(['sort-whitelist']);
  });

  // b2 graded key-required "fail" while its own test passed, because every
  // delegated check took the whole suite's verdict
  it('gives a check delegated to the hidden tests the verdict of its own test, not the whole suite', async () => {
    const rubric = {
      task: 'x',
      blockers: [
        { id: 'key-required', check: 'the 400 is asserted by hidden tests', test: 'rejects a mutation without an Idempotency-Key' },
        { id: 'replay-not-duplicate', check: 'one row written (asserted by hidden tests)', test: 'replays the same key instead of double-applying' },
      ],
      quality: [],
    };
    const g = await gradeRun({
      copyDir: '/nonexistent',
      rubric,
      runSuite: async () => ({
        pass: false,
        tail: 'FAIL replays the same key instead of double-applying',
        tests: {
          'rejects a mutation without an Idempotency-Key': { pass: true, detail: '' },
          'replays the same key instead of double-applying': { pass: false, detail: 'expected 2 to be 1' },
        },
      }),
      gitAdded: async () => [],
    });
    expect(g.blockers.map((b) => [b.id, b.verdict])).toEqual([['key-required', 'pass'], ['replay-not-duplicate', 'fail']]);
    expect(g.blockers[1].detail).toContain('expected 2 to be 1');
  });

  it('fails a delegated check whose test never ran', async () => {
    const rubric = { task: 'x', blockers: [{ id: 'field-units', check: '(asserted by hidden tests)', test: 'returns integer cents, never floats' }], quality: [] };
    const g = await gradeRun({
      copyDir: '/nonexistent',
      rubric,
      runSuite: async () => ({ pass: false, tail: 'npm run build failed', tests: {} }),
      gitAdded: async () => [],
    });
    expect(g.blockers[0].verdict).toBe('fail');
    expect(g.blockers[0].detail).toContain('did not run');
  });

  it('refuses a delegated check that names no test, instead of reading the whole suite', async () => {
    const rubric = { task: 'x', blockers: [{ id: 'field-units', check: 'money fields are integers (asserted by hidden tests)' }], quality: [] };
    await expect(gradeRun({
      copyDir: '/nonexistent',
      rubric,
      runSuite: async () => ({ pass: true, tail: '', tests: {} }),
      gitAdded: async () => [],
    })).rejects.toThrow(/field-units.*names no/);
  });

  it('every delegated check in the task rubrics names a test its hidden test file has', () => {
    const bench = join(REPO, 'bench', 'build');
    const tasks = readdirSync(bench).filter((t) => existsSync(join(bench, t, 'rubric.json')));
    expect(tasks.length).toBe(6);
    let delegated = 0;
    for (const task of tasks) {
      const rubric = JSON.parse(readFileSync(join(bench, task, 'rubric.json'), 'utf8'));
      const titles = [...readFileSync(join(bench, task, 'hidden.test.ts'), 'utf8').matchAll(/\bit\((['"`])(.*?)\1/g)].map((m) => m[2]);
      for (const c of [...rubric.blockers, ...rubric.quality].filter((c) => /asserted by hidden tests/i.test(c.check))) {
        delegated++;
        expect(titles, `${task} ${c.id}`).toContain(c.test);
      }
    }
    expect(delegated).toBe(5);
  });

  it('fails a grep blocker when added lines match the banned pattern', async () => {
    const rubric = {
      task: 'x',
      blockers: [{ id: 'no-delete-from', check: "grep -rn 'DELETE FROM' src/store/ src/routes/ returns nothing" }],
      quality: [],
    };
    const excludes = [];
    const g = await gradeRun({
      copyDir: '/nonexistent',
      rubric,
      runSuite: async () => ({ pass: true, tail: '' }),
      gitAdded: async (paths, exclude) => { excludes.push(...exclude); return [{ file: 'src/store/products.ts', line: 'db.exec("DELETE FROM products")' }]; },
    });
    expect(g.blockers[0].verdict).toBe('fail');
    expect(g.score).toBe(0);
    // the dropped hidden test carries the banned patterns itself; it is never part of the change
    expect(excludes).toContain('hidden.test.ts');
  });
});

// A stub build: dist/index.js answers the requests a task's hidden test
// makes. The copy's node_modules is a link to the repo's so the dropped test
// file resolves vitest (and the app's own dependencies) as a graded run does.
// `prepare` shapes the copy further (a git base, source files) before the run.
const stubSuite = (task, serverJs, prepare) => {
  const dir = tmp();
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'stub-build', type: 'module' }));
  writeFileSync(join(dir, 'dist', 'index.js'), serverJs);
  prepare?.(dir);
  symlinkSync(join(REPO, 'node_modules'), join(dir, 'node_modules'));
  copyFileSync(join(REPO, 'bench', 'build', task, 'hidden.test.ts'), join(dir, 'hidden.test.ts'));
  const res = spawnSync(process.execPath, [join(REPO, 'node_modules', 'vitest', 'vitest.mjs'), 'run', 'hidden.test.ts'],
    { cwd: dir, encoding: 'utf8', timeout: 120_000 });
  return { ...res, diag: res.stdout + res.stderr };
};

describe('the b5 hidden test', () => {
  // the stub answers POST /orders with a 4xx and a body the test must judge
  const hiddenSuite = (orderBody) => stubSuite('b5-error-surface', `import { createServer } from 'node:http';
const ORDER_BODY = ${JSON.stringify(JSON.stringify(orderBody))};
createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health') { res.end('{"status":"ok"}'); return; }
    res.statusCode = 404;
    res.end(req.method === 'POST' && req.url === '/orders' ? ORDER_BODY : '{"error":"not_found","message":"not found"}');
  });
}).listen(Number(process.env.PORT));
setTimeout(() => process.exit(0), 120_000); // backstop so a crashed suite cannot orphan the stub
`);

  it('rejects a body that carries the code under "code" instead of "error"', () => {
    const res = hiddenSuite({ code: 'unknown_customer', message: 'no such customer' });
    expect(res.status, res.diag).not.toBe(0);
    // a real assertion tripped on the standard-body test — not a wiring failure
    expect(res.diag).toContain('standard error body');
    expect(res.diag).toContain('AssertionError');
  }, 120_000);

  it('accepts the {error, message} body the errorHandler writes', () => {
    const res = hiddenSuite({ error: 'unknown_customer', message: 'no such customer' });
    expect(res.status, res.diag).toBe(0);
  }, 120_000);
});

describe('the b1 hidden test', () => {
  // the stub lists the seeded rows in the app's real item shape (sku, not id)
  // and returns the last sku as nextCursor whenever a full page leaves rows
  // behind it. `cap` is how far limit can reach (rule 20's maximum is 200);
  // `paginate` off answers nextCursor:null like a build that never cursors.
  const b1Suite = (cap, paginate = true) => stubSuite('b1-products-list', `import { createServer } from 'node:http';
import Database from 'better-sqlite3';
const db = new Database(process.env.DB_FILE);
db.exec('create table if not exists products (sku text primary key, name text, unit_price_cents integer, active integer, deleted_at text)');
createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    const u = new URL(req.url ?? '/', 'http://localhost');
    if (u.pathname === '/health') { res.end('{"status":"ok"}'); return; }
    if (u.pathname === '/products' && req.method === 'GET') {
      const want = Number(u.searchParams.get('limit')) || 50;
      const lim = Math.min(want, ${cap});
      const rows = db.prepare("select sku, name, unit_price_cents as unitPriceCents, active from products where deleted_at is null and sku > coalesce(?, '') order by sku limit ?")
        .all(u.searchParams.get('cursor'), Number.isFinite(lim) ? lim + 1 : -1);
      const items = rows.slice(0, lim).map((r) => ({ ...r, active: !!r.active }));
      const nextCursor = ${paginate} && rows.length > lim ? items[items.length - 1].sku : null;
      res.end(JSON.stringify({ items, nextCursor }));
      return;
    }
    res.statusCode = 404;
    res.end('{"error":"not_found","message":"not found"}');
  });
}).listen(Number(process.env.PORT));
setTimeout(() => process.exit(0), 120_000);
`);

  it('rejects a list endpoint with no hard cap — seeded rows give the check teeth', () => {
    const res = b1Suite(Infinity);
    expect(res.status, res.diag).not.toBe(0);
    expect(res.diag).toContain('caps or rejects an oversized limit');
  }, 120_000);

  it('rejects an endpoint that never returns a cursor — 250 rows cannot be one page', () => {
    const res = b1Suite(200, false);
    expect(res.status, res.diag).not.toBe(0);
    expect(res.diag).toContain('follows the cursor');
  }, 120_000);

  it('accepts a list endpoint capped at 200', () => {
    const res = b1Suite(200);
    expect(res.status, res.diag).toBe(0);
  }, 120_000);
});

describe('the b2 hidden test', () => {
  // A stateful stub of the refunds endpoint. Orders move draft -> placed ->
  // paid as in the repository. `paidOnly` refunds only paid orders (the
  // repository's own rule), `field` names the amount in refund rows,
  // `doubleApply` writes a second row when a key is replayed (answering with
  // the original id when `replayId`), and `ids` off drops the refund id.
  const b2Suite = ({ paidOnly = false, field = 'amount', doubleApply = false, replayId = true, ids = true } = {}) => stubSuite('b2-mutation-idempotency', `import { createServer } from 'node:http';
const status = new Map(); const refunds = new Map(); const seen = new Map(); let n = 0;
createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    const send = (code, obj) => { res.statusCode = code; res.end(JSON.stringify(obj)); };
    const p = new URL(req.url ?? '/', 'http://localhost').pathname.split('/');
    if (p[1] === 'health') return send(200, { status: 'ok' });
    if (req.method === 'POST' && p[1] === 'orders' && p.length === 2) { const id = 'ord_' + (++n); status.set(id, 'draft'); refunds.set(id, []); return send(201, { id }); }
    const id = p[2];
    if (p[1] !== 'orders' || !status.has(id)) return send(404, { error: 'order_not_found', message: 'no such order' });
    if (req.method === 'POST' && p[3] === 'place') { status.set(id, 'placed'); return send(200, { id }); }
    if (req.method === 'PATCH' && p.length === 3) { status.set(id, JSON.parse(body).status); return send(200, { id }); }
    if (p[3] === 'refunds' && req.method === 'GET') return send(200, refunds.get(id));
    if (p[3] === 'refunds' && req.method === 'POST') {
      const key = req.headers['idempotency-key'];
      if (!key) return send(400, { error: 'idempotency_key_required', message: 'Idempotency-Key required' });
      if (${paidOnly} && status.get(id) !== 'paid') return send(409, { error: 'order_not_refundable', message: 'only paid orders can be refunded' });
      const prior = seen.get(key);
      if (prior && !${doubleApply}) return send(200, prior);
      const row = { ${ids ? "id: prior && " + replayId + " ? prior.id : 'ref_' + (++n), " : ''}${field}: JSON.parse(body).amount };
      refunds.get(id).unshift(row);
      seen.set(key, prior ?? row);
      return send(prior ? 200 : 201, row);
    }
    send(404, { error: 'not_found', message: 'not found' });
  });
}).listen(Number(process.env.PORT));
setTimeout(() => process.exit(0), 120_000); // backstop so a crashed suite cannot orphan the stub
`);

  it('accepts a build that refunds only paid orders and names the field amountCents', () => {
    const res = b2Suite({ paidOnly: true, field: 'amountCents' });
    expect(res.status, res.diag).toBe(0);
  }, 120_000);

  it('accepts a build that refunds any live order and names the field amount', () => {
    const res = b2Suite();
    expect(res.status, res.diag).toBe(0);
  }, 120_000);

  it('rejects a replay that writes a second refund row under the original id', () => {
    const res = b2Suite({ field: 'amountCents', doubleApply: true });
    expect(res.status, res.diag).not.toBe(0);
    expect(res.diag).toContain('replays the same key');
    // the row count caught it: two rows carry the 200, not zero
    expect(res.diag).toContain('expected 2 to be 1');
  }, 120_000);

  it('rejects a replay that records a new refund', () => {
    const res = b2Suite({ field: 'amountCents', doubleApply: true, replayId: false });
    expect(res.status, res.diag).not.toBe(0);
    expect(res.diag).toContain('replays the same key');
  }, 120_000);

  it('rejects a refunds endpoint that returns no refund id to compare', () => {
    const res = b2Suite({ ids: false });
    expect(res.status, res.diag).not.toBe(0);
    expect(res.diag).toContain('replays the same key');
  }, 120_000);
});

describe('the b4 hidden test', () => {
  // A git repository whose HEAD is the build commit's shape: src/config.ts
  // plus src/log.ts and src/store/db.ts, which already read process.env
  // there. The build then adds SLOW_MS to the config module, and `edit`
  // changes the working tree further, as a builder would.
  const b4Suite = (edit) => stubSuite('b4-env-config', `import { createServer } from 'node:http';
createServer((req, res) => { req.resume(); res.setHeader('content-type', 'application/json'); res.end('{"status":"ok"}'); }).listen(Number(process.env.PORT));
setTimeout(() => process.exit(0), 120_000);
`, (dir) => {
    mkdirSync(join(dir, 'src', 'store'), { recursive: true });
    mkdirSync(join(dir, 'src', 'http'), { recursive: true });
    writeFileSync(join(dir, 'src', 'config.ts'), 'export const config = { port: Number(process.env.PORT ?? 3000) };\n');
    writeFileSync(join(dir, 'src', 'log.ts'), "export const level = process.env.LOG_LEVEL ?? 'info';\n");
    writeFileSync(join(dir, 'src', 'store', 'db.ts'), "export const file = process.env.DB_FILE ?? 'data/orders.db';\n");
    execFileSync('git', ['init', '-q', dir]);
    execFileSync('git', ['-C', dir, 'add', '-A']);
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base']);
    writeFileSync(join(dir, 'src', 'config.ts'), 'export const config = { port: Number(process.env.PORT ?? 3000), slowMs: Number(process.env.SLOW_MS ?? 500) };\n');
    edit?.(dir);
  });

  it('accepts the process.env reads the build commit already had', () => {
    const res = b4Suite();
    expect(res.status, res.diag).toBe(0);
  }, 120_000);

  it('rejects a new process.env read outside src/config.ts', () => {
    const res = b4Suite((dir) => writeFileSync(join(dir, 'src', 'http', 'requestLog.ts'),
      'export const slowMs = Number(process.env.SLOW_MS ?? 500);\n'));
    expect(res.status, res.diag).not.toBe(0);
    expect(res.diag).toContain('src/http/requestLog.ts reads process.env directly');
  }, 120_000);

  it('rejects a new read added to a file that already had one', () => {
    const res = b4Suite((dir) => writeFileSync(join(dir, 'src', 'log.ts'),
      "export const level = process.env.LOG_LEVEL ?? 'info';\nexport const slowMs = Number(process.env.SLOW_MS ?? 500);\n"));
    expect(res.status, res.diag).not.toBe(0);
    expect(res.diag).toContain('src/log.ts reads process.env directly');
  }, 120_000);
});

describe('new code for a grep check', () => {
  // b3's no-float-money blocker, read from the real rubric, against a real
  // repository whose base file already uses toFixed in the display formatter
  // (src/domain/money.ts does at the build commit)
  const noFloat = JSON.parse(readFileSync(join(REPO, 'bench', 'build', 'b3-money-cents', 'rubric.json'), 'utf8'))
    .blockers.find((b) => b.id === 'no-float-money');
  const FORMAT = 'export function formatCents(c: number): string {\n  return `£${(c / 100).toFixed(2)}`;\n}\n';
  // longer than FORMAT, so a diff of the two swapped keeps this one and shows
  // FORMAT removed and added again, as b3's build diff did
  const ROUND = 'export function roundHalfUp(n: number): number {\n  const whole = Math.floor(n);\n  const frac = n - whole;\n  return frac >= 0.5 ? whole + 1 : whole;\n}\n';
  const BASE = `export type Cents = number;\n\n${FORMAT}\n${ROUND}`;
  const grade = async (after, extra = {}) => {
    const dir = tmp();
    mkdirSync(join(dir, 'src', 'domain'), { recursive: true });
    writeFileSync(join(dir, 'src', 'domain', 'money.ts'), BASE);
    execFileSync('git', ['init', '-q', dir]);
    execFileSync('git', ['-C', dir, 'add', '-A']);
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base']);
    writeFileSync(join(dir, 'src', 'domain', 'money.ts'), after);
    for (const [f, text] of Object.entries(extra)) writeFileSync(join(dir, f), text);
    const g = await gradeRun({ copyDir: dir, rubric: { task: 'x', blockers: [noFloat], quality: [] }, runSuite: async () => ({ pass: true, tail: '', tests: {} }) });
    return g.blockers[0];
  };

  it('does not count a line moved within its file as new code', async () => {
    const check = await grade(`export type Cents = number;\n\n${ROUND}\n${FORMAT}`);
    expect(check.verdict, check.detail).toBe('pass');
  });

  it('fails float money in a new line of a changed file', async () => {
    const check = await grade(`${BASE}\nexport const toPounds = (c: number) => parseFloat((c / 100).toFixed(2));\n`);
    expect(check.verdict).toBe('fail');
    expect(check.detail).toContain('src/domain/money.ts: export const toPounds');
  });

  it('fails a second copy of a float line the base file had once', async () => {
    const check = await grade(`${BASE}\n${FORMAT.replace('formatCents', 'formatTotal')}`);
    expect(check.verdict).toBe('fail');
    expect(check.detail).toContain('toFixed');
  });

  it('fails float money in a new file', async () => {
    const check = await grade(BASE, { 'src/domain/invoice.ts': 'export const pounds = (c: number) => (c / 100).toFixed(2);\n' });
    expect(check.verdict).toBe('fail');
    expect(check.detail).toContain('src/domain/invoice.ts');
  });
});

describe('test files in a grep check', () => {
  // b1's no-offset blocker, read from the real rubric. A b1 build was once
  // scored 0 by its own test asserting that `?offset=50` is refused with 400:
  // the banned text inside a test that enforces the rule.
  const noOffset = JSON.parse(readFileSync(join(REPO, 'bench', 'build', 'b1-products-list', 'rubric.json'), 'utf8'))
    .blockers.find((b) => b.id === 'no-offset');
  const STORE = "export function listProducts(db, limit, cursor) {\n  return db.prepare('select * from products where sku > ? order by sku limit ?').all(cursor ?? '', limit);\n}\n";
  const grade = async (files) => {
    const dir = tmp();
    mkdirSync(join(dir, 'src', 'store'), { recursive: true });
    writeFileSync(join(dir, 'src', 'store', 'products.ts'), STORE);
    execFileSync('git', ['init', '-q', dir]);
    execFileSync('git', ['-C', dir, 'add', '-A']);
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base']);
    for (const [f, text] of Object.entries(files)) {
      mkdirSync(join(dir, f, '..'), { recursive: true });
      writeFileSync(join(dir, f), text);
    }
    const g = await gradeRun({ copyDir: dir, rubric: { task: 'x', blockers: [noOffset], quality: [] }, runSuite: async () => ({ pass: true, tail: '', tests: {} }) });
    return g.blockers[0];
  };

  it('does not read a *.test.ts file', async () => {
    const check = await grade({ 'src/routes/products.test.ts': "expect((await get('?offset=50')).status).toBe(400);\n" });
    expect(check.verdict, check.detail).toBe('pass');
  });

  it('does not read files under a tests/ or test/ folder', async () => {
    const check = await grade({
      'src/store/tests/seed.ts': "export const legacy = 'select * from products limit 10 OFFSET 20';\n",
      'src/routes/test/fixtures.ts': "export const oldUrl = '/products?offset=20';\n",
    });
    expect(check.verdict, check.detail).toBe('pass');
  });

  it('still fails offset code in a source file', async () => {
    const check = await grade({
      'src/routes/products.test.ts': "expect((await get('?offset=50')).status).toBe(400);\n",
      'src/store/products.ts': STORE.replace('order by sku limit ?', 'order by sku limit ? OFFSET ?'),
    });
    expect(check.verdict).toBe('fail');
    expect(check.detail).toContain('src/store/products.ts');
    expect(check.detail).not.toContain('products.test.ts');
  });
});

describe('the default suite', () => {
  it('reads each hidden test\'s own verdict from the run', async () => {
    const copyDir = tmp();
    const taskDir = tmp();
    const runDir = tmp();
    writeFileSync(join(copyDir, 'package.json'), JSON.stringify({ name: 'stub-build', type: 'module', scripts: { build: 'node -e 0', test: 'vitest run' } }));
    symlinkSync(join(REPO, 'node_modules'), join(copyDir, 'node_modules'));
    writeFileSync(join(taskDir, 'hidden.test.ts'), "import { it, expect } from 'vitest';\nit('holds', () => expect(1).toBe(1));\nit('breaks', () => expect(1).toBe(2));\n");
    const rubric = {
      task: 'x',
      blockers: [
        { id: 'hidden-tests-pass', check: 'npm test with hidden.test.ts dropped in' },
        { id: 'a', check: 'one thing (asserted by hidden tests)', test: 'holds' },
        { id: 'b', check: 'another (asserted by hidden tests)', test: 'breaks' },
      ],
      quality: [],
    };
    const g = await gradeRun({ copyDir, taskDir, runDir, rubric });
    expect(g.blockers.map((b) => [b.id, b.verdict])).toEqual([['hidden-tests-pass', 'fail'], ['a', 'pass'], ['b', 'fail']]);
    expect(g.blockers[2].detail).toContain('expected 1 to be 2');
    expect(existsSync(join(copyDir, 'hidden.test.ts'))).toBe(false);
  }, 120_000);
});
