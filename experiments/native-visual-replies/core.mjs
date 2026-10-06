import { createHash } from 'node:crypto';

export const MAX_BYTES = 8 * 1024 * 1024;
export const MAX_NODES = 60_000;
export const MAX_DEPTH = 16;
export const VISIBLE_LIMIT = 128;
const MAX_VALUE = 1_000_000_000_000;
export const digest = value => createHash('sha256').update(value).digest('hex');
const fail = message => { throw new Error(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function keys(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('Unexpected fields');
}
function label(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 160 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) fail('Invalid label');
  return value;
}
function number(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_VALUE) fail('Invalid numeric value');
  return value;
}

/** A domain-specific repository tree, not a general-purpose executable UI language. */
export function normalize(json) {
  if (typeof json !== 'string' || Buffer.byteLength(json) > MAX_BYTES) fail('Snapshot exceeds byte limit');
  const input = JSON.parse(json);
  keys(input, ['version', 'title', 'root']);
  if (input.version !== 1) fail('Unsupported version');
  const seen = new Set();
  function visit(node, depth) {
    keys(node, ['id', 'label', 'code', 'churn', 'children']);
    if (depth > MAX_DEPTH || seen.size >= MAX_NODES) fail('Tree exceeds bounds');
    if (typeof node.id !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(node.id) || seen.has(node.id)) fail('Invalid or duplicate id');
    seen.add(node.id);
    const name = label(node.label);
    if (node.children !== undefined && !Array.isArray(node.children)) fail('Invalid children');
    const children = (node.children ?? []).map(child => visit(child, depth + 1));
    const code = children.length ? number(children.reduce((sum, child) => sum + child.code, 0)) : number(node.code);
    const churn = children.length ? number(children.reduce((sum, child) => sum + child.churn, 0)) : number(node.churn);
    if (children.length && ((node.code !== undefined && node.code !== code) || (node.churn !== undefined && node.churn !== churn))) fail('Incorrect aggregate');
    return { id: node.id, label: name, code, churn, children };
  }
  const result = { version: 1, title: label(input.title), root: visit(input.root, 0) };
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES - 1024) fail('Normalized snapshot exceeds byte limit');
  return result;
}

export function prepare(json, rendererHash) {
  if (!/^[a-f0-9]{64}$/.test(rendererHash)) fail('Invalid renderer hash');
  const document = normalize(json);
  const id = digest(JSON.stringify({ rendererHash, document }));
  return { schema: 'omp-native-visual/v1', id, rendererHash, document };
}

/** Structural tests and model statements cannot produce a human review receipt. */
export function assertReviewed(artifact, receipt, scope, rendererHash) {
  if (!receipt || receipt.method !== 'human-inspected' || receipt.scope !== scope || receipt.id !== artifact.id ||
      receipt.rendererHash !== rendererHash || artifact.rendererHash !== rendererHash) fail('Exact preview requires fresh human inspection');
}

/** Reference for the viewer's level-of-detail behavior: no silent truncation. */
export function visibleChildren(node, mode = 'code', limit = VISIBLE_LIMIT) {
  if (!['code', 'churn'].includes(mode) || !Number.isInteger(limit) || limit < 2 || limit > VISIBLE_LIMIT) fail('Invalid projection');
  const items = [...node.children].sort((a, b) => b[mode] - a[mode] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (items.length <= limit) return items;
  const rest = items.slice(limit - 1);
  return [...items.slice(0, limit - 1), { id: `@other:${node.id}`, label: `Other (${rest.length})`,
    code: rest.reduce((sum, item) => sum + item.code, 0), churn: rest.reduce((sum, item) => sum + item.churn, 0), children: rest }];
}
