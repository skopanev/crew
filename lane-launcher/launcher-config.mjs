// Load and validate one dispatcher configuration.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {read, validateWritableDirs, command} from './runtime.mjs';
import {scopeDirectory, validateId} from './scope.mjs';
import {validateJoppa} from './joppa.mjs';
import {validateContext} from './context-config.mjs';
import {defaultHooks, validateHooks} from './hooks-config.mjs';
import {defaultWorkflow, validateWorkflow, validateWorkflowVars} from './workflow-config.mjs';
import {validateLaneOptions} from './lane-options.mjs';
import {validateSelectionNotify} from './selection-notify.mjs';
import {validatePreLaunch} from './pre-launch.mjs';
import {validateDispatchGate} from './dispatch-gate.mjs';
import {validateHostMaintenance} from './host-maintenance.mjs';

const hostOwned = key => /^(MEDULLA_|LANE_|CBM_|REQUIREMENT_|DELIVERY(?:_|$))/.test(key) ||
  ['TOOLING_ROOT', 'TARGET_BRANCH', 'IMAGE', 'TICKET_SOURCE', 'LAUNCH_CLAIM_FILE', 'SCOUT_ENABLED',
    'FINALIZE_ONLY', 'JOPPA_READER_COMMAND_JSON', 'REPOSITORY_PREFLIGHT', 'GIT_SSH_COMMAND',
    'REVIEWERS_JSON', 'REPAIR_BASELINE_ENABLED', 'RETAINED_CHECKOUT_PROTOCOL'].includes(key);

export function configFrom(file, env = process.env, {dryRun = false, bytes = null} = {}) {
  const config = {limit: 1, intervalSeconds: 60, launchLanes: false, closeTabOnExit: false,
    discardFailedWorktree: false, cbmRequired: true, cbmInitializeTimeoutSeconds: 90, env: {}, vars: {},
    readOnlyRepos: [], readWriteDirs: [], sharedLockDir: null, testCommand: [], gateTimeoutSeconds: 900, image: 'medulla-crew:latest', dockerEngine: false,
    stateDir: path.join(os.homedir(), '.medulla/lane-launcher'),
    herdr: env.HERDR_BIN_PATH || 'herdr', herdrWorkspace: env.HERDR_WORKSPACE_ID,
    ...(bytes ? JSON.parse(bytes.toString('utf8')) : read(file))};
  // Saved run state records the source; operator recovery checks it.
  config.source = 'joppa';
  validateSelectionNotify(config.selectionNotify);
  validatePreLaunch(config);
  validateDispatchGate(config);
  validateHostMaintenance(config);
  config.delivery ??= 'branch';
  validateJoppa(config);
  validateLaneOptions(config);
  config.gateCommands = config.repositories[0].gateCommands;
  config.testCommand = config.repositories[0].testCommand;
  if (dryRun) config.launchLanes = false;
  config.lanes ??= 'herdr';
  if (!['herdr', 'headless'].includes(config.lanes)) throw new Error('lanes must be herdr or headless');
  config.id = validateId(config.id);
  // The terminal running dolber owns the destination workspace.
  config.herdrWorkspace = env.HERDR_WORKSPACE_ID || config.herdrWorkspace;
  for (const field of config.launchLanes && config.lanes === 'herdr' ? ['workspace', 'herdrWorkspace'] : ['workspace']) {
    if (typeof config[field] !== 'string' || !config[field].trim()) throw new Error(`Config needs ${field}`);
  }
  if (typeof config.launchLanes !== 'boolean') throw new Error('launchLanes must be true or false');
  if (typeof config.closeTabOnExit !== 'boolean') throw new Error('closeTabOnExit must be true or false');
  if (typeof config.discardFailedWorktree !== 'boolean') throw new Error('discardFailedWorktree must be true or false');
  if (typeof config.cbmRequired !== 'boolean') throw new Error('cbmRequired must be true or false');
  if (!config.vars || typeof config.vars !== 'object' || Array.isArray(config.vars) ||
      Object.entries(config.vars).some(([key, value]) => !/^[A-Z_][A-Z0-9_]*$/.test(key) ||
        typeof value !== 'string' || value.includes('\0'))) {
    throw new Error('vars must map uppercase variable names to strings without NUL');
  }
  for (const key of Object.keys(config.vars)) {
    if (hostOwned(key)) throw new Error(`vars.${key} is host-owned`);
  }
  if (!Number.isSafeInteger(config.cbmInitializeTimeoutSeconds) || config.cbmInitializeTimeoutSeconds < 1) throw new Error('cbmInitializeTimeoutSeconds must be positive');
  if (!config.env || typeof config.env !== 'object' || Array.isArray(config.env) || Object.entries(config.env).some(([key, value]) =>
    !/^[A-Z_][A-Z0-9_]*$/.test(key) || hostOwned(key) ||
    typeof value !== 'string' || value.includes('\0'))) {
    throw new Error('env must map runtime variable names to strings without host-owned overrides');
  }
  for (const key of Object.keys(config.vars)) {
    if (Object.hasOwn(config.env, key)) throw new Error(`vars.${key} duplicates env.${key}`);
  }
  if (typeof config.dockerEngine !== 'boolean') throw new Error('dockerEngine must be true or false');
  if (typeof config.image !== 'string' || !config.image || /\s/.test(config.image) || config.image.startsWith('-')) {
    throw new Error('image must be a Docker image reference');
  }
  if (config.repo) throw new Error('repo was removed; set sourceRoot to the source workspace');
  if (typeof config.stateDir !== 'string' || !path.isAbsolute(config.stateDir)) throw new Error('stateDir must be absolute');
  for (const field of ['limit', 'intervalSeconds', 'gateTimeoutSeconds']) {
    if (!Number.isSafeInteger(config[field]) || config[field] < 1) throw new Error(`${field} must be a positive integer`);
  }
  if (config.coderTimeoutSeconds != null && (!Number.isSafeInteger(config.coderTimeoutSeconds) || config.coderTimeoutSeconds < 1)) {
    throw new Error('coderTimeoutSeconds must be a positive integer');
  }
  // A stable dispatcher identity owns its lock, reservations and containers.
  config.stateDir = scopeDirectory(config.stateDir, config.id);
  if (config.hooks === undefined) config.hooks = defaultHooks;
  if (config.workflow === undefined) config.workflow = defaultWorkflow;
  validateWorkflowVars(config.workflow, config.vars);
  if (!config.launchLanes) return config;
  validateHooks(config.hooks);
  validateWorkflow(config.workflow);
  validateContext(config.context);
  for (const role of ['scout', 'coder', 'reviewer', 'gitfix']) {
    if (role === 'scout' && config.scout === false) continue;
    if (typeof config.context.roles?.[role] !== 'string' || !config.context.roles[role].trim()) {
      throw new Error(`context.roles.${role} is required`);
    }
  }
  if (!Array.isArray(config.gateCommands) || !config.gateCommands.length ||
      config.gateCommands.some(check => typeof check !== 'string' || !check.trim())) {
    throw new Error('Config needs gateCommands: a nonempty array of repository checks');
  }
  if (config.reviewCommands != null && (!Array.isArray(config.reviewCommands) || !config.reviewCommands.length ||
      config.reviewCommands.some(check => typeof check !== 'string' || !check.trim()))) {
    throw new Error('reviewCommands must be a nonempty array of check commands');
  }
  if (!Array.isArray(config.readOnlyRepos)) throw new Error('readOnlyRepos must be an array');
  if (!Array.isArray(config.readWriteDirs)) throw new Error('readWriteDirs must be an array');
  if (!Array.isArray(config.testCommand) || !config.testCommand.length || config.testCommand.some(arg => typeof arg !== 'string' || !arg.trim())) {
    throw new Error('Config needs testCommand: runner arguments, e.g. ["bun", "run", "test"]');
  }
  if (!config.sourceRoot) throw new Error('Config needs sourceRoot: the source workspace');
  for (const dir of [config.sourceRoot, config.sshDir, config.cbmCacheDir, ...config.readOnlyRepos, ...config.readWriteDirs]) {
    if (typeof dir !== 'string' || !path.isAbsolute(dir) || !fs.statSync(dir).isDirectory()) {
      throw new Error(`Directory must exist and be absolute: ${dir}`);
    }
  }
  validateWritableDirs(config);
  if (typeof config.cbmMcpCommand !== 'string' || !path.isAbsolute(config.cbmMcpCommand) ||
      !fs.statSync(config.cbmMcpCommand).isFile()) {
    throw new Error('Config needs cbmMcpCommand: absolute path to the native host CBM executable');
  }
  return config;
}

