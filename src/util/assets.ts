// Locates the bundled assets/ directory (replaces Go's //go:embed).
// Works both in dev (tsx src/...) and built (dist/cli.js) layouts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function findAssetsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const rel of ['../assets', '../../assets', '../../../assets']) {
    const p = path.resolve(here, rel);
    if (fs.existsSync(path.join(p, 'tools.json'))) return p;
  }
  throw new Error('assets directory not found (looked next to the compiled module)');
}

export const assetsDir: string = findAssetsDir();

export function readAsset(...segments: string[]): string {
  return fs.readFileSync(path.join(assetsDir, ...segments), 'utf8');
}
