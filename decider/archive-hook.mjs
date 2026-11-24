#!/usr/bin/env bun
// Execute a reviewed archive through the existing API and publication receipt format.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {setTimeout as sleep} from 'node:timers/promises';
import {constants} from 'node:os';

const need = (ok, message) => { if (!ok) throw new Error(message); };
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => {
  const temporary = file + '.' + randomUUID() + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
  fs.renameSync(temporary, file);
};

export async function stopOwned(targets, lane, runtime, seconds) {
  const runs = runtime.runDirectories(runtime.scopeDirectory(lane.stateDir, lane.id)).map(dir => {
    const file = path.join(dir, 'launch.json');
    return {file, run: runtime.readRun(file)};
  });
  const chosen = new Map();
  for (const target of targets) {
    const matches = runs.filter(({run}) => run.workspace === lane.workspace &&
      run.config?.joppa?.url === lane.joppa.url && run.claim?.assignee === target.assignee &&
      runtime.runTasks(run).some(task => task.address === target.address));
    need(matches.length === 1, 'A held child needs exactly one matching lane: ' + target.address);
    chosen.set(matches[0].file, matches[0].run);
  }
  for (const [file, run] of chosen) {
    const pid = run.worker?.pid;
    need(Number.isInteger(pid) && pid > 1 && runtime.alive(pid), 'The matching lane worker is unavailable');
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'args='], {encoding: 'utf8'});
    const state = path.join(run.runFolder || path.dirname(file), 'launch.json');
    need(command.includes('lane-launcher/worker.mjs') &&
      [file, fs.realpathSync(file), state].some(value => command.includes(value)), 'Lane PID belongs to another process');
    process.kill(pid, 'SIGTERM');
  }
  const deadline = Date.now() + seconds * 1000;
  for (const [file, run] of chosen) {
    while (runtime.alive(run.worker.pid) && Date.now() < deadline) await sleep(100);
    need(!runtime.alive(run.worker.pid), 'The lane did not stop within the configured archive timeout');
    const ended = runtime.readRun(file);
    const result = ended.result;
    need(['failed', 'exited'].includes(result?.status) &&
      (Number.isInteger(result.code) || result.code === null && Object.hasOwn(constants.signals, result.signal)),
    'The stopped lane did not record its outcome');
  }
}

export async function sendBatch(file, config, operations, send) {
  need(operations.length > 0 && operations.length <= 100, 'Archive batch exceeds the native limit');
  const record = {tool: 'joppa_batch', server: config.url, status: 'pending', retain_claim: true,
    arguments: {workspace: config.workspace, operations, request_id: 'crew-planning-' + randomUUID()}};
  fs.writeFileSync(file, JSON.stringify(record) + '\n', {flag: 'wx', mode: 0o600});
  try {
    const result = await send('joppa_batch', record.arguments);
    need(Array.isArray(result.results) && result.results.length === operations.length, 'Archive batch reply is incomplete');
    write(file, {...record, status: 'confirmed', result});
    return result;
  } catch (error) {
    write(file, {...record, status: error.rejected ? 'rejected' : 'uncertain', error: error.message});
    throw error;
  }
}

async function children(input, get, includeCaptured = true, getMany) {
  const found = new Map(), queue = [input.selected.address], queried = new Set();
  while (queue.length) {
    const parent = queue.shift();
    need(!queried.has(parent), 'The archive subtree contains a cycle');
    queried.add(parent);
    let cursor;
    const cursors = new Set();
    do {
      const page = await get('joppa_objects', {parent, depth: 1, fields: ['revision', 'parent'], limit: 25,
        status: ['red', 'purple', 'yellow', 'orange', 'blue', 'green'],
        ...(cursor ? {cursor} : {})});
      need(Array.isArray(page.items), 'The archive child inventory is unavailable');
      const details = getMany ? await getMany(page.items.map(node => node.address)) : new Map();
      for (const row of page.items) {
        const node = details.get(row.address) || await get('joppa_objects', {address: row.address});
        need(node.document?.parent === parent && node.historical === false, 'The archive child changed its parent');
        need(['test', 'task'].includes(input.schema.types[node.kind]?.role), 'The subtree contains an unsupported node kind');
        need(!found.has(node.address), 'The archive child occurs more than once');
        found.set(node.address, node);
        queue.push(node.address);
      }
      cursor = page.next_cursor;
      need(!cursor || !cursors.has(cursor), 'Archive pagination did not advance');
      cursors.add(cursor);
    } while (cursor);
  }
  for (const captured of includeCaptured ? input.children || [] : []) {
    if (!found.has(captured.address)) found.set(captured.address, await get('joppa_objects', {address: captured.address}));
  }
  return [...found.values()];
}