// The dispatcher lock, reservations and queue belong to these fields. A reload never changes them.
export const dolberIdentity = config => ({workspace: config.workspace, url: config.joppa.url,
  mcpCommand: config.joppa.mcpCommand ?? null, id: config.id,
  stateDir: fs.existsSync(config.stateDir) ? fs.realpathSync(config.stateDir) : config.stateDir});

export function preflight(config) {
  if (config.launchLanes && config.delivery !== 'branch' && !config.sharedLockDir) {
    throw new Error('Target delivery requires sharedLockDir; no ticket was claimed');
  }
  for (const bin of config.launchLanes ? ['medulla', 'jq'] : []) {
    command('bash', ['-c', 'command -v "$1"', '_', bin]);
  }
  if (config.launchLanes) {
    try { command('medulla', ['-w', config.workflow, '--validate']); }
    catch (error) {
      throw new Error(`Workflow failed Medulla validation; no ticket was claimed: ${String(error.stderr || error.stdout || error.message).trim()}`);
    }
  }
  const coderTimeout = config.coderTimeoutSeconds != null || config.repositories?.some(repo => repo.coderTimeoutSeconds != null);
  if (config.launchLanes && (config.dockerEngine || coderTimeout)) {
    const help = command('medulla', ['--help']);
    if (config.dockerEngine && !help.includes('--docker-engine')) {
      throw new Error('dockerEngine requires Medulla with --docker-engine support; no ticket was claimed');
    }
    if (coderTimeout && !help.includes('--node-timeout')) {
      throw new Error('coderTimeoutSeconds requires Medulla with --node-timeout support; no ticket was claimed');
    }
  }
}
