// Load and validate one dispatcher configuration.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {read, validateWritableDirs} from './runtime.mjs';
import {scopeDirectory, validateId} from './scope.mjs';
import {validateJoppa} from './joppa.mjs';

export function configFrom(file, env = process.env, {dryRun = false} = {}) {
  const config = {limit: 1, intervalSeconds: 60, launchLanes: false, closeTabOnExit: false,
    readOnlyRepos: [], readWriteDirs: [], sharedLockDir: null, testCommand: [], gateTimeoutSeconds: 900, image: 'medulla-crew:latest', dockerEngine: false,
    stateDir: path.join(os.homedir(), '.medulla/lane-launcher'),
    herdr: env.HERDR_BIN_PATH || 'herdr', herdrWorkspace: env.HERDR_WORKSPACE_ID,
    ...read(file)};
  // Saved run state records the source; operator recovery checks it.
  config.source = 'joppa';
  config.delivery ??= 'branch';
  validateJoppa(config);
  config.gateCommands = config.repositories[0].gateCommands;
  config.testCommand = config.repositories[0].testCommand;
  if (dryRun) config.launchLanes = false;
  config.id = validateId(config.id);
  // The terminal running dolber owns the destination workspace.
  config.herdrWorkspace = env.HERDR_WORKSPACE_ID || config.herdrWorkspace;
  for (const field of config.launchLanes ? ['workspace', 'herdrWorkspace'] : ['workspace']) {
    if (typeof config[field] !== 'string' || !config[field].trim()) throw new Error(`Config needs ${field}`);
  }
  if (typeof config.launchLanes !== 'boolean') throw new Error('launchLanes must be true or false');
  if (typeof config.closeTabOnExit !== 'boolean') throw new Error('closeTabOnExit must be true or false');
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
  if (!config.launchLanes) return config;
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
