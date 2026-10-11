#!/usr/bin/env node
// Blocked-ticket dispatcher: Dolber's sibling for stuck work.
//
// Dolber starts lanes for open tickets. A failed lane leaves its ticket
// `blocked`, and the review panel files its findings as `blocked` tickets
// too. This loop alternates between decomposition children and other
// blocked tickets, oldest first within each group. It hands each ticket to
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
import {closeParents} from './ntk.mjs';

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
  const filterTags = config.planning?.tags ?? tags;
  const dispatchTag = config.planning?.dispatchTag ?? 'crew';
  if (!tags.includes(dispatchTag)) throw new Error('planning.dispatchTag must be one of the dispatcher tags');
  // An empty filter would select every blocked ticket in the workspace.
  if (!Array.isArray(filterTags) || !filterTags.length || !filterTags.every(tag => typeof tag === 'string' && tag.trim())) throw new Error('Config needs non-empty tags');
  const tagMatch = config.planning?.tagMatch ?? 'all';
  if (!['all', 'any'].includes(tagMatch)) throw new Error('planning.tagMatch must be all or any');
  const interval = config.planning?.dispatchIntervalSeconds ?? config.intervalSeconds ?? 60;
  if (!Number.isInteger(interval) || interval < 10) throw new Error('dispatch interval must be an integer of at least 10 seconds');
  const workspaceHash = crypto.createHash('sha256').update(config.workspace).digest('hex').slice(0, 24);
  return {
    workspace: config.workspace, strict: config.strict === true, sourceRoot: config.sourceRoot, interval,
    cbmCommand: config.cbmMcpCommand, cbmCache: config.cbmCacheDir, image: config.image,
    filterTags, tagMatch, dispatchTag,
    stateDir: path.join(config.stateDir, 'planning-ntk', workspaceHash),
  };
}

// Planning removes retained worktrees for selected blocked tickets.
export const MAX_DEFERRALS = 3;
export function candidates(tickets, state) {
  const ready = [], held = [];
  const childIds = new Set(Object.values(state.tickets ?? {}).flatMap(entry => entry.children ?? []));
  for (const ticket of tickets) {
    if (state.tickets?.[ticket.id]?.failed?.uncertain) {
      held.push(ticket);
      continue;
    }
    if (state.tickets?.[ticket.id]?.stamp === ticket.updated_at) continue;
    const deferred = state.tickets?.[ticket.id]?.deferrals;
    const exhausted = deferred?.stamp === ticket.updated_at && deferred.count >= MAX_DEFERRALS;
    (exhausted ? held : ready).push(ticket);
  }
  const age = ticket => ticket.current_status_at || ticket.updated_at || '';
  const priority = ticket => childIds.has(ticket.id) === (state.preferChildren !== false) ? 0 : 1;
  ready.sort((a, b) => priority(a) - priority(b) || age(a).localeCompare(age(b)) || a.id.localeCompare(b.id));
  return {ready, held, childIds};
}

async function blockedTickets(config) {
  const filters = config.tagMatch === 'any' ? config.filterTags : [config.filterTags.join(',')];
  const lists = await Promise.all(filters.map(async tag => {
    const tickets = [];
    for (let offset = 0; offset !== undefined && offset !== null;) {
      const page = await request('GET', '/v1/tickets', {workspace: config.workspace, all: true, status: 'blocked',
        tag, strict: config.strict, limit: 100, offset});
      tickets.push(...(page?.tickets ?? []));
      offset = page?.next_offset;
    }
    return tickets;
  }));
  return [...new Map(lists.flat().map(ticket => [ticket.id, ticket])).values()]
    .filter(ticket => !ticket.title.startsWith('[HUMAN] ') || ticket.tags?.includes(config.dispatchTag));
}

