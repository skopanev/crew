import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {publishLandedResults, testResultsInspection} from '../test-results-publish.mjs';
import {validateTestReport, buildRequests, nameProblem} from '../test-results.mjs';

const sha = 'a'.repeat(40), tree = 'b'.repeat(40), head = 'c'.repeat(40);
const testReport = {path: 'junit/report.xml', format: 'junit', identity: '{file} > {name}'};
const rules = {
  statuses: {pass: 'pass', fail: 'fail', skip: 'skip', todo: 'todo'},
  fields: [{name: 'message', type: 'text', max_length: 5}, {name: 'duration_ms', type: 'number'}],
  name: {separator: ' > ', min_parts: 2, file_extension: true, max_length: 400},
  max_results: 2, failure_field: 'message',
};
const results = [
  {test: 'tests/a.test.ts > adds', outcome: 'pass', time: 0.25},
  {test: 'tests/a.test.ts > breaks', outcome: 'fail', message: 'expected 2\ntrace', time: 1},
  {test: 'tests/a.test.ts > later', outcome: 'skip'},
];
const digest = text => createHash('sha256').update(text).digest('hex');

function fixture({report = {}, delivery = 'target', final, landingTarget = 'develop', treeAt = tree} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-test-results-'));
  const artifacts = path.join(root, 'run', 'artifacts'), folder = path.join(artifacts, 'gates', 'f1');
  fs.mkdirSync(path.join(folder, 'test-report', 'junit'), {recursive: true});
  const raw = '<testsuites/>';
  fs.writeFileSync(path.join(folder, 'test-report', 'junit', 'report.xml'), raw);
  const receipt = JSON.stringify({passed: true, tree, commands: ['bun run test'],
    test_report: {...testReport, sha256: digest(raw), results, ...report}});
  fs.writeFileSync(path.join(folder, 'receipt.json'), receipt);
  fs.writeFileSync(path.join(artifacts, 'gates', 'current.json'),
    JSON.stringify({receipt: '/workspace/runs/x/artifacts/gates/f1/receipt.json', sha256: digest(receipt)}));
  fs.writeFileSync(path.join(artifacts, 'landing.txt'), `Ticket: work:t\nLanded SHA: ${sha}\nTarget: ${landingTarget}\n`);
  const stateFile = path.join(root, 'launch.json');
  const run = {workspace: 'ws', config: {delivery}, requirementDelivery: final === undefined ? undefined : {final},
    repository: {id: 'app', targetBranch: 'develop', gateCommands: ['bun run test'], testReport}};
  const calls = [], lines = [];
  const git = async args => args[0] === 'ls-remote' ? `${head}\trefs/heads/develop` : args[0] === 'rev-parse' ? treeAt : '';
  let record = async () => ({recorded: true});
  const call = async (tool, args) => {
    calls.push({tool, args});
    if (tool === 'joppa_tree') return {schema: {test_results: rules}};
    return record(args);
  };
  const publish = (result = {completed: true}) => publishLandedResults(
    {run, stateFile, result, artifacts, announce: line => lines.push(line)}, {git, call});
  return {run, stateFile, calls, lines, publish, setRecord: value => { record = value; },
    saved: () => JSON.parse(fs.readFileSync(stateFile, 'utf8'))};
}
const records = calls => calls.filter(item => item.tool === 'joppa_record_results');

test('happy path maps statuses and fields in max_results batches', async () => {
  const f = fixture(), result = {completed: true};
  await f.publish(result);
  const sent = records(f.calls).map(item => item.args);
  assert.deepEqual(sent, [
    {workspace: 'ws', commit: sha, results: [
      {test: 'tests/a.test.ts > adds', status: 'pass', duration_ms: 250},
      {test: 'tests/a.test.ts > breaks', status: 'fail', message: 'expec', duration_ms: 1000}]},
    {workspace: 'ws', commit: sha, results: [{test: 'tests/a.test.ts > later', status: 'skip'}]}]);
  assert.equal(f.saved().testResults.status, 'recorded');
  assert.deepEqual(f.saved().testResults.requests.map(entry => entry.state), ['recorded', 'recorded']);
  assert.deepEqual(result, {completed: true, testResults: {status: 'recorded'}});
  assert.ok(!f.calls.some(item => JSON.stringify(item).includes('set_ac_tests')));
});

