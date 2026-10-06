import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import description from './authoring.md' with { type: 'text' };
import { assertReviewed, digest, MAX_BYTES, prepare } from './core.mjs';
import type { PreparedArtifact } from './core.mjs';

interface Preview {
  artifact: PreparedArtifact;
  file: string;
  scope: string;
  receipt?: { method: 'human-inspected'; id: string; rendererHash: string; scope: string };
}

export default function nativeVisualReplies(pi: ExtensionAPI): void {
  // Factory-local, never shared across rebound child-session factories.
  const previews = new Map<string, Preview>();
  let epoch = 0;
  const z = pi.zod;
  const plugin = path.join(import.meta.dir, 'tern');
  const scope = (ctx: ExtensionContext) => ctx.sessionManager.getSessionId();
  async function rendererHash(): Promise<string> {
    const parts = await Promise.all(['plugin.toml', 'host.luau', 'window.luau', 'visual.css'].map(name => fs.readFile(path.join(plugin, name), 'utf8')));
    return digest(JSON.stringify(parts));
  }
  function lookup(id: string, ctx: ExtensionContext): Preview {
    const found = previews.get(id);
    if (!found || found.scope !== scope(ctx)) throw new Error('Preview is not in this session/branch. Preview it again.');
    return found;
  }
  async function unchanged(item: Preview): Promise<string> {
    const hash = await rendererHash();
    if (hash !== item.artifact.rendererHash || (await fs.stat(item.file)).size > MAX_BYTES ||
        await fs.readFile(item.file, 'utf8') !== JSON.stringify(item.artifact)) throw new Error('Preview or renderer changed; preview and inspect again.');
    return hash;
  }
  const reset = () => { previews.clear(); epoch++; };
  pi.on('session_start', reset);
  pi.on('session_switch', reset);
  pi.on('session_branch', reset);
  pi.on('session_tree', reset);
  pi.on('session_shutdown', reset);
  pi.registerTool({
    name: 'visual_preview', label: 'Native visual preview', description,
    parameters: z.object({ json: z.string().describe('Repository snapshot JSON: version, title, root; group children or leaf code/churn values.') }),
    approval: 'write',
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      const generation = epoch;
      const artifact: PreparedArtifact = prepare(params.json, await rendererHash());
      const owner = scope(ctx);
      const dir = path.join(pi.pi.getAgentDir(), 'native-visual-replies', digest(owner));
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, `${artifact.id}.visual.json`);
      const bytes = JSON.stringify(artifact);
      try { await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || (await fs.stat(file)).size > MAX_BYTES || await fs.readFile(file, 'utf8') !== bytes) throw error;
      }
      signal?.throwIfAborted();
      if (scope(ctx) !== owner || epoch !== generation) throw new Error('Session changed during preview');
      previews.set(artifact.id, { artifact, file, scope: owner });
      return { content: [{ type: 'text' as const, text: `STRUCTURAL CHECK ONLY. Open with Native Visual Reply in Tern: ${file}\nInspect Code/Churn, drill/back, keyboard and resize; then run /visual-approve ${artifact.id}.` }],
        details: { id: artifact.id, file, title: artifact.document.title, code: artifact.document.root.code, churn: artifact.document.root.churn } };
    },
    describeResult(result) {
      const d = result.details;
      if (!d) return undefined;
      return { inline: true, head: d.title, body: [{ k: 'kv', p: { items: [
        { k: 'Code', v: String(d.code) }, { k: 'Churn', v: String(d.churn) }, { k: 'Preview', v: d.id.slice(0, 12) },
      ] } }, { k: 'text', p: { text: `Awaiting visual inspection · ${d.file}` } }] };
    },
  });
  pi.registerCommand('visual-approve', {
    description: 'Record your inspection of this exact native preview (manual dogfood gate)',
    async handler(args, ctx) {
      if (ctx.mode !== 'tui') throw new Error('Human approval requires the interactive TUI');
      const item = lookup(args.trim(), ctx);
      const hash = await unchanged(item);
      const approved = await ctx.ui.confirm('Approve inspected Luau preview?', `Only confirm after opening ${item.file} and exercising Code/Churn, drill/back, keyboard and resize. This records a human check, not automated visual evidence.`);
      if (!approved) return;
      if (lookup(item.artifact.id, ctx) !== item || await unchanged(item) !== hash) throw new Error('Preview changed during approval');
      item.receipt = { method: 'human-inspected', id: item.artifact.id, rendererHash: hash, scope: item.scope };
      ctx.ui.notify('Human inspection recorded for this revision.', 'info');
    },
  });
  pi.registerTool({
    name: 'visual_publish', label: 'Publish native visual', description,
    parameters: z.object({ id: z.string().describe('Exact preview id approved by the user through /visual-approve.') }),
    approval: 'write',
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      const item = lookup(params.id, ctx);
      const hash = await unchanged(item);
      if (lookup(params.id, ctx) !== item) throw new Error('Session changed during publication');
      assertReviewed(item.artifact, item.receipt, scope(ctx), hash);
      signal?.throwIfAborted();
      // The ordinary tool result is the persistent transcript record; no second ledger or re-generation.
      return { content: [{ type: 'text' as const, text: `Published local native visual ${item.artifact.id}: ${item.file}\nVerification: human-inspected; automatic Tern verification pending.` }],
        details: { id: item.artifact.id, file: item.file, rendererHash: hash, verification: 'human-inspected' } };
    },
  });
}
