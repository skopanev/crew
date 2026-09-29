import path from 'node:path';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';

export function validateId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(id)) {
    throw new Error('Config needs id: 1–64 letters, digits, dots, underscores or hyphens; start with a letter/digit');
  }
  return id.toLowerCase();
}
export function scopeDirectory(root, id) {
  return path.join(root, 'crew-dispatchers', validateId(id));
}
export function runScope(folder = '') {
  return folder.match(/(?:^|\/)crew-dispatchers\/([a-zA-Z0-9][a-zA-Z0-9_.-]{0,63})(?:\/|$)/)?.[1]?.toLowerCase();
}
export function laneRunFolder(root, id) {
  id = validateId(id);
  const scope = runScope(root);
  if (scope) {
    if (scope !== id) throw new Error('Lane run folder belongs to another dispatcher');
    return root;
  }
  return scopeDirectory(root, id);
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try { console.log(laneRunFolder(...process.argv.slice(2))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
