#!/usr/bin/env node
// Fixture-check the answer checks themselves: run the real score()
// over bench/answer-fixtures.json. Every 'pass' fixture must score
// pass; every 'fail' fixture — deliberately reversed answers — must
// score fail. Exits non-zero on any disagreement. This is what
// verifies the checks assert direction, not just topic words.
//   node bench/check-answers.mjs [--corpus <dir>]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { score, makePathExists, makeShaResolves } from './lib/score.mjs';
import { ROOT, corpusDir } from './lib/corpus.mjs';

const BENCH = join(ROOT, 'bench');
const CORPUS = corpusDir();

const FILE_INDEX = execFileSync('git', ['-C', CORPUS, 'ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
const pathExists = makePathExists(FILE_INDEX);
const shaResolves = makeShaResolves(CORPUS);

const fixtures = JSON.parse(readFileSync(join(BENCH, 'answer-fixtures.json'), 'utf8'));
let bad = 0, n = 0;
for (const [id, fx] of Object.entries(fixtures)) {
  if (id.startsWith('_')) continue;
  const gold = JSON.parse(readFileSync(join(BENCH, 'gold', `${id}.json`), 'utf8'));
  const ctx = { text: '', items: [] }; // pass/fail is decided on the answer alone
  for (const a of fx.pass ?? []) {
    n++;
    const s = score(gold, a, ctx, pathExists, shaResolves);
    if (!s.pass) { bad++; console.log(`FAIL-EXPECTED-PASS ${id}: ${JSON.stringify(s.detail)}\n  ${a.slice(0, 110)}`); }
  }
  for (const a of fx.fail ?? []) {
    n++;
    const s = score(gold, a, ctx, pathExists, shaResolves);
    if (s.pass) { bad++; console.log(`PASS-EXPECTED-FAIL ${id}: reversed answer accepted\n  ${a.slice(0, 110)}`); }
  }
}
console.log(bad ? `${bad} fixture disagreement(s) over ${n} checks` : `answer checks ok: ${n} fixtures, all scored as expected`);
process.exit(bad ? 1 : 0);
