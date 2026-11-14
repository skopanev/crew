// Final landing: bound names need the full report and their exact criterion node, then a result at the landed SHA.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {publishLandedResults} from '../test-results-publish.mjs';

const sha = 'a'.repeat(40), tree = 'b'.repeat(40), head = 'c'.repeat(40);
const ONE = 'tests/a.test.ts > one', TWO = 'tests/a.test.ts > two';
const testReport = {path: 'junit/report.xml', format: 'junit', identity: '{file} > {name}'};
const rules = {statuses: {pass: 'pass', fail: 'fail', skip: 'skip'}, fields: [],
  name: {separator: ' > ', min_parts: 2}, max_results: 10};
const digest = text => createHash('sha256').update(text).digest('hex');

function fixture(t, {results = [{test: ONE, outcome: 'pass'}, {test: TWO, outcome: 'pass'}]} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-binding-results-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const artifacts = path.join(root, 'artifacts'), folder = path.join(artifacts, 'gates', 'f1');
  fs.mkdirSync(path.join(folder, 'test-report', 'junit'), {recursive: true});
  fs.writeFileSync(path.join(folder, 'test-report', 'junit', 'report.xml'), '<testsuites/>');
  const receipt = JSON.stringify({passed: true, tree, commands: ['bun test'],
    test_report: {...testReport, sha256: digest('<testsuites/>'), results}});
  fs.writeFileSync(path.join(folder, 'receipt.json'), receipt);
  fs.writeFileSync(path.join(artifacts, 'gates', 'current.json'),
    JSON.stringify({receipt: '/workspace/x/artifacts/gates/f1/receipt.json', sha256: digest(receipt)}));
  fs.writeFileSync(path.join(artifacts, 'landing.txt'), `Landed SHA: ${sha}\nTarget: develop\n`);
  const run = {workspace: 'ws', requirement: 'req:r', config: {delivery: 'target', repositories: [{id: 'app'}],
    taskFields: {repository: 'body:Repository'}},
    repository: {id: 'app', targetBranch: 'develop', gateCommands: ['bun test'], testReport}};
  const task = {address: 'task:t1', kind: 'task', historical: false, current_revision: 5,
    document: {present: false, parent: 'ac:a1', data: {body: 'Goal: x\nRepository: app', commit: sha,
      test_bindings: [{ac: 'ac:a1', check: 'c', test: ONE}, {ac: 'ac:a2', check: 'd', test: ONE}]}}};
  // check:n1 is under ac:a1. A node with the same title under ac:other does not bind ac:a2.
  const nodes = {'check:n1': {parent: 'ac:a1', title: ONE}, 'check:n2': {parent: 'ac:a2', title: ONE},
    'check:x': {parent: 'ac:other', title: TWO}};
  const recorded = new Set(), calls = [], lines = [];
  let reply = {unbound: []};
  const call = async (tool, args) => {
    calls.push({tool, args});
    if (tool === 'joppa_tree') return {schema: {types: {task: {role: 'task'}, check: {role: 'test'}}, test_results: rules}};
    if (tool === 'joppa_record_results') {
      for (const item of args.results) recorded.add(item.test);
      return reply;
    }
    if (args.address === 'task:t1') return structuredClone(task);
    if (args.address) {
      const node = nodes[args.address];
      return {address: args.address, document: {parent: node.parent, data: {title: node.title}},
        ...(recorded.has(node.title) && !node.lost ? {result: {status: 'pass', commit: sha, address: node.title}} : {})};
    }
    if (args.kind?.includes?.('task') || args.kind === 'task') {
      return {items: [{address: 'task:t1', present: false, revision: 5, 'data.commit': sha,
        'data.test_bindings': task.document.data.test_bindings}]};
    }
    return {items: Object.entries(nodes).filter(([, node]) => node.parent === args.parent)
      .map(([address, node]) => ({address, title: node.title, parent: node.parent}))};
  };
  const git = async args => args[0] === 'ls-remote' ? `${head}\trefs/heads/develop` : args[0] === 'rev-parse' ? tree : '';
  const result = {completed: true};
  const publish = () => publishLandedResults({run, stateFile: path.join(root, 'launch.json'), result, artifacts,
    announce: line => lines.push(line)}, {git, call, save: () => {}});
  return {run, nodes, calls, lines, result, publish, task, setReply: value => { reply = value; }};
}
const sends = f => f.calls.filter(item => item.tool === 'joppa_record_results');

test('bound names with their exact criterion nodes record results and confirm them at the landed SHA', async t => {
  const f = fixture(t);
  await f.publish();
  assert.equal(f.result.testResults.status, 'recorded');
  assert.equal(f.run.testResults.bound, 2);
  assert.deepEqual(f.run.testResults.gaps, []);
  assert.deepEqual(f.run.testResults.requests[0].reply, {unbound: []});
});

test('a missing node or a name outside the full report records nothing', async t => {
  const missing = fixture(t);
  delete missing.nodes['check:n2'];
  await missing.publish();
  assert.match(missing.result.testResults.diagnostic, /^BINDING_NODE_MISSING: ac:a2 has no test node/);
  assert.equal(sends(missing).length, 0);
  const absent = fixture(t, {results: [{test: TWO, outcome: 'pass'}]});
  await absent.publish();
  assert.match(absent.result.testResults.diagnostic, /^BINDING_NOT_IN_REPORT/);
  assert.equal(sends(absent).length, 0);
});

test('an unbound reply or a missing result after the send is an evidence gap', async t => {
  const f = fixture(t);
  f.setReply({unbound: [ONE]});
  f.nodes['check:n2'].lost = true;
  await f.publish();
  assert.equal(f.result.testResults.status, 'recorded');
  assert.deepEqual(f.result.testResults.gaps, [
    'TEST_RESULTS_UNBOUND: Joppa did not bind tests/a.test.ts > one for ac:a1',
    'TEST_RESULTS_UNBOUND: Joppa did not bind tests/a.test.ts > one for ac:a2',
    `TEST_RESULTS_MISSING: check:n2 (tests/a.test.ts > one) has no result at ${sha}`]);
  assert(f.lines.some(line => line.startsWith('[lane] TEST_RESULTS_MISSING')));
});

test('a Requirement without bound Tasks keeps the previous publication', async t => {
  const f = fixture(t);
  delete f.task.document.data.test_bindings;
  f.run.requirement = undefined;
  await f.publish();
  assert.equal(f.result.testResults.status, 'recorded');
  assert.equal(f.run.testResults.bound, undefined);
});
