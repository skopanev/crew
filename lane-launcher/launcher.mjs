#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {nextTicket, countTickets, credentials} from './ntk.mjs';
import {save, read, readRun, alive, quote, command, herdr, laneArgs, runDirectories, validateWritableDirs} from './runtime.mjs';
import {scopeDirectory, runScope, validateId} from './scope.mjs';
import {createDashboard} from './dashboard.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const useColor = process.env.NO_COLOR === undefined && process.env.FORCE_COLOR !== '0' &&
  (process.stdout.isTTY || (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0'));
const tones = {red: 31, blue: '1;34', yellow: '1;33', description: 33, ready: '1;38;2;70;230;90', available: '1;32', accent: '1;36', line: 36, finished: 37};
const paint = (tone, value) => useColor ? `\x1b[${tones[tone]}m${value}\x1b[0m` : String(value);
const divider = () => console.log(paint('line', '─'.repeat(Math.min(process.stdout.columns || 64, 64))));
export const usage = 'dolber.sh [config.json | --config <file>] [--once | --dry-run]';
export function configFrom(file, env = process.env, {dryRun = false} = {}) {
  const config = {limit: 1, intervalSeconds: 60, tags: [], strict: false, launchLanes: false, closeTabOnExit: false,
    preferTags: [], readOnlyRepos: [], readWriteDirs: [], testCommand: [], image: 'medulla-crew:latest', dockerEngine: false,
    stateDir: path.join(os.homedir(), '.medulla/lane-launcher'),
    herdr: env.HERDR_BIN_PATH || 'herdr', herdrWorkspace: env.HERDR_WORKSPACE_ID,
    ...read(file)};
  if (dryRun) config.launchLanes = false;
  config.id = validateId(config.id);
  // The terminal running dolber owns the destination workspace.
  config.herdrWorkspace = env.HERDR_WORKSPACE_ID || config.herdrWorkspace;
  for (const field of config.launchLanes ? ['workspace', 'herdrWorkspace'] : ['workspace']) {
    if (typeof config[field] !== 'string' || !config[field].trim()) throw new Error(`Config needs ${field}`);
  }
  for (const field of ['tags', 'preferTags']) {
    if (!Array.isArray(config[field]) || config[field].some(tag =>
      typeof tag !== 'string' || !tag.trim() || tag.includes(','))) {
      throw new Error(`${field} must be an array of nonempty tags without commas`);
    }
    config[field] = config[field].map(tag => tag.trim());
  }
  if (typeof config.strict !== 'boolean') throw new Error('strict must be true or false');
  if (typeof config.launchLanes !== 'boolean') throw new Error('launchLanes must be true or false');
  if (typeof config.closeTabOnExit !== 'boolean') throw new Error('closeTabOnExit must be true or false');
  if (typeof config.dockerEngine !== 'boolean') throw new Error('dockerEngine must be true or false');
  if (typeof config.image !== 'string' || !config.image || /\s/.test(config.image) || config.image.startsWith('-')) {
    throw new Error('image must be a Docker image reference');
  }
  for (const field of ['module', 'assignee']) {
    if (config[field] != null && (typeof config[field] !== 'string' || !config[field].trim())) {
      throw new Error(`${field} must be a nonempty string or null`);
    }
  }
  if ('tag' in config) throw new Error('Use tags: ["crew"] in dolber.json instead of tag');
  if (config.repo) throw new Error('repo was removed; set sourceRoot to the source workspace');
  if (typeof config.stateDir !== 'string' || !path.isAbsolute(config.stateDir)) throw new Error('stateDir must be absolute');
  for (const field of ['limit', 'intervalSeconds']) {
    if (!Number.isSafeInteger(config[field]) || config[field] < 1) throw new Error(`${field} must be a positive integer`);
  }
  // A stable dispatcher identity owns its lock, reservations and containers.
  config.stateDir = scopeDirectory(config.stateDir, config.id);
  if (!config.launchLanes) return config;
  if (!Array.isArray(config.gateCommands) || !config.gateCommands.length ||
      config.gateCommands.some(check => typeof check !== 'string' || !check.trim())) {
    throw new Error('Config needs gateCommands: a nonempty array of repository checks');
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

export function dockerLanes(output, config) {
  return output.split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => {
    return row.workflow === 'lane' && runScope(row.runFolder) === config.id;
  });
}

export function activeCount(config, containers, panes) {
  let count = containers.length;
  for (const dir of runDirectories(config.stateDir)) {
    const stateFile = path.join(dir, 'launch.json');
    if (!fs.existsSync(stateFile)) continue;
    const run = readRun(stateFile);
    if (run.result) continue;
    const worker = run.worker;
    const containerRunning = containers.some(container => container.runFolder === run.runFolder);
    if (containerRunning) continue; // Already counted by Docker.
    if (panes && run.config?.herdrWorkspace === config.herdrWorkspace &&
        run.pane && !panes.has(run.pane) && (!worker || !alive(worker.pid))) {
      save(stateFile, {...run, result: {status: 'interrupted', finishedAt: new Date().toISOString(),
        error: 'Herdr pane and worker disappeared; inspect lane artifacts before reopening the ticket'}});
      continue;
    }
    // Reserve capacity even before the worker/container has appeared.
    count++;
  }
  return count;
}

function snapshots(config) {
  // Read labels individually: Docker's comma-joined .Labels corrupts paths
  // containing commas. JSON quoting also preserves spaces and escapes.
  const format = '{"workflow":{{json (.Label "medulla.workflow")}},"runFolder":{{json (.Label "medulla.runs_under")}}}';
  const containers = dockerLanes(command('docker', ['ps', '--format', format]), config);
  if (!config.launchLanes) return {containers, panes: null};
  const result = herdr(config, ['pane', 'list', '--workspace', config.herdrWorkspace]);
  if (!Array.isArray(result?.panes)) throw new Error('Herdr returned no pane list; refusing to assume free capacity');
  return {containers, panes: new Set(result.panes.map(pane => pane.pane_id))};
}

function preflight(config) {
  credentials();
  for (const bin of config.launchLanes ? ['medulla', 'jq'] : []) {
    command('bash', ['-c', 'command -v "$1"', '_', bin]);
  }
  if (config.launchLanes && config.dockerEngine && !command('medulla', ['--help']).includes('--docker-engine')) {
    throw new Error('dockerEngine requires Medulla with --docker-engine support; no ticket was claimed');
  }
}

export async function tick(config, display = null) {
  const print = display ? message => { display.message = message; } : console.log;
  if (display) { display.message = 'Checking tickets'; display.error = null; }
  const {containers, panes} = snapshots(config);
  const active = activeCount(config, containers, panes);
  if (display) display.containers = containers;
  else divider();
  print(`Running lanes ${paint(active >= config.limit ? 'yellow' : 'available', `${active} of ${config.limit}`)}`);
  if (active >= config.limit) { if (display) display.message = ''; return; }
  const countFilter = `workspace=${config.workspace}, tags=${config.tags.join(',') || '(any)'}, strict=${config.strict}`;
  const query = {workspace: config.workspace,
    tag: config.tags.length ? config.tags.join(',') : undefined,
    prefer: config.preferTags.length ? config.preferTags.join(',') : undefined,
    module: config.module ?? undefined, assignee: config.assignee ?? undefined,
    strict: config.strict, has_module: true, dry_run: true};
  const candidate = await nextTicket(query);
  try {
    const filter = {workspace: config.workspace, tag: config.tags.length ? config.tags.join(',') : undefined, strict: config.strict};
    const open = await countTickets({...filter, status: 'open'});
    const ready = candidate ? '≥1' : '0';
    if (display) display.counts = {open, ready, blocked: candidate === null && open > 0};
    else print(`Tickets with tags [${countFilter}]: ${paint('accent', open)} open${candidate === null && open > 0 ? ' (blocked)' : ''} · ready to work: ${ready}`);
  } catch (error) {
    const message = `Tickets with tags [${countFilter}]: unavailable (${error.message})`;
    if (display) { display.counts = null; display.fail(message); }
    else console.error(paint('red', message));
  }
  if (!display) {
    print('checking params:');
    print(`  tags: ${config.tags.join(', ') || '(any)'}`);
    print(`  prefer: ${config.preferTags.join(' → ') || '(none)'}`);
  }
  if (!candidate) { if (display) display.message = 'No ready tickets'; return; }
  if (typeof candidate.id !== 'string' || !candidate.id) throw new Error('NTK returned a ticket without an id');
  print(`Starting new one with ticket: ${paint('accent', candidate.id)}${config.launchLanes ? '' : ' (preview: запуск отключён)'}`);
  if (!display && candidate.title) print(`  ${paint('description', candidate.title.replace(/[\r\n\x1b]/g, ' '))}`);
  if (!config.launchLanes) return;
  const dir = path.join(config.stateDir, 'runs', randomUUID());
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  const runFolder = path.join(fs.realpathSync(dir), 'lane');
  fs.mkdirSync(runFolder);
  const run = {ticket: candidate.id, workspace: config.workspace, config,
    runFolder, args: laneArgs(config, candidate.id), createdAt: new Date().toISOString()};
  const stateFile = path.join(dir, 'launch.json');
  save(stateFile, run);
  // Reserve capacity before opening the tab; its worker claims before startup.
  let result;
  try {
    result = herdr(config, ['tab', 'create', '--workspace', config.herdrWorkspace,
      '--cwd', path.dirname(here), '--label', `lane:${candidate.id}`, '--no-focus']);
  } catch (error) {
    // No worker was dispatched, even if the tab response was lost.
    save(stateFile, {...run, result: {status: 'failed', error: error.message,
      finishedAt: new Date().toISOString()}});
    throw new Error(`Herdr could not open a tab: ${error.message}; no ticket was claimed`);
  }
  run.pane = result?.root_pane?.pane_id;
  if (!run.pane) {
    save(stateFile, {...run, result: {status: 'failed', finishedAt: new Date().toISOString()}});
    throw new Error(`Herdr returned no pane; no ticket was claimed`);
  }
  save(stateFile, run);
  herdr(config, ['pane', 'run', run.pane,
    `${quote(process.execPath)} ${quote(path.join(here, 'worker.mjs'))} ${quote(stateFile)}`]);
  print(display ? '' : `started ${candidate.id} in ${run.pane}; logs: ${dir}`);
}

export async function main(argv) {
  let file = path.join(here, 'dolber.json'), mode = 'loop', selectedConfig = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config' && argv[i + 1] && !argv[i + 1].startsWith('-') && !selectedConfig) {
      file = path.resolve(argv[++i]); selectedConfig = true;
    }
    else if (!argv[i].startsWith('-') && !selectedConfig) {
      file = path.resolve(argv[i]); selectedConfig = true;
    }
    else if (['--once', '--dry-run'].includes(argv[i]) && mode === 'loop') mode = argv[i].slice(2);
    else if (['--help', '-h'].includes(argv[i])) { console.log(usage); return; }
    else throw new Error(`usage: ${usage}`);
  }
  if (!fs.existsSync(file)) throw new Error(`Configuration not found: ${file}. Copy ${path.join(here, 'dolber.example.json')} to this path and fill in workspace.`);
  const config = configFrom(file, process.env, {dryRun: mode === 'dry-run'});
  fs.mkdirSync(config.stateDir, {recursive: true, mode: 0o700});
  preflight(config);
  const lock = path.join(config.stateDir, 'dispatcher.lock');
  try { fs.mkdirSync(lock); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error(`Dispatcher lock exists: ${lock}. Check owner.json; remove only after its process has stopped.`);
  }
  save(path.join(lock, 'owner.json'), {pid: process.pid, startedAt: new Date().toISOString()});
  let stopped = false, wake;
  const stop = () => { stopped = true; wake?.(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  let dashboard, ticker;
  try {
    dashboard = process.stdout.isTTY && mode === 'loop' ? createDashboard(config, paint) : null;
    let deadline = null;
    const draw = () => {
      try { dashboard.draw(deadline == null ? null : Math.max(0, Math.ceil((deadline - performance.now()) / 1000))); }
      catch (error) { dashboard.state.fail(error.message); }
    };
    if (dashboard) { draw(); ticker = setInterval(draw, 5000); }
    do {
      deadline = null;
      try { await tick(config, dashboard?.state); }
      catch (error) {
        if (mode !== 'loop') throw error;
        if (dashboard) dashboard.state.fail(error.message);
        else console.error(paint('red', error.message));
      }
      if (dashboard) { dashboard.refresh(); draw(); }
      if (mode !== 'loop' || stopped) break;
      if (!process.stdout.isTTY) console.log(`pause ${config.intervalSeconds}s · Ctrl+C to stop\n`);
      await new Promise(resolve => {
        deadline = performance.now() + config.intervalSeconds * 1000;
        const timer = setTimeout(() => wake(), config.intervalSeconds * 1000);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
        if (dashboard) draw();
        if (stopped) wake();
      });
    } while (!stopped);
  } finally {
    clearInterval(ticker);
    try { dashboard?.close(); }
    finally {
      process.off('SIGINT', stop); process.off('SIGTERM', stop);
      fs.rmSync(lock, {recursive: true});
    }
    if (stopped && !dashboard) console.log('stopped');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(paint('red', error.message)); process.exitCode = 1; });
}
