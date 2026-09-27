#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {nextTicket, credentials} from './ntk.mjs';
import {save, read, alive, quote, command, herdr, laneArgs, runDirectories} from './runtime.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const useColor = process.env.NO_COLOR === undefined && process.env.FORCE_COLOR !== '0' &&
  (process.stdout.isTTY || (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0'));
const tones = {red: 31, yellow: '1;33', description: 33, available: '1;32', accent: '1;36', line: 36};
const paint = (tone, value) => useColor ? `\x1b[${tones[tone]}m${value}\x1b[0m` : String(value);
const divider = () => console.log(paint('line', '─'.repeat(Math.min(process.stdout.columns || 64, 64))));
export const usage = 'dolber.sh [--config <file>] [--once | --dry-run]';
export function configFrom(file, env = process.env, {dryRun = false} = {}) {
  const config = {limit: 1, intervalSeconds: 60, tags: [], strict: false, launchLanes: false, closeTabOnExit: false,
    preferTags: [], readOnlyRepos: [],
    stateDir: path.join(os.homedir(), '.medulla/lane-launcher'),
    herdr: env.HERDR_BIN_PATH || 'herdr', herdrWorkspace: env.HERDR_WORKSPACE_ID,
    ...read(file)};
  if (dryRun) config.launchLanes = false;
  // The terminal running dolber owns the destination workspace.
  config.herdrWorkspace = env.HERDR_WORKSPACE_ID || config.herdrWorkspace;
  for (const field of config.launchLanes ? ['workspace', 'project', 'herdrWorkspace'] : ['workspace']) {
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
  for (const field of ['module', 'assignee']) {
    if (config[field] != null && (typeof config[field] !== 'string' || !config[field].trim())) {
      throw new Error(`${field} must be a nonempty string or null`);
    }
  }
  if ('tag' in config) throw new Error('Use tags: ["crew"] in dolber.json instead of tag');
  if (typeof config.stateDir !== 'string' || !path.isAbsolute(config.stateDir)) throw new Error('stateDir must be absolute');
  for (const field of ['limit', 'intervalSeconds']) {
    if (!Number.isSafeInteger(config[field]) || config[field] < 1) throw new Error(`${field} must be a positive integer`);
  }
  if (config.project != null && typeof config.project !== 'string') throw new Error('project must be a string or null');
  if (!config.launchLanes) return config;
  if (!Array.isArray(config.gateCommands) || !config.gateCommands.length ||
      config.gateCommands.some(check => typeof check !== 'string' || !check.trim())) {
    throw new Error('Config needs gateCommands: a nonempty array of repository checks');
  }
  if (!Array.isArray(config.readOnlyRepos)) throw new Error('readOnlyRepos must be an array');
  for (const dir of [config.repo, config.cbmStore, config.sshDir, ...config.readOnlyRepos]) {
    if (typeof dir !== 'string' || !path.isAbsolute(dir) || !fs.statSync(dir).isDirectory()) {
      throw new Error(`Directory must exist and be absolute: ${dir}`);
    }
  }
  if (!fs.existsSync(path.join(config.repo, '.git'))) throw new Error('repo must be a Git checkout');
  config.repo = fs.realpathSync(config.repo);
  return config;
}

export function dockerLanes(output) {
  return output.split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => {
    const labels = Object.fromEntries((row.Labels || '').split(',').filter(Boolean).map(label => {
      const at = label.indexOf('='); return [label.slice(0, at), label.slice(at + 1)];
    }));
    row.runFolder = labels['medulla.runs_under'];
    return labels['medulla.workflow'] === 'lane' ||
      (!labels['medulla.workflow'] && (row.Names || '').startsWith('medulla-'));
  });
}

export function activeCount(config, containers, panes) {
  let count = containers.length;
  for (const dir of runDirectories(config.stateDir)) {
    const stateFile = path.join(dir, 'launch.json');
    if (!fs.existsSync(stateFile)) continue;
    const run = read(stateFile);
    if (fs.existsSync(path.join(dir, 'result.json'))) continue;
    const workerFile = path.join(dir, 'worker.json');
    const worker = fs.existsSync(workerFile) ? read(workerFile) : null;
    const containerRunning = containers.some(container => container.runFolder === run.runFolder);
    if (containerRunning) continue; // Already counted by Docker.
    if (panes && run.pane && !panes.has(run.pane) && (!worker || !alive(worker.pid))) {
      save(path.join(dir, 'result.json'), {status: 'interrupted', finishedAt: new Date().toISOString(),
        error: 'Herdr pane and worker disappeared; inspect lane artifacts before reopening the ticket'});
      continue;
    }
    // Reserve capacity even before the worker/container has appeared.
    count++;
  }
  return count;
}

function snapshots(config) {
  const containers = dockerLanes(command('docker', ['ps', '--format', '{{json .}}']));
  if (!config.launchLanes) return {containers, panes: null};
  const result = herdr(config, ['pane', 'list', '--workspace', config.herdrWorkspace]);
  if (!Array.isArray(result?.panes)) throw new Error('Herdr returned no pane list; refusing to assume free capacity');
  return {containers, panes: new Set(result.panes.map(pane => pane.pane_id))};
}

function preflight(config) {
  credentials();
  for (const bin of config.launchLanes ? ['node', 'medulla', 'jq'] : ['node']) {
    command('bash', ['-c', 'command -v "$1"', '_', bin]);
  }
  return snapshots(config);
}

export async function tick(config) {
  const {containers, panes} = snapshots(config);
  const active = activeCount(config, containers, panes);
  divider();
  console.log(`lanes ${paint(active >= config.limit ? 'yellow' : 'available', `${active} of ${config.limit}`)}`);
  if (active >= config.limit) return;
  const query = {workspace: config.workspace, project: config.project || undefined,
    tag: config.tags.length ? config.tags.join(',') : undefined,
    prefer: config.preferTags.length ? config.preferTags.join(',') : undefined,
    module: config.module ?? undefined, assignee: config.assignee ?? undefined,
    strict: config.strict, has_module: true, dry_run: true};
  console.log('checking params:');
  console.log(`  tags: ${config.tags.join(', ') || '(any)'}`);
  console.log(`  prefer: ${config.preferTags.join(' → ') || '(none)'}`);
  const candidate = await nextTicket(query);
  if (!candidate) { console.log('no open tickets matching dolber.json filters'); return; }
  if (typeof candidate.id !== 'string' || !candidate.id) throw new Error('NTK returned a ticket without an id');
  console.log(`Запускаю lane на тикет id: ${paint('accent', candidate.id)}${config.launchLanes ? '' : ' (preview: запуск отключён)'}`);
  if (candidate.title) console.log(`  ${paint('description', candidate.title.replace(/[\r\n\x1b]/g, ' '))}`);
  if (!config.launchLanes) return;
  const dir = path.join(config.stateDir, 'runs', randomUUID());
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  const runFolder = path.join(fs.realpathSync(dir), 'lane');
  fs.mkdirSync(runFolder);
  const run = {ticket: candidate.id, workspace: config.workspace, config,
    runFolder, args: laneArgs(config, candidate.id), createdAt: new Date().toISOString()};
  const stateFile = path.join(dir, 'launch.json');
  save(stateFile, run);
  // Commit reservation before opening a tab. Unknown launch outcomes keep the slot occupied.
  const result = herdr(config, ['tab', 'create', '--workspace', config.herdrWorkspace,
    '--cwd', path.dirname(here), '--label', `lane:${candidate.id}`, '--no-focus']);
  run.pane = result?.root_pane?.pane_id;
  if (!run.pane) throw new Error(`Herdr did not return a pane; reservation retained at ${dir}`);
  save(stateFile, run);
  herdr(config, ['pane', 'run', run.pane,
    `${quote(process.execPath)} ${quote(path.join(here, 'worker.mjs'))} ${quote(stateFile)}`]);
  console.log(`started ${candidate.id} in ${run.pane}; logs: ${dir}`);
}

export async function main(argv) {
  let file = path.join(here, 'dolber.json'), mode = 'loop';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config' && argv[i + 1]) file = path.resolve(argv[++i]);
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
  try {
    do {
      try { await tick(config); }
      catch (error) {
        if (mode !== 'loop') throw error;
        console.error(paint('red', error.message));
      }
      if (mode !== 'loop' || stopped) break;
      console.log(`pause ${config.intervalSeconds}s · Ctrl+C to stop\n`);
      await new Promise(resolve => {
        const timer = setTimeout(resolve, config.intervalSeconds * 1000);
        wake = () => { clearTimeout(timer); resolve(); };
        if (stopped) wake();
      });
    } while (!stopped);
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    fs.rmSync(lock, {recursive: true});
    if (stopped) console.log('stopped');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(paint('red', error.message)); process.exitCode = 1; });
}
