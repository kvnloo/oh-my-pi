import * as fs from 'node:fs/promises';

export const calls = [];
let hooks = [];
export function reset() { calls.length = 0; hooks = []; }
export function once(method, matches, run) { hooks.push({ method, matches, run }); }
async function invoke(method, args) {
  calls.push({ method, path: String(args[0]) });
  const index = hooks.findIndex(hook => hook.method === method && hook.matches(String(args[0])));
  if (index >= 0) await hooks.splice(index, 1)[0].run();
  return fs[method](...args);
}
export const readFile = (...args) => invoke('readFile', args);
export const writeFile = (...args) => invoke('writeFile', args);
export const mkdir = (...args) => invoke('mkdir', args);
export const stat = (...args) => invoke('stat', args);
