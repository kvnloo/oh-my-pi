// Test-only adapter: strip TS, emulate Bun's text import/import.meta.dir, instrument filesystem awaits.
// Does not emulate the OMP runtime, renderer, or permission system.
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'node:fs/promises' && context.parentURL?.endsWith('/extension.ts')) {
      return { url: new URL('./extension-io.mjs', import.meta.url).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith('/extension.ts')) {
      const file = fileURLToPath(url);
      const source = fs.readFileSync(file, 'utf8').replaceAll('import.meta.dir', JSON.stringify(path.dirname(file)));
      return { format: 'module', source: stripTypeScriptTypes(source), shortCircuit: true };
    }
    if (url.endsWith('/authoring.md')) {
      return { format: 'module', source: `export default ${JSON.stringify(fs.readFileSync(fileURLToPath(url), 'utf8'))}`, shortCircuit: true };
    }
    return next(url, context);
  },
});
