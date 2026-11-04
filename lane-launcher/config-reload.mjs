// Reload a dispatcher config between queue selections. No file watcher.
// The caller calls the reloader only at a selection boundary, never during an active pass.
import fs from 'node:fs';

const source = file => {
  try { return fs.readFileSync(file, 'utf8'); } catch (error) { return error; }
};
// Do not show the JSON parser text: it can quote config values.
const reason = error => error instanceof SyntaxError ? 'the file is not valid JSON' :
  error?.code === 'ENOENT' ? 'the file is missing' : String(error?.message || error).replace(/\s+/g, ' ').slice(0, 160);

export const CONFIG_RESTART_REQUIRED = 'CONFIG_RESTART_REQUIRED: workspace, endpoint, dispatcher ID or run root changed · ' +
  'nothing starts · restart this dispatcher to use the new config';

// load() returns the normalized config with the existing validation.
// identity() returns the fields that own locks and state. They never change after start.
export function configReloader(file, load, identity, initial) {
  const locked = JSON.stringify(identity(initial));
  let seen = source(file), current = initial, held = false;
  return () => {
    const text = source(file);
    if (!held && typeof text === 'string' && text === seen) return {config: current, reloaded: false};
    seen = text;
    let next;
    try { next = load(); }
    catch (error) {
      held = true;
      return {config: current, reloaded: false,
        error: `CONFIG_INVALID: ${reason(error)} · nothing starts until the config is valid`};
    }
    if (JSON.stringify(identity(next)) !== locked) {
      held = true;
      return {config: current, reloaded: false, error: CONFIG_RESTART_REQUIRED};
    }
    const reloaded = held || JSON.stringify(next) !== JSON.stringify(current);
    held = false;
    current = next;
    return {config: current, reloaded};
  };
}
