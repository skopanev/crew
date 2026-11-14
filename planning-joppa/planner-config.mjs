// Read and validate the planner dispatcher config. Start and reload use the same checks.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {criterionIds, flowSettings} from './queue.mjs';

const expand = value => value.startsWith('~/') ? path.join(process.env.HOME, value.slice(2)) : value;
const real = folder => fs.existsSync(folder) ? fs.realpathSync(folder) : folder;

// launch.py exits with this status only when the config bytes differ from the handoff digest.
// Nothing started, so the dispatcher may select the same item again.
export const HANDOFF_CHANGED = 75;

// The pass receives the digest of these exact bytes and refuses a file that differs.
export function plannerConfig(configFile, {ac = null, automatic = false} = {}, bytes = fs.readFileSync(configFile)) {
  const config = JSON.parse(bytes.toString('utf8'));
  const ids = criterionIds(config);
  if (ac && ids && !ids.includes(ac)) throw new Error('Selected AC is outside config.ac_ids');
  if (typeof config.workspace !== 'string' || typeof config.runs_folder !== 'string') throw new Error('Config needs workspace and runs_folder');
  // A configured flow names its Medulla workflow explicitly. Without workflow the bundled planner flow applies.
  if (flowSettings(config)) {
    const workflow = expand(config.workflow);
    if (!path.isAbsolute(workflow) || path.basename(workflow) !== 'workflow.yaml' ||
        !fs.statSync(workflow, {throwIfNoEntry: false})?.isFile()) throw new Error('workflow must be an absolute path to a workflow.yaml file');
  }
  const root = real(path.resolve(path.dirname(configFile), expand(config.runs_folder)));
  const interval = config.interval_seconds ?? 60;
  if (!Number.isInteger(interval) || interval < 1 || interval > 3600) throw new Error('interval_seconds must be 1 to 3600');
  const tokenFile = config.token_file ? path.resolve(path.dirname(configFile), expand(config.token_file)) : null;
  if (automatic && !tokenFile && !config.mcp_command) {
    throw new Error('Config needs mcp_command or token_file for automatic selection');
  }
  return {config, root, interval, tokenFile, digest: createHash('sha256').update(bytes).digest('hex')};
}

// The dispatch lock and run folders belong to these fields. A reload never changes them.
export const plannerIdentity = loaded => ({workspace: loaded.config.workspace, url: loaded.config.url ?? null,
  mcpCommand: loaded.config.mcp_command ?? null, root: real(loaded.root)});
