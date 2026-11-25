// Operator modules decide eligibility. The supplied reader permits workspace reads only.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {api} from '../lane-launcher/joppa.mjs';
import {normalizeSlots} from './slots.mjs';

const need = (ok, message) => { if (!ok) throw new Error('Configured admission: ' + message); };
const tools = new Set(['joppa_objects', 'joppa_tree', 'joppa_search', 'joppa_help']);
const readers = new WeakMap();
function scopedReader(read, workspace) {
  if (!readers.has(read)) readers.set(read, new Map());
  const scopes = readers.get(read);
  if (!scopes.has(workspace)) scopes.set(workspace, (tool, args = {}) => {
    need(tools.has(tool), 'reader does not permit ' + tool);
    return read(tool, {...args, workspace});
  });
  return scopes.get(workspace);
}

export function admissionSettings(config) {
  const file = config.admission_module;
  if (file === undefined) return;
  need(typeof file === 'string' && path.isAbsolute(file) && fs.statSync(file, {throwIfNoEntry: false})?.isFile(),
    'admission_module must name an existing absolute module file');
  return file;
}

export async function admissionAllowed(row, profile, read) {
  const file = admissionSettings(profile);
  if (!file) return true;
  const {admission} = await import(pathToFileURL(file).href);
  need(typeof admission === 'function', 'module must export admission');
  const readonly = scopedReader(read, profile.workspace);
  const allowed = await admission(structuredClone(row), structuredClone(profile), readonly);
  need(typeof allowed === 'boolean', 'admission must return a boolean');
  return allowed;
}

function reader(config, tokenFile, signal) {
  const service = {joppa: {url: config.url, mcpCommand: config.mcp_command}};
  return (tool, args) => api(service, {tokenFile}, tool, {...args, workspace: config.workspace}, {signal});
}

export async function admissionForItem(config, tokenFile, address, index = 0, signal) {
  config = normalizeSlots(config);
  if (config.inputs) {
    need(Number.isSafeInteger(index) && index >= 0 && index < config.inputs.length, 'invalid input index');
    config = {...config, ...config.inputs[index], inputs: undefined, input: index};
  }
  if (!admissionSettings(config)) return true;
  const read = reader(config, tokenFile, signal);
  const item = await read('joppa_objects', {address});
  need(item?.address === address && item.historical === false && item.document?.present === true &&
    Number.isSafeInteger(item.current_revision), 'selected object is not current');
  return admissionAllowed({address, revision: item.current_revision, kind: item.kind,
    parent: item.document.parent, title: item.document.data?.title || address}, config, read);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    const {config, rows, full = false} = JSON.parse(fs.readFileSync(0, 'utf8'));
    const read = reader(config, config.token_file), admitted = [];
    for (const row of rows) {
      if (full ? await admissionForItem(config, config.token_file, row.address) : await admissionAllowed(row, config, read)) {
        admitted.push(row.address);
      }
    }
    process.stdout.write(JSON.stringify(admitted));
  } catch (error) { console.error('Configured admission: ' + error.message); process.exitCode = 1; }
}
