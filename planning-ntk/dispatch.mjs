#!/usr/bin/env node
// Blocked-ticket dispatcher: Dolber's sibling for stuck work.
//
// Dolber starts lanes for open tickets. A failed lane leaves its ticket
// `blocked`, and the review panel files its findings as `blocked` tickets
// too. Nothing walked that pile. This loop does: on each tick it takes the
// longest-blocked ticket with the dispatcher's tags and hands it to
// planning-ntk, which diagnoses it and publishes READY (back in the queue),
// NOT_READY (stays blocked, with the reason) or NEEDS_HUMAN (to_review, with
// the exact decision). One ticket at a time: planning-ntk holds one lock per
// workspace.
import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {request} from '../lane-launcher/ntk.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export function settings(file) {
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const key of ['id', 'workspace', 'stateDir', 'sourceRoot']) {
    if (typeof config[key] !== 'string' || !config[key]) throw new Error(`Config needs ${key}`);
  }
  const tags = Array.isArray(config.tags) ? config.tags : [];
  const dispatchTag = config.planning?.dispatchTag ?? 'crew';
  if (!tags.includes(dispatchTag)) throw new Error('planning.dispatchTag must be one of the dispatcher tags');
  const interval = config.planning?.dispatchIntervalSeconds ?? config.intervalSeconds ?? 60;
  if (!Number.isInteger(interval) || interval < 10) throw new Error('dispatch interval must be an integer of at least 10 seconds');
  const workspaceHash = crypto.createHash('sha256').update(config.workspace).digest('hex').slice(0, 24);
  return {
    workspace: config.workspace, strict: config.strict === true, sourceRoot: config.sourceRoot, interval,
    cbmCommand: config.cbmMcpCommand, cbmCache: config.cbmCacheDir, image: config.image,
    // planning-ntk removes the dispatch tag from a ticket it leaves blocked, so select without it.
    filterTags: tags.filter(tag => tag !== dispatchTag),
    stateDir: path.join(config.stateDir, 'planning-ntk', workspaceHash),
  };
}

// A ticket is a candidate when it changed since our last attempt and no lane
// worktree is retained for it (planning-ntk refuses those; an operator decides).
export function candidates(tickets, state, sourceRoot, exists = fs.existsSync) {
  const ready = [], held = [];
  for (const ticket of tickets) {
    if (state.tickets?.[ticket.id]?.stamp === ticket.updated_at) continue;
    (exists(path.join(sourceRoot, '.worktrees', ticket.id)) ? held : ready).push(ticket);
  }
  const age = ticket => ticket.current_status_at || ticket.updated_at || '';
  ready.sort((a, b) => age(a).localeCompare(age(b)) || a.id.localeCompare(b.id));
  return {ready, held};
}

async function blockedTickets(config) {
  const tickets = [];
  for (let offset = 0; offset !== undefined && offset !== null;) {
    const page = await request('GET', '/v1/tickets', {workspace: config.workspace, all: true, status: 'blocked',
      tag: config.filterTags.length ? config.filterTags.join(',') : undefined, strict: config.strict,
      limit: 100, offset});
    tickets.push(...(page?.tickets ?? []));
    offset = page?.next_offset;
  }
  return tickets;
}

