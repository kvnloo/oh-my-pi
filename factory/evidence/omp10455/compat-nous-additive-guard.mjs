#!/usr/bin/env node
/**
 * Fork-only preflight for rebasing can1357/oh-my-pi#10455 onto current main.
 * NOT a replacement for native Bun gen:compat or integration tests.
 * Usage: node compat-nous-additive-guard.mjs MAIN_RULES PR_RULES CANDIDATE_RULES
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const NOUS = 'nous-portal';
const ADDED_FILES = ['auth/nous-portal.kdl', 'providers/nous-portal.kdl'];
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function check(ok, message) { if (!ok) throw new Error(message); }

export function expectedAdditiveRules(baseline, proposal) {
  const result = structuredClone(baseline);
  check(result.version === proposal.version, 'compiled schema version differs');
  check(!Object.hasOwn(result.providers, NOUS), 'baseline already contains nous-portal');
  check(Object.hasOwn(proposal.providers, NOUS), 'PR lacks compiled Nous provider');
  const auth = proposal.auth.providers.filter(entry => entry.id === NOUS);
  check(auth.length === 1, 'PR must declare exactly one Nous auth entry');
  check(!result.auth.providers.some(entry => entry.id === NOUS), 'baseline already declares Nous auth');
  const index = result.auth.providers.findIndex(entry => entry.id === 'qwen-portal');
  check(index >= 0, 'cannot locate upstream qwen-portal login-order anchor');
  for (const path of ADDED_FILES) {
    check(proposal.files.includes(path), 'PR is missing generated ' + path);
    check(!result.files.includes(path), 'baseline already contains ' + path);
  }
  check(!result.taxonomy.discovery.canonicalRecovery.includes(NOUS), 'baseline already enables Nous recovery');
  check(proposal.taxonomy.discovery.canonicalRecovery.includes(NOUS), 'PR lacks Nous recovery');
  result.files = [...result.files, ...ADDED_FILES].sort();
  result.taxonomy.discovery.canonicalRecovery = [...result.taxonomy.discovery.canonicalRecovery, NOUS].sort();
  result.auth.providers.splice(index + 1, 0, structuredClone(auth[0]));
  result.providers[NOUS] = structuredClone(proposal.providers[NOUS]);
  result.providers = Object.fromEntries(Object.entries(result.providers).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  return result;
}

/** Changed JSON-pointer paths; arrays collapse to a single path. */
export function changedPaths(left, right, path = '') {
  if (equal(left, right)) return [];
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) || Array.isArray(right)) {
    return [path || '/'];
  }
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .flatMap(key => changedPaths(left[key], right[key], path + '/' + key.replaceAll('~', '~0').replaceAll('/', '~1')));
}

export function verifyAdditiveRules(baseline, proposal, candidate) {
  const expected = expectedAdditiveRules(baseline, proposal);
  const differences = changedPaths(expected, candidate);
  return { ok: differences.length === 0, differences, expected };
}

function main(args) {
  check(args.length === 3, 'usage: node compat-nous-additive-guard.mjs MAIN_RULES PR_RULES CANDIDATE_RULES');
  const [baseline, proposal, candidate] = args.map(file => JSON.parse(readFileSync(file, 'utf8')));
  const { ok, differences } = verifyAdditiveRules(baseline, proposal, candidate);
  if (!ok) {
    console.error('FAIL: ' + differences.length + ' unexpected compiled-policy paths (first 40):');
    for (const path of differences.slice(0, 40)) console.error('  ' + path);
    console.error('Regenerate from current KDL; do not copy PR #10455 stale compiled rules.');
    process.exitCode = 1;
    return;
  }
  console.log('PASS: additive Nous-only compiled rules; ' + Object.keys(baseline.providers).length + ' baseline providers preserved');
  console.log('LIMITED: semantic comparison only; Bun gen:compat, formatter, typecheck and tests still required.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
