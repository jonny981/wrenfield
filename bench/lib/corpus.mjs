// Where the corpus checkout lives: --corpus <dir>, else corpus/wrenfield at
// the repository root (`npm run corpus` clones it from the bundle).
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const corpusDir = (argv = process.argv) => {
  const i = argv.indexOf('--corpus');
  return i >= 0 ? resolve(argv[i + 1]) : join(ROOT, 'corpus', 'wrenfield');
};
