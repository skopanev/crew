// Independent acceptance tests for requirement:hp7fj3b8 (black box from the criteria and their Sources).
// ac:b3w8lkpw  A failed Task is held by its own code
// ac:y8ibbdob  Flow relations do not change the contract digest
// ac:cj3sulbw  A revision read stays historical
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {callJoppa} from '../joppa-api.mjs';
import {contractDigest, finishTask, api} from '../joppa.mjs';
import {packageFixture} from '../test-support/launcher-joppa.fixture.mjs';

// ---------- A minimal Joppa MCP server that answers one canned detail per address ----------

async function detailServer(t, details) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-accept-'));
  t.after(() => fs.rmSync(temp, {recursive: true, force: true}));
  const tokenFile = path.join(temp, 'token');
  fs.writeFileSync(tokenFile, 'acceptance-token');
  const calls = [];
  const server = http.createServer(async (req, res) => {
    if (req.method === 'DELETE') { res.writeHead(204).end(); return; }
    let body = '';
    for await (const part of req) body += part;
    const message = JSON.parse(body);
    res.setHeader('Content-Type', 'application/json');
    if (message.method === 'notifications/initialized') { res.writeHead(204).end(); return; }
    if (message.method === 'initialize') {
      res.end(JSON.stringify({jsonrpc: '2.0', id: message.id, result: {protocolVersion: '2025-03-26'}}));
      return;
    }
    const {name, arguments: args} = message.params;
    calls.push({name, args});
    const value = structuredClone(details(args));
    res.end(JSON.stringify({jsonrpc: '2.0', id: message.id, result: {structuredContent: value}}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {calls, read: args => callJoppa(url, tokenFile, 'joppa_objects', {workspace: 'acceptance', ...args})};
}

// The live detail shape of a Task at revision 4 with a contract body and a parent criterion.
const taskDetail = relations => ({
  address: 'task:t1', kind: 'task', revision: 4, current_revision: 4, historical: false,
  parent: 'ac:a1', present: true,
  data: {title: '[01] Add export', owner: 'owner', body: 'Goal: export 3 rows', projects: ['app']},
  relations, status: {tone: 'blue'}, comments: {items: [], total: 0, next_cursor: null},
});

async function digestOf(t, relations) {
  const s = await detailServer(t, () => taskDetail(relations));
  return contractDigest(await s.read({address: 'task:t1'}));
}

// ---------- ac:y8ibbdob  Flow relations do not change the contract digest ----------

test('ac:y8ibbdob nominal: adding one flow edge next_step -> task:t2 leaves the contract digest unchanged', async t => {
  const base = {depends_on: {edges: [{to: 'task:t0'}]}, related: {edges: [{to: 'note:n1', revision: 2}]}};
  const before = await digestOf(t, base);
  const after = await digestOf(t, {...base, next_step: {edges: [{to: 'task:t2'}]}});
  assert.match(before, /^[0-9a-f]{64}$/);
  assert.equal(after, before);
});

test('ac:y8ibbdob nominal: removing one of two flow edges under review_flow leaves the contract digest unchanged', async t => {
  const base = {depends_on: {edges: [{to: 'task:t0'}]}};
  const before = await digestOf(t, {...base, review_flow: {edges: [{to: 'task:t2'}, {to: 'task:t3'}]}});
  const after = await digestOf(t, {...base, review_flow: {edges: [{to: 'task:t2'}]}});
  assert.equal(after, before);
});

test('ac:y8ibbdob boundary: two arbitrary flow keys added at once (deploys_to, qa_lane) leave the digest equal to a Task with no flow keys', async t => {
  const before = await digestOf(t, {});
  const after = await digestOf(t, {deploys_to: {edges: [{to: 'env:stage'}]}, qa_lane: {edges: [{to: 'task:t9', revision: 1}]}});
  assert.equal(after, before);
});

test('ac:y8ibbdob off_nominal: adding a depends_on edge to task:t2 changes the contract digest', async t => {
  const before = await digestOf(t, {depends_on: {edges: [{to: 'task:t0'}]}});
  const after = await digestOf(t, {depends_on: {edges: [{to: 'task:t0'}, {to: 'task:t2'}]}});
  assert.notEqual(after, before);
});

test('ac:y8ibbdob off_nominal: adding a related edge to note:n2 changes the contract digest', async t => {
  const before = await digestOf(t, {related: {edges: [{to: 'note:n1'}]}});
  const after = await digestOf(t, {related: {edges: [{to: 'note:n1'}, {to: 'note:n2'}]}});
  assert.notEqual(after, before);
});

// ---------- ac:cj3sulbw  A revision read stays historical ----------

test('ac:cj3sulbw nominal: reading revision 1 of a node at current revision 5 reports historical with current revision 5', async t => {
  const s = await detailServer(t, () => ({address: 'task:t1', kind: 'task', revision: 1, current_revision: 5,
    historical: true, parent: 'ac:a1', present: true, data: {title: 'Old title', owner: 'owner', body: 'Goal: v1'},
    relations: {}, comments: {items: [], total: 0, next_cursor: null}}));
  const result = await s.read({address: 'task:t1', revision: 1});
  assert.equal(s.calls[0].args.revision, 1);
  assert.equal(result.historical, true);
  assert.equal(result.current_revision, 5);
  assert.equal(result.document.revision, 1);
});

test('ac:cj3sulbw boundary: a revision 1 reply that names current revision 5 but omits the historical flag still reads as historical with current revision 5', async t => {
  const s = await detailServer(t, () => ({address: 'task:t1', kind: 'task', revision: 1, current_revision: 5,
    parent: 'ac:a1', present: true, data: {title: 'Old title', owner: 'owner', body: 'Goal: v1'}, relations: {}}));
  const result = await s.read({address: 'task:t1', revision: 1});
  assert.equal(result.historical, true);
  assert.equal(result.current_revision, 5);
});

test('ac:cj3sulbw off_nominal: a current read of the node at revision 5 reports not historical with current revision 5', async t => {
  const s = await detailServer(t, () => ({address: 'task:t1', kind: 'task', revision: 5, current_revision: 5,
    historical: false, parent: 'ac:a1', present: true, data: {title: 'New title', owner: 'owner', body: 'Goal: v5'},
    relations: {}, comments: {items: [], total: 0, next_cursor: null}}));
  const result = await s.read({address: 'task:t1'});
  assert.equal(result.historical, false);
  assert.equal(result.current_revision, 5);
});

// ---------- ac:b3w8lkpw  A failed Task is held by its own code ----------

const ASSIGNEE = 'crew-lane:host:11111111-2222-4333-8444-555555555555';

// One Task (task:t1, read revision 3) claimed by this lane. Artifacts live in <root>/run/artifacts.
async function failedLane(t, {origin, journal, failure, output = ''}) {
  const f = await packageFixture(t);
  const task = f.objects.get('task:t1');
  task.document.data.assignee = ASSIGNEE;
  const detail = await api(f.run.config, f.run.joppaWorker, 'joppa_objects', {workspace: 'fixture', address: 'task:t1'});
  const parent = await api(f.run.config, f.run.joppaWorker, 'joppa_objects', {workspace: 'fixture', address: 'ac:a1'});
  f.run.tasks = [{address: 'task:t1', revision: 3}];
  f.run.ticket = 'task:t1';
  f.run.claim = {assignee: ASSIGNEE, tasks: [{address: 'task:t1', digest: contractDigest(detail),
    parent: {address: 'ac:a1', digest: contractDigest(parent)}}]};
  const runDir = path.join(f.root, 'run'), artifacts = path.join(runDir, 'artifacts');
  fs.mkdirSync(artifacts, {recursive: true});
  if (origin) fs.writeFileSync(path.join(artifacts, 'origin.json'), JSON.stringify(origin));
  if (journal) fs.writeFileSync(path.join(runDir, 'journal.jsonl'), journal.map(row => JSON.stringify(row)).join('\n') + '\n');
  if (failure !== undefined) fs.writeFileSync(path.join(artifacts, 'failure.txt'), failure);
  fs.writeFileSync(path.join(f.root, 'output.log'), output);
  f.persist();
  return {...f, task, artifacts};
}

const writes = f => f.calls.filter(call => ['joppa_batch', 'joppa_command'].includes(call.name));
const holdSaves = f => writes(f).flatMap(call => (call.args.operations || [{command: call.args.command}]))
  .map(({command}) => command).filter(command => command.op === 'save_object' && command.data && Object.hasOwn(command.data, 'hold') && command.data.hold);

test('ac:b3w8lkpw nominal: a lane that fails review with code GATE_FAIL and a failure report saves task:t1 at read revision 3 with assignee null and hold GATE_FAIL plus one note in one batch', async t => {
  const report = 'Gate failed: 2 of 7 checks red.';
  const f = await failedLane(t, {origin: {node: 'review', signal: 'GATE_FAIL', message: report},
    journal: [{node: 'implement_code', signal: '__default__'}, {node: 'review', signal: 'GATE_FAIL'}], failure: report});
  const result = {status: 'failed', code: 1};
  await finishTask(f.run, f.stateFile, result, f.artifacts);
  const batches = writes(f);
  assert.equal(batches.length, 1, 'exactly one write call');
  assert.equal(batches[0].name, 'joppa_batch');
  const commands = batches[0].args.operations.map(({command}) => command);
  assert.equal(commands.length, 2);
  const [save, note] = commands;
  assert.equal(save.op, 'save_object');
  assert.equal(`${save.kind}:${save.id}`, 'task:t1');
  assert.equal(save.revision, 3);
  assert.deepEqual(save.data, {assignee: null, hold: 'GATE_FAIL'});
  assert.equal(note.op, 'note');
  assert.equal(note.target, 'task:t1');
  assert.ok(note.text.includes(report), 'the note carries the failure report');
  assert.equal(f.task.document.data.hold, 'GATE_FAIL');
  assert.equal(f.task.document.data.assignee, undefined);
  assert.equal(Object.keys(f.task.annotations.comments).length, 1);
  assert.equal(result.blocked, true);
});

test('ac:b3w8lkpw boundary: a different failure code TESTS_FAILED becomes the hold code itself', async t => {
  const report = 'TESTS_FAILED: 1 of 12 tests failed';
  const f = await failedLane(t, {origin: {node: 'run_tests', signal: 'TESTS_FAILED', message: report},
    journal: [{node: 'run_tests', signal: 'TESTS_FAILED'}], failure: report});
  await finishTask(f.run, f.stateFile, {status: 'failed', code: 1}, f.artifacts);
  const saves = holdSaves(f);
  assert.equal(saves.length, 1);
  assert.equal(saves[0].data.hold, 'TESTS_FAILED');
  assert.equal(saves[0].data.assignee, null);
  assert.equal(f.task.document.data.hold, 'TESTS_FAILED');
});

test('ac:b3w8lkpw off_nominal: an implement timeout does not hold task:t1 and writes no hold code', async t => {
  const f = await failedLane(t, {origin: {node: 'implement_code', signal: '__timeout__'},
    journal: [{node: 'prepare', signal: '__default__'},
      {node: 'implement_code', signal: '__timeout__', timed_out: true, next: 'notify_failure'}],
    failure: 'implement_code timed out after 3600 s'});
  const result = {status: 'failed', code: 1};
  // Timeout recovery needs a retained session and checkout that this black-box fixture does not have; it may refuse.
  await finishTask(f.run, f.stateFile, result, f.artifacts).catch(() => {});
  assert.equal(holdSaves(f).length, 0, 'no save sends a hold code');
  assert.equal(f.task.document.data.hold, undefined);
  assert.equal(result.held, true, 'the run went to timeout recovery');
  assert.equal(result.blocked, false);
});

test('ac:b3w8lkpw off_nominal: a lane failure that leaves no failure report does not hold task:t1', async t => {
  const f = await failedLane(t, {origin: {node: 'review', signal: 'GATE_FAIL'},
    journal: [{node: 'review', signal: 'GATE_FAIL'}]});
  const result = {status: 'failed', code: 1};
  await finishTask(f.run, f.stateFile, result, f.artifacts);
  assert.equal(holdSaves(f).length, 0, 'no save sends a hold code');
  assert.equal(f.task.document.data.hold, undefined);
  assert.notEqual(result.blocked, true);
});

test('ac:b3w8lkpw off_nominal: a preparation failure with a failure report releases task:t1 without a hold', async t => {
  const f = await failedLane(t, {origin: {node: 'prepare', signal: '__failed__'},
    journal: [{node: 'prepare', signal: '__failed__'}], failure: 'prepare failed: dependency install exited 1'});
  // A worktree root names the unused checkout; the checkout itself is absent.
  const worktreeRoot = path.join(f.root, 'worktrees');
  fs.mkdirSync(worktreeRoot);
  f.run.config.worktreeRoot = worktreeRoot;
  fs.writeFileSync(path.join(f.root, 'output.log'),
    `run.sh: removed unused worktree: ${path.join(worktreeRoot, f.run.executionId)}\n`);
  f.persist();
  const result = {status: 'failed', code: 1};
  await finishTask(f.run, f.stateFile, result, f.artifacts);
  assert.equal(holdSaves(f).length, 0, 'no save sends a hold code');
  assert.equal(f.task.document.data.hold, undefined);
  assert.equal(f.task.document.data.assignee, undefined, 'the Task is released');
  assert.equal(result.released, true);
});
