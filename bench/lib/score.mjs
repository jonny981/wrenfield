// Shared scoring for the Wrenfield memory bench.
// score() is pure: gold check + answer text + the context items a
// policy actually delivered. Retrieval metrics are computed from
// delivered item identities (commit:<sha> / path:<relpath>), not from
// identifiers merely mentioned in context text. Mention counts are
// still reported separately as gold_mention_*.
import { execFileSync } from 'node:child_process';

export const pathTokens = (a) =>
  a.match(/[\w@.-]+\.\w{1,5}\b|[\w@.-]+\/[\w@./-]+|\b[A-Za-z]+file\b/gi) ?? [];
export const shaTokens = (a) => a.match(/\b[0-9a-f]{7,40}\b/g) ?? [];

export const makePathExists = (fileIndex) => (t) =>
  fileIndex.includes(t) ||
  fileIndex.some(f => f === t || f.endsWith('/' + t) || f.split('/').pop()?.split('.')[0] === t);

export const makeShaResolves = (corpus) => (t) => {
  try { execFileSync('git', ['-C', corpus, 'cat-file', '-t', t], { stdio: 'pipe' }); return true; }
  catch { return false; }
};

// A delivered item's identity: commit sha or repo-relative path.
const itemHitsGold = (key, gold) => {
  const commits = gold.commits ?? [], paths = gold.paths ?? [];
  if (key.startsWith('commit:')) {
    const sha = key.slice(7);
    return commits.some(g => sha.startsWith(g) || g.startsWith(sha));
  }
  const p = key.slice(5);
  return paths.some(g => g === p || g.endsWith('/' + p) || p.endsWith('/' + g));
};

const coveredGolds = (items, gold) => {
  const commits = gold.commits ?? [], paths = gold.paths ?? [];
  const hit = new Set();
  for (const it of items) {
    if (it.key.startsWith('commit:')) {
      const sha = it.key.slice(7);
      for (const g of commits) if (sha.startsWith(g) || g.startsWith(sha)) hit.add('commit:' + g);
    } else {
      const p = it.key.slice(5);
      for (const g of paths) if (g === p || g.endsWith('/' + p) || p.endsWith('/' + g)) hit.add('path:' + g);
    }
  }
  return hit;
};

// ctx: { text: string, items: [{key,id,text}] }
export function score(gold, answer, ctx, pathExists, shaResolves) {
  const chk = gold.check ?? {};
  const must = (chk.must_mention ?? []).map(group => group.some(p => new RegExp(p, 'i').test(answer)));
  const forbid = (chk.forbid_mention ?? []).filter(p => new RegExp(p, 'i').test(answer));
  const paths = pathTokens(answer), shas = shaTokens(answer);
  const citePath = (chk.cite_path ?? []).map(p => paths.some(t => new RegExp(p, 'i').test(t) && pathExists(t)));
  const citeCommit = (chk.cite_commit ?? []).map(p => shas.some(t => new RegExp(p, 'i').test(t) && shaResolves(t)));
  const pass = must.every(Boolean) && forbid.length === 0 && citePath.every(Boolean) && citeCommit.every(Boolean);

  const items = ctx.items ?? [];
  const goldTotal = (gold.gold?.commits?.length ?? 0) + (gold.gold?.paths?.length ?? 0);
  const hit = coveredGolds(items, gold.gold ?? {});
  const hitItems = items.filter(i => itemHitsGold(i.key, gold.gold ?? {})).length;

  // mention-only metric: gold identifiers appearing anywhere in ctx text
  const text = ctx.text ?? '';
  const mHits = (gold.gold?.commits ?? []).filter(s => text.includes(s)).length +
    (gold.gold?.paths ?? []).filter(p => text.includes(p) || text.includes(p.split('/').pop())).length;

  return {
    pass,
    detail: { must: must.every(Boolean), forbid_violations: forbid, cite_path: citePath.every(Boolean), cite_commit: citeCommit.every(Boolean) },
    gold_hits: hit.size, gold_total: goldTotal,
    gold_recall: goldTotal ? +(hit.size / goldTotal).toFixed(3) : null,
    gold_precision: items.length ? +(hitItems / items.length).toFixed(3) : null,
    gold_mention_recall: goldTotal ? +(mHits / goldTotal).toFixed(3) : null,
    ctx_chars: text.length, ctx_items: items.length,
  };
}