const stateFile = config => path.join(config.stateDir, 'dispatch.json');
function readState(config) {
  try { return JSON.parse(fs.readFileSync(stateFile(config), 'utf8')); } catch { return {tickets: {}}; }
}
function saveState(config, state) {
  fs.mkdirSync(config.stateDir, {recursive: true});
  const temporary = `${stateFile(config)}.${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(temporary, stateFile(config));
}

function lock(config) {
  fs.mkdirSync(config.stateDir, {recursive: true});
  const file = path.join(config.stateDir, 'dispatch.lock');
  try {
    const pid = Number(fs.readFileSync(file, 'utf8'));
    if (pid && pid !== process.pid) { process.kill(pid, 0); throw new Error(`Another dispatcher runs as pid ${pid}`); }
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error;
  }
  fs.writeFileSync(file, String(process.pid));
  process.on('exit', () => { try { if (fs.readFileSync(file, 'utf8') === String(process.pid)) fs.unlinkSync(file); } catch {} });
}

// The same source and CBM refresh Dolber runs before a lane: fast-forward every
// canonical repository and re-index it, through the lane image. Planning reads
// the canonical worktrees and CBM, so without it plans stale code and research
// blocks on metadata_changed.
function syncSources(config) {
  for (const key of ['cbmCommand', 'cbmCache', 'image']) {
    if (!config[key]) throw new Error(`Config needs ${{cbmCommand: 'cbmMcpCommand', cbmCache: 'cbmCacheDir', image: 'image'}[key]} to refresh sources`);
  }
  const crew = path.dirname(here);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-cbm-'));
  try {
    const connector = path.join(dir, 'mcp.py');
    for (const [args, label] of [
      [[path.join(crew, 'lane/bridge/cbm-connect.py'), config.cbmCommand, config.sourceRoot, config.cbmCache, connector], 'CBM connector'],
      [[path.join(crew, 'lane-launcher/safe-sync.py'), config.sourceRoot, connector, config.image], 'source and CBM refresh'],
    ]) {
      if (label === 'source and CBM refresh') fs.chmodSync(connector, 0o600);
      const run = spawnSync('python3', args, {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});
      if (run.status !== 0) throw new Error(`${label} failed: ${(run.stderr || run.stdout || '').trim().split('\n').pop()}`);
    }
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
}

// The result of the planning run this tick started: the newest run directory.
export function runResult(config, since, root = path.join(config.stateDir, 'runs')) {
  let runs = [];
  try { runs = fs.readdirSync(root).map(name => path.join(root, name)); } catch { return null; }
  const fresh = runs.map(dir => ({dir, time: fs.statSync(dir).mtimeMs})).filter(run => run.time >= since - 1000)
    .sort((a, b) => b.time - a.time);
  try { return fresh.length ? JSON.parse(fs.readFileSync(path.join(fresh[0].dir, 'artifacts/result.json'), 'utf8')) : null; } catch { return null; }
}

export async function tick(configFile, config, {dryRun = false} = {}) {
  const state = readState(config);
  state.tickets ??= {};
  const {ready, held} = candidates(await blockedTickets(config), state, config.sourceRoot);
  for (const ticket of held) {
    if (state.tickets[ticket.id]?.held !== ticket.updated_at) {
      console.log(`${ticket.id}: retained .worktrees/${ticket.id}; inspect it, then remove it or reopen the ticket`);
      if (!dryRun) state.tickets[ticket.id] = {...state.tickets[ticket.id], held: ticket.updated_at};
    }
  }
  if (dryRun) {
    console.log(`blocked, changed since last attempt: ${ready.length}`);
    for (const ticket of ready) console.log(`  ${ticket.id}  ${ticket.current_status_at}  ${ticket.title}`);
    return null;
  }
  saveState(config, state);
  const ticket = ready[0];
  if (!ticket) return null;
  syncSources(config);
  console.log(`${new Date().toISOString()} planning ${ticket.id}: ${ticket.title}`);
  const started = Date.now();
  const logs = path.join(config.stateDir, 'dispatch-logs');
  fs.mkdirSync(logs, {recursive: true});
  const log = path.join(logs, `${ticket.id}-${Date.now()}.log`);
  const run = spawnSync('sh', [path.join(here, 'run.sh'), '--config', configFile, '--ticket-id', ticket.id],
    {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
  fs.writeFileSync(log, (run.stdout || '') + (run.stderr || ''));
  // Record the ticket as it is after planning, so only a later change brings it back.
  let after = ticket.updated_at;
  try { after = (await request('GET', `/v1/tickets/${encodeURIComponent(ticket.id)}`, {workspace: config.workspace}))?.ticket?.updated_at ?? after; } catch {}
  const last = ((run.stderr || run.stdout || '').trim().split('\n').pop() || '').slice(0, 300);
  console.log(`${ticket.id}: planning-ntk exit ${run.status}${last ? ` · ${last}` : ''}`);
  // A run that did not complete left the ticket untouched and says so in its
  // result: the environment failed (CBM, Equill, an agent). Do not mark it
  // attempted, and stop the loop, so the same fault does not walk the whole
  // queue. Fix it, then start again. A published NOT_READY is a verdict.
  const result = runResult(config, started);
  const untouched = result ? result.ticket_unchanged === true : after === ticket.updated_at;
  if (run.status !== 0 && untouched) {
    state.tickets[ticket.id] = {...state.tickets[ticket.id], failed: {exit: run.status, at: new Date().toISOString(), log}};
    saveState(config, state);
    return {id: ticket.id, exit: run.status, environment: true, log};
  }
  state.tickets[ticket.id] = {stamp: after, exit: run.status, at: new Date().toISOString(), log};
  saveState(config, state);
  return {id: ticket.id, exit: run.status};
}

async function main(argv) {
  const configFile = argv.find(arg => !arg.startsWith('--'));
  if (!configFile) throw new Error('usage: dispatch.mjs CONFIG.json [--once] [--dry-run]');
  const file = path.resolve(configFile);
  const config = settings(file);
  const dryRun = argv.includes('--dry-run');
  if (dryRun) return tick(file, config, {dryRun});
  lock(config);
  do {
    const result = await tick(file, config);
    if (result?.environment) throw new Error(`planning failed before it touched ${result.id}; see ${result.log}`);
    if (argv.includes('--once')) break;
    await new Promise(resolve => setTimeout(resolve, config.interval * 1000));
  } while (true);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(`dispatch: ${error.message}`); process.exit(1); });
}
