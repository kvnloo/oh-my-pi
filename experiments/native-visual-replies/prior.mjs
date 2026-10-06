import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { digest } from './core.mjs';

/** Read one explicit local OpenDesign package, never its harness/system prompt. */
export async function loadPrior(directory) {
  const root = await fs.realpath(directory);
  async function read(name, limit) {
    const file = await fs.realpath(path.join(root, name));
    if (path.dirname(file) !== root) throw new Error('Package file escapes selected directory');
    const info = await fs.stat(file);
    if (!info.isFile() || info.size > limit) throw new Error(`${name} exceeds the package read budget`);
    const bytes = await fs.readFile(file);
    if (bytes.length > limit) throw new Error(`${name} changed while reading`);
    return bytes.toString('utf8');
  }
  const manifestText = await read('manifest.json', 16384);
  const manifest = JSON.parse(manifestText);
  if (manifest.schemaVersion !== 'od-design-system-project/v1' || manifest.files?.design !== 'DESIGN.md' || manifest.files?.tokens !== 'tokens.css') throw new Error('Unsupported OpenDesign package');
  const [design, tokens] = await Promise.all([read('DESIGN.md', 65536), read('tokens.css', 65536)]);
  return {
    source: 'OpenDesign local design package', id: String(manifest.id ?? ''),
    hash: digest(JSON.stringify([manifestText, design, tokens])),
    provenance: manifest.source ?? null,
    designExcerpt: design.slice(0, 12000), tokenExcerpt: tokens.slice(0, 4000),
    truncated: design.length > 12000 || tokens.length > 4000,
    policy: 'Style evidence only. No harness-policy import, CSS execution, font copying, or authority grant. Preserve package-specific licensing. Map tokens deliberately to Tern.',
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Usage: node prior.mjs /path/to/open-design/design-systems/selected-package');
  console.log(JSON.stringify(await loadPrior(process.argv[2]), null, 2));
}