async function activeOwnTargets(input, lane, runtime, get) {
  const targets = [];
  for (const folder of runtime.runDirectories(runtime.scopeDirectory(lane.stateDir, lane.id))) {
    const run = runtime.readRun(path.join(folder, 'launch.json'));
    if (run.workspace !== lane.workspace || run.config?.joppa?.url !== lane.joppa.url ||
      !runtime.runHoldsTasks(run) || !runtime.alive(run.worker?.pid)) continue;
    for (const task of runtime.runTasks(run)) {
      let node = await get('joppa_objects', {address: task.address});
      const seen = new Set();
      while (node.document?.parent && node.document.parent !== input.selected.address) {
        need(!seen.has(node.address), 'The active lane parent chain contains a cycle');
        seen.add(node.address);
        node = await get('joppa_objects', {address: node.document.parent});
      }
      if (node.document?.parent === input.selected.address) targets.push({address: task.address, assignee: run.claim?.assignee});
    }
  }
  return targets;
}

export async function execute(dir, env = process.env) {
  const config = read(env.PLANNING_JOPPA_CONFIG_SNAPSHOT || env.PLANNING_JOPPA_CONFIG);
  const input = read(path.join(dir, 'input.json')), claim = read(path.join(dir, 'claim.json'));
  need(config.workspace === input.workspace && claim.arguments?.workspace === config.workspace &&
    claim.status === 'confirmed', 'The archive needs its confirmed workspace claim');
  need(claim.server === undefined || claim.server === config.url, 'The claim belongs to another tracker');
  const runtimeRoot = path.dirname(path.dirname(env.CREW_FLOW_STAGES));
  const module = name => import(pathToFileURL(path.join(runtimeRoot, name)).href);
  const api = await module('lane-launcher/joppa-api.mjs');
  const runtime = {...await module('lane-launcher/runtime.mjs'), ...await module('lane-launcher/scope.mjs'),
    ...await module('lane-launcher/joppa.mjs'), ...await module('lane-launcher/joppa-common.mjs')};
  const options = {mcpCommand: config.mcp_command};
  const get = (tool, args = {}) => api.readJoppa(config.url, config.token_file, tool,
    {workspace: config.workspace, ...args}, options);
  const many = addresses => addresses.length ? api.readDetails(config.url, config.token_file,
    {workspace: config.workspace}, addresses, options) : new Map();
  const send = (tool, args) => api.callJoppa(config.url, config.token_file, tool, args, options);
  const archive = await import(pathToFileURL(path.join(env.MEDULLA_WORKFLOW_DIR, 'archive.mjs')).href);
  const decision = read(path.join(dir, 'draft.json')), packet = read(path.join(dir, 'decider-assignment.json'));
  const claimed = (claim.arguments.operations || [{command: claim.arguments.command}])
    .map(row => row.command).find(command => command.kind + ':' + command.id === input.selected.address);
  need(typeof claimed?.data?.assignee === 'string', 'The selected AC has no recorded claim holder');
  const guard = async () => {
    const current = await get('joppa_objects', {address: input.selected.address});
    need(current.historical === false && current.document?.present && current.document.data.assignee === claimed.data.assignee &&
      current.current_revision === input.claim_revision, 'The archive AC claim changed');
    need(!(current.document.data.tags || []).some(tag => (config.exclude_tags || []).includes(tag)), 'The AC has a question tag');
    need(isDeepStrictEqual((await get('joppa_tree')).schema, input.schema), 'The archive schema changed');
    execFileSync(env.PLANNING_PYTHON || 'python3', [path.join(env.MEDULLA_WORKFLOW_DIR, 'context.py'), 'verify'],
      {env, stdio: ['ignore', 'pipe', 'pipe']});
  };
  const publication = path.join(dir, 'publication.json');
  need(!fs.existsSync(publication), 'Archive publication already attempted; inspect its receipts before retrying');
  await guard();
  const lane = read(config.vars.ARCHIVE_LANE_CONFIG);
  need(lane.workspace === config.workspace && lane.joppa?.url === config.url, 'The archive lane inventory belongs to another workspace');
  const seconds = Number(config.vars.ARCHIVE_STOP_SECONDS);
  need(Number.isFinite(seconds) && seconds > 0, 'Configure ARCHIVE_STOP_SECONDS');
  let plan, fresh;
  fresh = await children(input, get, true, many);
  archive.plan(input, decision, packet, fresh);
  await stopOwned(await activeOwnTargets(input, lane, runtime, get), lane, runtime, seconds);
  do {
    fresh = await children(input, get, true, many);
    plan = archive.plan(input, decision, packet, fresh);
    if (plan.stop.length) await stopOwned(plan.stop, lane, runtime, seconds);
  } while (plan.stop.length);
  await guard();
  write(path.join(dir, 'archive-children.json'), fresh);
  plan = archive.frozen(dir, input, decision, packet, fresh);
  const permitted = new Set([input.selected.address, ...fresh.map(node => node.address)]);
  const kinds = new Map([input.selected, ...fresh].map(node => [node.address, node.kind]));
  const marker = {tool: 'archive', server: config.url, status: 'pending', retain_claim: true};
  fs.writeFileSync(publication, JSON.stringify(marker) + '\n', {flag: 'wx', mode: 0o600});
  let attempted = false, confirmed = 0;
  try {
    for (;;) {
      const batch = archive.next(dir);
      if (batch.done) break;
      await guard();
      if (batch.operations.some(({command}) => command.op === 'archive_object' && command.target === input.selected.address)) {
        need(!(await children(input, get, false, many)).some(node => node.document?.present), 'Live children remain before the AC archive');
      }
      for (const {command} of batch.operations) {
        const address = command.target || command.kind + ':' + command.id;
        need(permitted.has(address) && config.publication.allowed_operations.includes(command.op), 'Archive operation is outside its own subtree or policy');
        need(config.publication.update_kinds.includes(kinds.get(address)), 'The archive kind is outside its configured policy');
        if (command.parent) {
          need(config.publication.structure?.move?.[command.kind]?.includes('fresh_parent'), 'Configure the Test parent move');
          const target = await get('joppa_objects', {address: command.parent});
          const captured = packet.sibling_acs.find(node => node.address === target.address);
          need(captured && target.historical === false && target.document?.present && !target.document.data.assignee &&
            !(target.document.data.tags || []).some(tag => (config.exclude_tags || []).includes(tag)) &&
            runtime.contractDigest(captured) === runtime.contractDigest(target), 'The live duplicate AC changed');
        }
      }
      attempted = true;
      await sendBatch(path.join(dir, batch.receipt), config, batch.operations, send);
      confirmed++;
    }
    write(publication, {...marker, status: 'confirmed', result: {archive_batches: plan.batches.length}});
    write(path.join(dir, 'result.json'), {status: 'published', reason_code: decision.outcome, reason: plan.reason,
      claim_released: true, acceptance_verified: false});
    console.log('<signal:READY>The reviewed AC archive is confirmed.</signal:READY>');
  } catch (error) {
    const uncertain = confirmed > 0 || attempted && !error.rejected;
    write(publication, {...marker, status: uncertain ? 'uncertain' : 'rejected', error: error.message});
    if (uncertain) write(path.join(dir, 'result.json'), {status: 'blocked', reason: error.message,
      claim_released: false, needs_recovery: true, acceptance_verified: false});
    throw error;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const dir = process.argv[2];
  execute(dir).catch(error => {
    if (dir && fs.existsSync(dir)) fs.writeFileSync(path.join(dir, 'failure.txt'), error.message + '\n');
    console.error('Decider archive: ' + error.message);
    process.exitCode = 1;
  });
}
