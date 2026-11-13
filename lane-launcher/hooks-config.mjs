import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const require = (condition, message) => { if (!condition) throw new Error(message); };
const text = value => typeof value === 'string' && Boolean(value.trim());

export const defaultHooks = fileURLToPath(new URL('../lane/hooks/claude-settings.json', import.meta.url));

export function validateHooks(file = defaultHooks) {
  require(typeof file === 'string' && path.isAbsolute(file),
    'Config needs hooks: an absolute path to a JSON hook settings file');
  let stat;
  try { stat = fs.statSync(file); } catch { stat = null; }
  require(stat?.isFile(), `Hook settings file must exist: ${file}`);
  let settings;
  try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error(`Hook settings file is not valid JSON: ${file}`); }
  require(settings && typeof settings === 'object' && !Array.isArray(settings),
    'Hook settings file must contain a JSON object');
  require(settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks),
    'Hook settings file must contain a hooks object');
  if (settings.env !== undefined) {
    require(settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env),
      'Hook settings env must be an object');
  }
  if (settings.permissions !== undefined) {
    require(settings.permissions && typeof settings.permissions === 'object' && !Array.isArray(settings.permissions),
      'Hook settings permissions must be an object');
  }
  require(Object.values(settings.hooks).every(entries => Array.isArray(entries) &&
    entries.every(entry => entry && typeof entry === 'object' && !Array.isArray(entry) &&
      Array.isArray(entry.hooks) && entry.hooks.every(hook => hook && typeof hook === 'object' && !Array.isArray(hook) &&
        (hook.type !== 'command' || text(hook.command))))),
    'Hook settings entries must be arrays of hook groups with valid commands');
  return file;
}

// Copy custom project hook settings into a private per-run directory mounted read-only.
export function prepareHooks(file = defaultHooks, {container = true} = {}) {
  const resolved = validateHooks(file);
  if (fs.realpathSync(resolved) === fs.realpathSync(defaultHooks)) {
    return {dir: '', settingsFile: ''};
  }
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crew-hooks-')));
  try {
    fs.chmodSync(dir, 0o700);
    const target = path.join(dir, 'settings.json');
    fs.copyFileSync(resolved, target);
    fs.chmodSync(target, 0o600);
    const root = container ? `/workspace/${path.basename(dir)}` : dir;
    return {dir, settingsFile: `${root}/settings.json`};
  } catch (error) {
    fs.rmSync(dir, {recursive: true, force: true});
    throw error;
  }
}