const stateFile = config => path.join(config.stateDir, 'dispatch.json');
function readState(config) {
  try { return JSON.parse(fs.readFileSync(stateFile(config), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return {tickets: {}};
    throw new Error(`Cannot read planner state ${stateFile(config)}: ${error.message}`);
  }
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
        const reason = `${label} failed: ${run.error?.message ||
          (run.stderr || run.stdout || '').trim().split('\n').pop() || run.signal || run.status}`;
        if (run.status === 75) return {log, reason};
        throw new Error(`${reason}; see ${log}`);
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

function decomposedChildren(result, id) {
  return result?.id === id && result.verdict === 'DECOMPOSED' && !incomplete(result) &&
    Array.isArray(result.children) && result.children.length > 0 &&
    result.children.every(child => typeof child === 'string' && child.trim()) ? result.children : null;
}

// Restore child IDs from confirmed runs made before the dispatcher saved them.
function restoreChildren(config, state) {
  for (const [id, entry] of Object.entries(state.tickets)) {
    if (entry.children || entry.exit !== 0 || entry.failed?.uncertain || !entry.log) continue;
    const children = decomposedChildren(runResult(config, path.basename(entry.log, '.log')), id);
    if (children) entry.children = children;
  }
}

// A run that left no verdict: the environment failed before publication
// (ticket_unchanged), or a publication started and did not confirm. Neither
// is marked processed. Uncertain publication holds that ticket for an operator.
// Other failed runs defer that ticket while continuous mode serves the queue.
// Code moved under a run that published nothing: plan it again once against
// current code. A second drift defers the ticket until a later cycle.
export const DRIFT_RETRIES = 1;
export function replanForDrift(result, attempt) {
  return result?.code_drift === true && result.ticket_unchanged === true && result.published === false &&
    result.publication_uncertain !== true && attempt < DRIFT_RETRIES;
}

export function incomplete(result) {
  return !result?.verdict || result.ticket_unchanged === true || result.publication_uncertain === true;
}

export function deferForDrift(result) {
  return (result?.source_drift === true || result?.code_drift === true) &&
    result.ticket_unchanged === true && result.published === false && result.publication_uncertain !== true;
}

export async function tick(configFile, config, {dryRun = false, deferred = new Set(), retryPoll = false} = {}) {
  const state = readState(config);
  state.tickets ??= {};
  restoreChildren(config, state);
  if (!dryRun) await closeParents(config, state);
  let tickets;
  try { tickets = await blockedTickets(config); } catch (error) {
    if (!retryPoll || !['fetch failed', 'The operation was aborted due to timeout'].includes(error.message)) throw error;
    console.log(paint('yellow', `DEFERRED · NTK queue poll failed: ${error.message}`));
    return null;
  }
  const {ready, held, childIds} = candidates(tickets, state);
  divider();
  console.log(paint('blue', 'PLANNER'));
  field('Filter', `workspace=${config.workspace}, tags=${config.filterTags.join(config.tagMatch === 'any' ? ' OR ' : ' AND ')}, strict=${config.strict}`);
  field('Tickets', `${paint('green', `${ready.length} ready to plan`)} · ${paint('yellow', `${held.length} held`)}`);
  for (const ticket of held) {
    if (state.tickets[ticket.id]?.held !== ticket.updated_at) {
      const drift = state.tickets[ticket.id]?.deferrals;
      const uncertain = state.tickets[ticket.id]?.failed?.uncertain;
      console.log(`${paint('yellow', 'HELD')} ${paint('ticket', ticket.id)} · ${uncertain ? 'PUBLICATION_UNCERTAIN' : `${drift.reason_code || 'INPUT_CHANGED'} · ${drift.count} deferrals`}`);
      console.log(uncertain ? '  Inspect NTK and the publication receipt before resuming this run.' :
        '  Check the failed run. Update the ticket when it is ready for another attempt.');
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
  const ticket = ready.find(item => !deferred.has(item.id));
  if (!ticket) {
    const pending = ready.filter(item => deferred.has(item.id)).length;
    console.log(paint('label', pending ? `IDLE · ${pending} deferred until next cycle` :
      'IDLE · no changed blocked tickets to plan'));
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
    let preflight;
    try { preflight = syncSources(config, logs); }
    catch (error) { preflight = {reason: error.message, log: logs}; }
    if (preflight) {
      console.log(`\n${paint('yellow', 'DEFERRED')} ${paint('ticket', ticket.id)} · preflight failed`);
      field('Reason', paint('yellow', preflight.reason));
      field('Log', preflight.log);
      return {id: ticket.id, environment: true, preflight: true, log: preflight.log};
    }
    field('Stage', paint('blue', 'planning · research, design and review'));
    runName = `dispatch-${ticket.id}-${Date.now()}`;
    log = path.join(logs, `${runName}.log`);
    field('Log', log);
    // Keep this ticket held if launch or result handling fails unexpectedly.
    state.tickets[ticket.id] = {...state.tickets[ticket.id],
      failed: {at: new Date().toISOString(), log, uncertain: true}};
    state.preferChildren = !childIds.has(ticket.id);
    saveState(config, state);
    run = spawnSync('sh', [path.join(here, 'run.sh'), '--config', configFile, '--ticket-id', ticket.id],
      {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: {...process.env, MEDULLA_RUN_DIR_NAME: runName}});
    fs.writeFileSync(log, (run.stdout || '') + (run.stderr || ''));
    result = runResult(config, runName);
    if (result?.preflight_timeout === true && result.ticket_unchanged === true && result.published === false &&
        result.publication_uncertain !== true && !fs.existsSync(path.join(config.stateDir, 'runs', runName, 'artifacts/publication-started.json'))) {
      console.log(`\n${paint('yellow', 'DEFERRED')} ${paint('ticket', ticket.id)} · preparation timed out`);
      field('Reason', paint('yellow', result.reason));
      field('Log', log);
      delete state.tickets[ticket.id].failed;
      saveState(config, state);
      return {id: ticket.id, environment: true, preflight: true, reason: result.reason, log};
    }
    if (run.status === 75 && !fs.existsSync(path.join(config.stateDir, 'runs', runName))) {
      console.log(`\n${paint('yellow', 'DEFERRED')} ${paint('ticket', ticket.id)} · role check timed out`);
      field('Log', log);
      delete state.tickets[ticket.id].failed;
      saveState(config, state);
      return {id: ticket.id, environment: true, preflight: true, log};
    }
    if (run.status === 0 || !replanForDrift(result, attempt) ||
        fs.existsSync(path.join(config.stateDir, 'runs', runName, 'artifacts/publication-started.json'))) break;
    delete state.tickets[ticket.id].failed;
    saveState(config, state);
    field('Stage', paint('yellow', 'source changed during planning · planning once more against current code'));
  }
  // Record the ticket as it is after planning, so only a later change brings it back.
  let after = ticket.updated_at;
  try { after = (await request('GET', `/v1/tickets/${encodeURIComponent(ticket.id)}`, {workspace: config.workspace}))?.ticket?.updated_at ?? after; } catch {}
  const last = (run.stderr || run.stdout || '').trim().split('\n').pop() || '';
  // Do not mark an incomplete run processed. Defer or hold that ticket.
  // Continuous mode serves the remaining queue. A published
  // NOT_READY is a verdict and is recorded like any other.
  const incompleteRun = incomplete(result);
  const uncertain = incompleteRun && (result?.publication_uncertain === true ||
    fs.existsSync(path.join(config.stateDir, 'runs', runName, 'artifacts/publication-started.json')));
  const postpone = !uncertain && (deferForDrift(result) || incompleteRun);
  const verdict = deferForDrift(result) ? 'DEFERRED' : incompleteRun ? 'FAILED' : result.verdict ?? 'UNKNOWN';
  const tone = verdict === 'READY' ? 'green' : verdict === 'DECOMPOSED' ? 'blue' : ['NOT_READY', 'NEEDS_HUMAN', 'DEFERRED'].includes(verdict) ? 'yellow' : 'red';
  console.log(`\n${paint(tone, verdict)} ${paint('ticket', ticket.id)} · ${((Date.now() - started) / 1000).toFixed(1)}s`);
  field('Exit', run.status ?? run.signal ?? run.error?.message ?? 'unknown');
  if (result?.reason || (run.status !== 0 && last)) field('Reason', paint(tone, result?.reason || last));
  if (verdict === 'NEEDS_HUMAN') {
    field('Owner', result.owner);
    field('Decision', result.decision);
  }
  if (postpone) {
    delete state.tickets[ticket.id].failed;
    const previous = state.tickets[ticket.id]?.deferrals;
    const count = (previous?.stamp === ticket.updated_at ? previous.count : 0) + 1;
    state.tickets[ticket.id] = {...state.tickets[ticket.id],
      deferrals: {count, stamp: after, at: new Date().toISOString(), log,
        reason_code: deferForDrift(result) ? 'INPUT_CHANGED' : 'PLANNING_FAILED'}};
    saveState(config, state);
    return {id: ticket.id, deferred: true, exit: incompleteRun && run.status === 0 ? 1 : run.status, log};
  }
  if (incompleteRun) {
    state.tickets[ticket.id] = {...state.tickets[ticket.id], failed: {exit: run.status, at: new Date().toISOString(), log,
      uncertain}};
    saveState(config, state);
    return {id: ticket.id, exit: run.status, environment: true, uncertain,
      title: ticket.title, reason: result?.reason, log};
  }
  state.tickets[ticket.id] = {stamp: after, exit: run.status, at: new Date().toISOString(), log};
  const children = run.status === 0 ? decomposedChildren(result, ticket.id) : null;
  if (children) state.tickets[ticket.id].children = children;
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
  const deferred = new Set();
  do {
    let result;
    try { result = await tick(file, config, {deferred, retryPoll: !argv.includes('--once')}); }
    catch (error) {
      if (argv.includes('--once')) throw error;
      console.error(paint('red', `PLANNER FAILED · ${error.message}`, process.stderr));
    }
    if (result?.deferred) {
      deferred.add(result.id);
      if (argv.includes('--once')) { if (result.exit !== 0) process.exitCode = 1; break; }
      continue;
    }
    if (result?.uncertain) {
      console.error(paint('red', `HELD · publication for ${result.id} started and did not confirm; ` +
        (result.reason ? `${result.reason}; ` : '') + `inspect the ticket in NTK ` +
        `before any other run of it; see ${result.log}`, process.stderr));
      if (argv.includes('--once')) { process.exitCode = 1; break; }
      continue;
    }
    if (result?.environment) {
      if (argv.includes('--once')) throw new Error(`planning failed before it touched ${result.id}; see ${result.log}`);
      deferred.add(result.id);
      continue;
    }
    if (argv.includes('--once')) break;
    deferred.clear();
    console.log(`\n${paint('blue', `Pause ${config.interval}s`)} · Ctrl+C to stop\n`);
    await new Promise(resolve => setTimeout(resolve, config.interval * 1000));
  } while (true);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(paint('red', `PLANNER FAILED · ${error.message}`, process.stderr)); process.exit(1); });
}
