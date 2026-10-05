#!/usr/bin/env node
// Blocked-ticket dispatcher: Dolber's sibling for stuck work.
//
// Dolber starts lanes for open tickets. A failed lane leaves its ticket
// `blocked`, and the review panel files its findings as `blocked` tickets
// too. Nothing walked that pile. This loop does: on each tick it takes the
// longest-blocked ticket with the dispatcher's tags and hands it to
// planning-ntk, which diagnoses it and publishes READY (back in the queue),
// NOT_READY (stays blocked, with the reason) or NEEDS_HUMAN (blocked, with
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
const useColor = stream => !process.env.NO_COLOR && process.env.FORCE_COLOR !== '0' &&
  (stream.isTTY || (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0'));
const tones = {blue: '1;34', green: '1;32', yellow: '1;33', red: '1;31', title: 33, label: 37, line: 36, ticket: '1;36'};
const paint = (tone, text, stream = process.stdout) => useColor(stream) ? `\x1b[${tones[tone]}m${text}\x1b[0m` : String(text);
const field = (label, value) => console.log(`  ${paint('label', `${label}:`)} ${value}`);
const divider = () => console.log(paint('line', '─'.repeat(Math.min(process.stdout.columns || 64, 64))));

export function settings(file) {
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const key of ['id', 'workspace', 'stateDir', 'sourceRoot']) {
    if (typeof config[key] !== 'string' || !config[key]) throw new Error(`Config needs ${key}`);
  }
  const tags = Array.isArray(config.tags) ? config.tags : [];
  const dispatchTag = config.planning?.dispatchTag ?? 'crew';
  if (!tags.includes(dispatchTag)) throw new Error('planning.dispatchTag must be one of the dispatcher tags');
  // An empty filter would select every blocked ticket in the workspace.
  if (!tags.length || !tags.every(tag => typeof tag === 'string' && tag.trim())) throw new Error('Config needs non-empty tags');
  const interval = config.planning?.dispatchIntervalSeconds ?? config.intervalSeconds ?? 60;
  if (!Number.isInteger(interval) || interval < 10) throw new Error('dispatch interval must be an integer of at least 10 seconds');
  const workspaceHash = crypto.createHash('sha256').update(config.workspace).digest('hex').slice(0, 24);
  return {
    workspace: config.workspace, strict: config.strict === true, sourceRoot: config.sourceRoot, interval,
    cbmCommand: config.cbmMcpCommand, cbmCache: config.cbmCacheDir, image: config.image,
    // All configured tags, the dispatch tag included: a lane failure keeps it,
    // and a settled NOT_READY loses it, so the planner does not revisit it.
    filterTags: tags,
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
      tag: config.filterTags.join(','), strict: config.strict,
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

// Exclusive create, fail closed. A lock left by a dead dispatcher is never
// removed automatically: between reading its owner and removing it, another
// dispatcher may have replaced it. An operator checks the pid and removes it.
export function lock(stateDir, pid = process.pid) {
  fs.mkdirSync(stateDir, {recursive: true});
  const file = path.join(stateDir, 'dispatch.lock');
  try {
    fs.writeFileSync(file, String(pid), {flag: 'wx'});
    return file;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  let owner = '';
  try { owner = fs.readFileSync(file, 'utf8').trim(); } catch {}
  throw new Error(`Another dispatcher holds ${file}${owner ? ` (pid ${owner})` : ''}. ` +
    'If no dispatcher runs for this workspace, remove the file and start again.');
}

// The same source and CBM refresh Dolber runs before a lane: fast-forward every
// canonical repository and re-index it, through the lane image. Planning reads
// the canonical worktrees and CBM, so without it plans stale code and research
// blocks on metadata_changed.
function syncSources(config, logs) {
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
      if (run.status !== 0) {
        // Keep the whole output: the last line rarely names the cause.
        fs.mkdirSync(logs, {recursive: true});
        const log = path.join(logs, `sync-${Date.now()}.log`);
        fs.writeFileSync(log, `${label}\n${run.stdout || ''}${run.stderr || ''}`);
        throw new Error(`${label} failed: ${(run.stderr || run.stdout || '').trim().split('\n').pop()}; see ${log}`);
      }
    }
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
}

// The result of the planning run this tick started. The dispatcher names the
// run directory (MEDULLA_RUN_DIR_NAME), so no other run can be mistaken for it.
export function runResult(config, name) {
  try { return JSON.parse(fs.readFileSync(path.join(config.stateDir, 'runs', name, 'artifacts/result.json'), 'utf8')); } catch { return null; }
}

// A run that left no verdict: the environment failed before publication
// (ticket_unchanged), or a publication started and did not confirm. Neither
// is marked processed; both stop the loop for an operator.
// Code moved under a run that published nothing: plan it again once against
// current code. A second drift stops the loop like any incomplete run.
export const DRIFT_RETRIES = 1;
export function replanForDrift(result, attempt) {
  return result?.code_drift === true && result.ticket_unchanged === true && attempt < DRIFT_RETRIES;
}

export function incomplete(result) {
  return !result || result.ticket_unchanged === true || result.publication_uncertain === true;
}

export async function tick(configFile, config, {dryRun = false} = {}) {
  const state = readState(config);
  state.tickets ??= {};
  const {ready, held} = candidates(await blockedTickets(config), state, config.sourceRoot);
  divider();
  console.log(paint('blue', 'PLANNER'));
  field('Filter', `workspace=${config.workspace}, tags=${config.filterTags.join(',')}, strict=${config.strict}`);
  field('Tickets', `${paint('green', `${ready.length} ready to plan`)} · ${paint('yellow', `${held.length} retained worktrees`)}`);
  for (const ticket of held) {
    if (state.tickets[ticket.id]?.held !== ticket.updated_at) {
      console.log(`${paint('yellow', 'HELD')} ${paint('ticket', ticket.id)} · .worktrees/${ticket.id}`);
      console.log('  Inspect it, then remove it or reopen the ticket.');
      if (!dryRun) state.tickets[ticket.id] = {...state.tickets[ticket.id], held: ticket.updated_at};
    }
  }
  if (dryRun) {
    field('Mode', 'dry-run · tickets unchanged');
    for (const ticket of ready) {
      console.log(`  ${paint('ticket', ticket.id)} · blocked since ${ticket.current_status_at || ticket.updated_at}`);
      console.log(`    ${paint('title', ticket.title)}`);
    }
    return null;
  }
  saveState(config, state);
  const ticket = ready[0];
  if (!ticket) {
    console.log(paint('label', 'IDLE · no changed blocked tickets to plan'));
    return null;
  }
  const started = Date.now();
  console.log(`\n${paint('blue', 'RUNNING')} ${paint('ticket', ticket.id)}`);
  console.log(`  ${paint('title', ticket.title)}`);
  field('Started', new Date(started).toISOString());
  const logs = path.join(config.stateDir, 'dispatch-logs');
  fs.mkdirSync(logs, {recursive: true});
  let run, runName, log, result;
  for (let attempt = 0; ; attempt++) {
    field('Stage', paint('blue', 'preflight · Git and CBM'));
    syncSources(config, logs);
    field('Stage', paint('blue', 'planning · research, design and review'));
    runName = `dispatch-${ticket.id}-${Date.now()}`;
    log = path.join(logs, `${runName}.log`);
    field('Log', log);
    run = spawnSync('sh', [path.join(here, 'run.sh'), '--config', configFile, '--ticket-id', ticket.id],
      {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: {...process.env, MEDULLA_RUN_DIR_NAME: runName}});
    fs.writeFileSync(log, (run.stdout || '') + (run.stderr || ''));
    result = runResult(config, runName);
    if (run.status === 0 || !replanForDrift(result, attempt)) break;
    field('Stage', paint('yellow', 'source changed during planning · planning once more against current code'));
  }
  // Record the ticket as it is after planning, so only a later change brings it back.
  let after = ticket.updated_at;
  try { after = (await request('GET', `/v1/tickets/${encodeURIComponent(ticket.id)}`, {workspace: config.workspace}))?.ticket?.updated_at ?? after; } catch {}
  const last = (run.stderr || run.stdout || '').trim().split('\n').pop() || '';
  // Do not mark an incomplete run attempted, and stop the loop, so the same
  // fault does not walk the whole queue. Fix it, then start again. A published
  // NOT_READY is a verdict and is recorded like any other.
  const verdict = incomplete(result) ? 'FAILED' : result.verdict ?? 'UNKNOWN';
  const tone = verdict === 'READY' ? 'green' : ['NOT_READY', 'NEEDS_HUMAN'].includes(verdict) ? 'yellow' : 'red';
  console.log(`\n${paint(tone, verdict)} ${paint('ticket', ticket.id)} · ${((Date.now() - started) / 1000).toFixed(1)}s`);
  field('Exit', run.status ?? run.signal ?? run.error?.message ?? 'unknown');
  if (result?.reason || (run.status !== 0 && last)) field('Reason', paint(tone, result?.reason || last));
  if (verdict === 'NEEDS_HUMAN') {
    field('Owner', result.owner);
    field('Decision', result.decision);
  }
  if (run.status !== 0 && incomplete(result)) {
    state.tickets[ticket.id] = {...state.tickets[ticket.id], failed: {exit: run.status, at: new Date().toISOString(), log,
      uncertain: result?.publication_uncertain === true}};
    saveState(config, state);
    return {id: ticket.id, exit: run.status, environment: true, uncertain: result?.publication_uncertain === true,
      drift: result?.code_drift === true, log};
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
  const held = lock(config.stateDir);
  process.on('exit', () => { try { if (fs.readFileSync(held, 'utf8') === String(process.pid)) fs.unlinkSync(held); } catch {} });
  process.on('SIGINT', () => process.exit(130));
  process.on('SIGTERM', () => process.exit(143));
  do {
    const result = await tick(file, config);
    if (result?.uncertain) {
      throw new Error(`publication for ${result.id} started and did not confirm; inspect the ticket in NTK ` +
        `before any other run of it, and do not resume blindly; see ${result.log}`);
    }
    if (result?.drift) {
      throw new Error(`source changed again while ${result.id} was re-planned; nothing was published. ` +
        `Start again when the target branch is quiet; see ${result.log}`);
    }
    if (result?.environment) throw new Error(`planning failed before it touched ${result.id}; see ${result.log}`);
    if (argv.includes('--once')) break;
    console.log(`\n${paint('blue', `Pause ${config.interval}s`)} · Ctrl+C to stop\n`);
    await new Promise(resolve => setTimeout(resolve, config.interval * 1000));
  } while (true);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(paint('red', `PLANNER FAILED · ${error.message}`, process.stderr)); process.exit(1); });
}
