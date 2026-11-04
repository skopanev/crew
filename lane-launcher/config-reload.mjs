// Reload a dispatcher config between queue selections. No file watcher.
// The caller calls the reloader only at a selection boundary, never during an active pass.
import fs from 'node:fs';

const source = file => {
  try { return fs.readFileSync(file); } catch (error) { return error; }
};
const same = (a, b) => Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.equals(b);
// Do not show the JSON parser text: it can quote config values.
const reason = error => error instanceof SyntaxError ? 'the file is not valid JSON' :
  error?.code === 'ENOENT' ? 'the file is missing' : String(error?.message || error).replace(/\s+/g, ' ').slice(0, 160);

export const CONFIG_RESTART_REQUIRED = 'CONFIG_RESTART_REQUIRED: workspace, endpoint, dispatcher ID or run root changed · ' +
  'nothing starts · restart this dispatcher to use the new config';

// parse(bytes) returns the normalized config of exactly these bytes with the existing validation.
// initialBytes are the bytes that produced initial: an edit after that load is a change.
// identity() returns the fields that own locks and state. They never change after start.
export function configReloader(file, parse, identity, initial, initialBytes) {
  const locked = JSON.stringify(identity(initial));
  let seen = initialBytes, current = initial, held = false;
  return () => {
    const bytes = source(file);
    if (!held && same(bytes, seen)) return {config: current, reloaded: false};
    seen = bytes;
    let next;
    try {
      if (!Buffer.isBuffer(bytes)) throw bytes;
      next = parse(bytes);
    }
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
