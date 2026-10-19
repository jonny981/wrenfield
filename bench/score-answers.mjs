#!/usr/bin/env node
// Score a set of answers to the question tasks.
//   node bench/score-answers.mjs <answers.json> [--corpus <dir>]
// answers.json maps task id to answer text: { "w01-deploy": "...", ... }.
// A task with no answer fails. Open and held-out tasks are counted apart.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { score, makePathExists, makeShaResolves } from './lib/score.mjs';
import { ROOT, corpusDir } from './lib/corpus.mjs';

const file = process.argv[2];
if (!file || file.startsWith('--')) { console.error('usage: node bench/score-answers.mjs <answers.json> [--corpus <dir>]'); process.exit(2); }
const CORPUS = corpusDir();
const answers = JSON.parse(readFileSync(file, 'utf8'));
const manifest = JSON.parse(readFileSync(join(ROOT, 'bench/manifest.json'), 'utf8'));
const held = new Set(manifest.held_out);
const files = execFileSync('git', ['-C', CORPUS, 'ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
const pathExists = makePathExists(files), shaResolves = makeShaResolves(CORPUS);

const totals = { open: [0, 0], held_out: [0, 0] };
const rows = [];
for (const name of readdirSync(join(ROOT, 'bench/gold')).filter((f) => f.endsWith('.json')).sort()) {
  const id = name.replace(/\.json$/, '');
  const gold = JSON.parse(readFileSync(join(ROOT, 'bench/gold', name), 'utf8'));
  const s = score(gold, String(answers[id] ?? ''), { text: '', items: [] }, pathExists, shaResolves);
  const set = held.has(id) ? 'held_out' : 'open';
  totals[set][0] += s.pass ? 1 : 0; totals[set][1]++;
  rows.push({ id, set, pass: s.pass, detail: s.detail });
}
for (const r of rows) console.log(`${r.pass ? 'pass' : 'fail'}  ${r.set.padEnd(8)}  ${r.id}${r.pass ? '' : `  ${JSON.stringify(r.detail)}`}`);
console.log(`\nopen ${totals.open[0]}/${totals.open[1]}  held_out ${totals.held_out[0]}/${totals.held_out[1]}`);