for (const [name, report, fragment] of [
  ['missing', {error: 'report is missing: junit/report.xml', results: undefined}, 'report is missing'],
  ['empty', {error: 'report is empty', results: undefined}, 'report is empty'],
  ['unparsable', {error: 'report is not valid XML', results: undefined}, 'not valid XML'],
  ['stale', {error: 'report is stale: it is older than this gate run', results: undefined}, 'stale'],
  ['changed after the gate', {sha256: 'd'.repeat(64)}, 'changed after the gate run'],
  ['ambiguous', {results: [results[0], results[0]]}, 'Ambiguous report'],
  ['badly named', {results: [{test: 'adds', outcome: 'pass'}]}, 'fails the workspace name rule'],
]) {
  test(`${name} report records nothing with a diagnostic`, async () => {
    const f = fixture({report});
    await f.publish();
    assert.equal(records(f.calls).length, 0);
    assert.equal(f.saved().testResults.status, 'not_recorded');
    assert.match(f.saved().testResults.diagnostic, new RegExp(fragment));
    assert.match(f.lines.join('\n'), /TEST_RESULTS_NOT_RECORDED/);
  });
}

test('a tree mismatch records nothing', async () => {
  const f = fixture({treeAt: 'e'.repeat(40)});
  await f.publish();
  assert.equal(records(f.calls).length, 0);
  assert.match(f.saved().testResults.diagnostic, /TEST_RESULTS_TREE_MISMATCH/);
});

test('intermediate Requirement and branch deliveries publish nothing', async () => {
  for (const options of [{delivery: 'requirement', final: false, landingTarget: 'req/x'},
    {delivery: 'branch', landingTarget: 'ticket-x'}, {delivery: 'target', landingTarget: 'other'}]) {
    const f = fixture(options);
    await f.publish();
    assert.equal(f.calls.length, 0);
    assert.equal(f.saved().testResults.status, 'skipped');
  }
  const final = fixture({delivery: 'requirement', final: true});
  await final.publish();
  assert.equal(records(final.calls).length, 2);
});

test('an incomplete lane or an unconfigured repository does nothing', async () => {
  const f = fixture();
  await f.publish({completed: false});
  assert.equal(f.calls.length, 0);
  delete f.run.testResults;
  delete f.run.repository.testReport;
  await f.publish();
  assert.equal(f.calls.length, 0);
  assert.equal(f.run.testResults, undefined);
});

test('an uncertain call is persisted, reported and never resent', async () => {
  const f = fixture();
  f.setRecord(async () => { throw new Error('Joppa MCP transport failed'); });
  const result = {completed: true, code: 0};
  await f.publish(result);
  const state = f.saved().testResults;
  assert.equal(state.status, 'uncertain');
  assert.deepEqual(state.requests.map(entry => entry.state), ['uncertain', 'pending']);
  assert.equal(state.requests[0].request.commit, sha);
  assert.equal(result.code, 0);
  assert.match(testResultsInspection(state ? {testResults: state} : {}), /TEST_RESULTS_UNCERTAIN/);
  f.setRecord(async () => ({recorded: true}));
  await f.publish(result);
  assert.equal(records(f.calls).length, 1);
});

test('a call in flight at a crash is reported for inspection', () => {
  assert.match(testResultsInspection({testResults: {commit: sha, requests: [{state: 'sending'}]}}), /unknown outcome/);
  assert.equal(testResultsInspection({testResults: {commit: sha, requests: [{state: 'recorded'}]}}), null);
});

test('a refused call stops the remaining requests', async () => {
  const f = fixture();
  f.setRecord(async () => { throw Object.assign(new Error('Joppa joppa_record_results: unknown status'), {rejected: true}); });
  await f.publish();
  assert.deepEqual(f.saved().testResults.requests.map(entry => entry.state), ['refused', 'pending']);
});

test('config and name rules are explicit', () => {
  assert.equal(validateTestReport(testReport), testReport);
  for (const value of [{...testReport, path: '../x.xml'}, {...testReport, path: '/x.xml'}, {...testReport, format: 'tap'},
    {...testReport, identity: 'no placeholder'}, {...testReport, identity: '{file} > {name'}, {...testReport, extra: 1}]) {
    assert.throws(() => validateTestReport(value));
  }
  assert.equal(nameProblem('tests/a.ts > x', rules.name), null);
  assert.match(nameProblem('tests/a > x', rules.name), /file extension/);
  assert.match(nameProblem('tests/a.ts', rules.name), /fewer than 2/);
  assert.match(nameProblem(`tests/a.ts > ${'x'.repeat(400)}`, rules.name), /longer/);
  assert.throws(() => buildRequests({workspace: 'ws', commit: sha, cases: [results[2]],
    rules: {...rules, statuses: {ok: 'pass', bad: 'fail'}}}), /no name for skip/);
  assert.throws(() => buildRequests({workspace: 'ws', commit: sha, cases: [results[0]],
    rules: {...rules, fields: [...rules.fields, {name: 'app', type: 'enum', required: true}]}}), /Required result field app/);
});
