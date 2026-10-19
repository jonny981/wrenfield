#!/usr/bin/env node
// Dataset self-check: every task has gold, gold commits resolve in the
// corpus, gold paths exist at the corpus HEAD, exactly 10 held out, ids unique.
//   node bench/check.mjs [--corpus <dir>]
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, corpusDir } from './lib/corpus.mjs';

const CORPUS = corpusDir();
const tasks = readdirSync(join(ROOT, 'bench/tasks')).filter(f => f.endsWith('.md'));
const golds = readdirSync(join(ROOT, 'bench/gold')).filter(f => f.endsWith('.json'));
const manifest = JSON.parse(readFileSync(join(ROOT, 'bench/manifest.json'), 'utf8'));
const errs = [];

const head = execFileSync('git', ['-C', CORPUS, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (!head.startsWith(manifest.repo_rev)) errs.push(`corpus HEAD ${head} is not the manifest's repo_rev ${manifest.repo_rev}`);

const ids = new Set(); let held = 0;
for (const t of tasks) {
  const id = t.replace(/\.md$/, '');
  ids.add(id);
  const text = readFileSync(join(ROOT, 'bench/tasks', t), 'utf8');
  if (/held_out:\s*true/.test(text)) held++;
  if (!existsSync(join(ROOT, 'bench/gold', id + '.json'))) errs.push(`${id}: no gold file`);
}
for (const g of golds) {
  const id = g.replace(/\.json$/, '');
  const gold = JSON.parse(readFileSync(join(ROOT, 'bench/gold', g), 'utf8'));
  if (!ids.has(id)) errs.push(`${id}: gold without task`);
  for (const sha of gold.gold.commits) {
    try { execFileSync('git', ['-C', CORPUS, 'cat-file', '-t', sha], { stdio: 'pipe' }); }
    catch { errs.push(`${id}: commit ${sha} does not resolve`); }
  }
  for (const p of gold.gold.paths) {
    if (!existsSync(join(CORPUS, p))) errs.push(`${id}: path ${p} missing`);
  }
}
if (held !== 10) errs.push(`held_out count ${held}, expected 10`);
if (tasks.length !== 40) errs.push(`task count ${tasks.length}, expected 40`);
if (errs.length) { console.error(errs.join('\n')); process.exit(1); }
console.log(`bench ok: ${tasks.length} tasks, ${golds.length} golds, ${held} held out, corpus at ${head.slice(0, 7)}`);
