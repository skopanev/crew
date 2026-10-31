#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {save, readRun, alive, quote, command, herdr, runDirectories} from './runtime.mjs';
import {runScope} from './scope.mjs';
import {createDashboard} from './dashboard.mjs';
import {nextTask, executionId} from './joppa.mjs';
import {configFrom} from './launcher-config.mjs';
export {configFrom} from './launcher-config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const useColor = process.env.NO_COLOR === undefined && process.env.FORCE_COLOR !== '0' &&
  (process.stdout.isTTY || (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0'));
const tones = {red: 31, blue: '1;34', yellow: '1;33', description: 33, ready: '1;38;2;70;230;90', available: '1;32', accent: '1;36', line: 36, finished: 37};
const paint = (tone, value) => useColor ? `\x1b[${tones[tone]}m${value}\x1b[0m` : String(value);
const divider = () => console.log(paint('line', '─'.repeat(Math.min(process.stdout.columns || 64, 64))));
export const usage = 'dolber-joppa.sh [config.json | --config <file>] [--once | --dry-run | --monitor]';
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
  if (!config.launchLanes) return {containers: [], panes: null};
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
  if (config.launchLanes && config.delivery !== 'branch' && !config.sharedLockDir) {
    throw new Error('Target delivery requires sharedLockDir; no ticket was claimed');
  }
  for (const bin of config.launchLanes ? ['medulla', 'jq'] : []) {
    command('bash', ['-c', 'command -v "$1"', '_', bin]);
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

export async function tick(config, display = null) {
  const print = display ? message => { display.message = message; } : console.log;
  if (display) { display.message = 'Checking tickets'; display.error = null; }
  const {containers, panes} = snapshots(config);
  const active = activeCount(config, containers, panes);
  if (display) display.containers = containers;
  else divider();
  print(`Running lanes ${paint(active >= config.limit ? 'yellow' : 'available', `${active} of ${config.limit}`)}`);
  if (active >= config.limit) { if (display) display.message = ''; return; }
  const selected = await nextTask(config);
  const candidate = selected.candidate;
  if (candidate && !candidate.finalizeOnly &&
      (candidate.tasks?.length !== 1 || candidate.tasks[0].address !== candidate.id)) {
    throw new Error('A new Joppa lane must contain exactly its selected Task');
  }
  if (display) display.counts = {open: selected.available, ready: String(selected.available), held: selected.held,
    blocked: candidate === null && selected.available > 0};
  else {
    print(`Joppa Tasks [workspace=${config.workspace}, project=${config.joppa.project}]: ${selected.available} available · ${selected.held} held workers`);
    print('checking params:');
    print(`  project: ${config.joppa.project}`);
  }
  if (!candidate) { if (display) display.message = 'No ready tickets'; return; }
  if (typeof candidate.id !== 'string' || !candidate.id) throw new Error('Joppa returned a Task without an id');
  print(`Starting new one with ticket: ${paint('accent', candidate.id)}${config.launchLanes ? '' : ' (preview: запуск отключён)'}`);
  if (!display && candidate.title) print(`  ${paint('description', candidate.title.replace(/[\r\n\x1b]/g, ' '))}`);
  if (!config.launchLanes) return;
  const dir = path.join(config.stateDir, 'runs', randomUUID());
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  const runFolder = path.join(fs.realpathSync(dir), 'lane');
  fs.mkdirSync(runFolder);
  const run = {ticket: candidate.id, workspace: config.workspace, config,
    runFolder, args: null, createdAt: new Date().toISOString(),
    task: candidate.id, taskRevision: candidate.revision, tasks: candidate.tasks, requirement: candidate.requirement,
    repositoryId: candidate.repository,
    executionId: executionId(candidate.finalizeOnly ? `${candidate.requirement}\n${candidate.repository}\n${path.basename(dir)}` :
      candidate.tasks?.length > 1 ? `${candidate.requirement}\n${candidate.repository}` : candidate.id),
    ...(candidate.finalizeOnly ? {finalizeOnly: true} : {}),
    deliveryBranch: `ticket-${executionId(candidate.tasks?.length > 1 ? `${candidate.requirement}\n${candidate.repository}` : candidate.id)}-${path.basename(dir)}`,
    joppaWorker: selected.worker};
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
  let file = path.join(here, 'dolber-joppa.json'), mode = 'loop', selectedConfig = false;
  for (let i = 0; i < argv.length; i++) {
    // Joppa is the only ticket source; the flag remains for existing launch scripts.
    if (argv[i] === '--source' && argv[i + 1] === 'joppa') i++;
    else if (argv[i] === '--config' && argv[i + 1] && !argv[i + 1].startsWith('-') && !selectedConfig) {
      file = path.resolve(argv[++i]); selectedConfig = true;
    }
    else if (!argv[i].startsWith('-') && !selectedConfig) {
      file = path.resolve(argv[i]); selectedConfig = true;
    }
    else if (['--once', '--dry-run', '--monitor'].includes(argv[i]) && mode === 'loop') mode = argv[i].slice(2);
    else if (['--help', '-h'].includes(argv[i])) { console.log(usage); return; }
    else throw new Error(`usage: ${usage}`);
  }
  if (!fs.existsSync(file)) throw new Error(`Configuration not found: ${file}. Copy ${path.join(here, 'dolber-joppa.example.json')} to this path and fill in workspace.`);
  const config = configFrom(file, process.env, {dryRun: mode === 'dry-run'});
  if (mode === 'monitor') {
    if (!process.stdout.isTTY) throw new Error('--monitor needs a terminal');
    const dashboard = createDashboard({...config, monitorOnly: true}, paint);
    dashboard.state.message = '';
    const draw = () => { dashboard.refresh(); dashboard.draw(null); };
    let ticker, stop;
    try {
      draw();
      ticker = setInterval(draw, 5000);
      await new Promise(resolve => {
        stop = resolve;
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      });
    } finally {
      clearInterval(ticker);
      if (stop) {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
      }
      dashboard.close();
    }
    return;
  }
  preflight(config);
  if (mode === 'dry-run') { await tick(config); return; }
  fs.mkdirSync(config.stateDir, {recursive: true, mode: 0o700});
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
