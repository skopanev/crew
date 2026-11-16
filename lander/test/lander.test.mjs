import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {git, create, targetHead, pin, candidate, cleanup, environment, tooling} from '../git.mjs';
import {report} from '../report.mjs';
import {packageFixture} from '../../lane-launcher/test-support/launcher-joppa.fixture.mjs';

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
test('hourly report counts branches once and separates target evidence from publication confirmation', async t => {
  const f = await packageFixture(t), now = Date.now();
  const delivery = {state: 'pending', branch: 'ticket-one', head: 'a'.repeat(40), pushed_at: new Date(now - 600_000).toISOString()};
  for (const id of ['task:t1', 'task:t2']) Object.assign(f.objects.get(id).document.data, {repository: 'service', delivery});
  const root = path.join(f.root, 'lander'), artifacts = path.join(root, 'run', 'artifacts');
  fs.mkdirSync(artifacts, {recursive: true});
  const write = (file, data) => fs.writeFileSync(path.join(artifacts, file), JSON.stringify(data));
  write('input.json', {items: ['task:t1', 'task:t2'].map(id => f.objects.get(id))});
  write('lander.json', {landed_at: new Date(now - 60_000).toISOString(), accepted: [{address: 'task:t1'}, {address: 'task:t2'}]});
  write('result.json', {reason_code: 'LANDED', claim_released: true});
  const resultFile = path.join(artifacts, 'result.json');
  fs.utimesSync(resultFile, new Date(now - 60_000), new Date(now - 60_000));
  const value = await report({workspace: 'fixture', url: f.run.config.joppa.url, token_file: f.run.joppaWorker.tokenFile,
    selection: {kind: 'task'}, repositories: [{id: 'service'}], runs_folder: root}, now);
  assert.equal(value.pending_branches, 1);
  assert.equal(value.runs[0].batch_size, 1);
  assert.equal(value.outcomes.LANDED, 1);
  assert.deepEqual(value.push_to_landing, [{branch: 'ticket-one', seconds: 540}]);
  assert.equal(value.runs[0].publication_confirmed, true);
});

function fixture(t, gate = 'test ! -e bad.txt') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crew-lander-git-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const seed = path.join(root, 'seed'), origin = path.join(root, 'remote.git'), source = path.join(root, 'source');
  fs.mkdirSync(seed); fs.mkdirSync(source);
  git(root, 'init', '--bare', origin);
  git(seed, 'init', '-b', 'main');
  git(seed, 'config', 'user.name', 'Fixture'); git(seed, 'config', 'user.email', 'fixture@example.test');
  fs.writeFileSync(path.join(seed, 'base.txt'), 'base\n'); git(seed, 'add', '.'); git(seed, 'commit', '-m', 'Base');
  git(seed, 'remote', 'add', 'origin', origin); git(seed, 'push', 'origin', 'main');
  const base = git(seed, 'rev-parse', 'HEAD'), heads = {};
  for (const name of ['one', 'two', 'bad']) {
    git(seed, 'checkout', '-b', 'task-' + name, base);
    fs.writeFileSync(path.join(seed, name + '.txt'), name + '\n'); git(seed, 'add', '.');
    git(seed, 'commit', '-m', name); git(seed, 'push', 'origin', 'HEAD'); heads[name] = git(seed, 'rev-parse', 'HEAD');
  }
  // The canonical source has only target objects. pin must fetch a new branch itself.
  git(source, 'init'); git(source, 'remote', 'add', 'origin', origin);
  git(source, 'fetch', 'origin', 'main'); git(source, 'checkout', '-b', 'main', 'FETCH_HEAD');
  const count = path.join(root, 'gate-count');
  const repo = {id: 'service', path: source, targetBranch: 'main',
    gateCommands: ['printf x >> ' + quote(count) + '; ' + gate], gateTimeoutSeconds: 20};
  const state = create(repo, path.join(root, 'candidates'), 'proof'); state.base = targetHead(state);
  const row = name => ({address: 'task:' + name, document: {data: {commit: heads[name], delivery:
    {state: 'pending', branch: 'task-' + name, head: heads[name], target: 'main'}}}});
  const pins = names => names.map((name, index) => pin(state, row(name), index));
  return {root, seed, source, origin, repo, state, heads, row, pins,
    calls: () => fs.existsSync(count) ? fs.readFileSync(count, 'utf8').length : 0};
}
test('a green batch runs the full gates once and reuses the exact receipt', t => {
  const f = fixture(t), heads = f.pins(['one', 'two']);
  f.repo.preflight = 'printf "node_modules/\\n" > .git/info/exclude; mkdir -p node_modules; touch node_modules/ready';
  f.repo.gateCommands[0] += '; test -f node_modules/ready';
  let result = candidate(f.state, f.repo, heads, f.root);
  assert.equal(result.checked.passed, true); assert.equal(result.accepted.length, 2);
  assert.equal(f.calls(), 1);
  result = candidate(f.state, f.repo, heads, f.root);
  assert.equal(result.checked.passed, true); assert.equal(f.calls(), 1);
  assert.equal(fs.existsSync(path.join(f.state.checkout, 'node_modules/ready')), true);
  cleanup(f.state, path.join(f.root, 'candidates'));
  assert.equal(fs.existsSync(f.state.checkout), false);
});
test('a red target baseline leaves every branch pending without assigning blame', t => {
  const f = fixture(t, 'exit 1');
  const result = candidate(f.state, f.repo, f.pins(['one', 'two']), f.root);
  assert.equal(result.pending, 'BASELINE_RED'); assert.deepEqual(result.failed, {});
  assert.deepEqual(result.accepted, []); assert.equal(f.calls(), 2);
});
test('two branches that pass alone report an interaction when they fail together', t => {
  const f = fixture(t, 'if [ -e one.txt ] && [ -e two.txt ]; then exit 1; fi');
  const result = candidate(f.state, f.repo, f.pins(['one', 'two']), f.root);
  assert.deepEqual(result.accepted.map(item => item.address), ['task:one']);
  assert.deepEqual(result.failed, {'task:two': 'INTERACTION_FAIL'});
  assert.equal(result.checked.passed, true); assert.equal(f.calls(), 4);
});
test('a moved branch is not replaced with an unchecked head', t => {
  const f = fixture(t);
  git(f.seed, 'checkout', 'task-one'); fs.appendFileSync(path.join(f.seed, 'one.txt'), 'new\n');
  git(f.seed, 'commit', '-am', 'Move head'); git(f.seed, 'push', 'origin', 'HEAD');
  assert.throws(() => pin(f.state, f.row('one'), 1), /BRANCH_MOVED/);
  assert.equal(f.calls(), 0);
});

// The designated test command: legacy fails on the target; core fails with bad.txt and is skipped with one.txt.
const JUNIT = `r="$CREW_TEST_REPORT_DIR/r.xml"; { echo '<testsuite name="s">';
  echo '<testcase classname="c" name="legacy"><failure message="old"/></testcase>';
  if [ -e bad.txt ]; then echo '<testcase classname="c" name="core"><failure message="new"/></testcase>';
  elif [ -e one.txt ]; then echo '<testcase classname="c" name="core"><skipped/></testcase>';
  else echo '<testcase classname="c" name="core"/>'; fi; echo '</testsuite>'; } > "$r"; grep -q '<failure' "$r" && exit 1; exit 0`;
function redTarget(t, gate = JUNIT) {
  const f = fixture(t, gate);
  Object.assign(f.repo, {noNewRed: {testCommand: f.repo.gateCommands[0]},
    testReport: {path: 'r.xml', format: 'junit', identity: '{classname}.{name}'}});
  return f;
}
const verifyPush = (f, checked) => {
  const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  fs.writeFileSync(path.join(checked.attempt, 'artifacts/gates/no-new-red.json'), JSON.stringify({candidate: checked.receipt,
    candidate_sha256: sha(checked.receipt), baseline: checked.baseline, baseline_sha256: sha(checked.baseline)}));
  git(f.state.checkout, 'reset', '--hard', checked.commit);
  return spawnSync('python3', [path.join(tooling, 'lane/bin/gates.py'), 'verify'],
    {cwd: f.state.checkout, env: environment(f.state, f.repo, checked.attempt), encoding: 'utf8'});
};
test('no-new-red lands a red-target candidate that adds no failure and rejects a new failure or skip', t => {
  const f = redTarget(t);
  const result = candidate(f.state, f.repo, f.pins(['two', 'bad']), f.root);
  assert.deepEqual(result.accepted.map(item => item.address), ['task:two']);
  assert.deepEqual(result.failed, {'task:bad': 'BRANCH_GATE_FAIL'});
  assert.equal(result.checked.passed, false); assert.deepEqual(result.checked.tolerated, ['c.legacy']);
  let verified = verifyPush(f, result.checked);
  assert.equal(verified.status, 0, verified.stderr);
  const land = () => spawnSync('bash', [path.join(tooling, 'lane/bin/land.sh'), 'main'],
    {cwd: f.state.checkout, env: environment(f.state, f.repo, result.checked.attempt), encoding: 'utf8'});
  let landed = land();
  assert.equal(landed.status, 0, landed.stderr);
  assert.equal(git(f.seed, 'ls-remote', 'origin', 'refs/heads/main').split(/\s/)[0], result.checked.commit);
  // The proof belongs to the baseline target. A moved target refuses it.
  landed = land();
  assert.equal(landed.status, 3); assert.match(landed.stderr, /not the checked red baseline/);
  // A changed report or a stale proof is refused before any push.
  const receipt = JSON.parse(fs.readFileSync(result.checked.receipt, 'utf8'));
  fs.appendFileSync(path.join(path.dirname(result.checked.receipt), 'test-report', receipt.test_report.path), ' ');
  verified = spawnSync('python3', [path.join(tooling, 'lane/bin/gates.py'), 'verify'],
    {cwd: f.state.checkout, env: environment(f.state, f.repo, result.checked.attempt), encoding: 'utf8'});
  assert.notEqual(verified.status, 0); assert.match(verified.stderr, /test report does not match/);
  const skip = candidate(f.state, f.repo, f.pins(['one']), f.root);
  assert.deepEqual(skip.accepted, []); assert.deepEqual(skip.failed, {'task:one': 'BRANCH_GATE_FAIL'});
});
test('no-new-red stays closed without a complete report or with an incomplete test exit', t => {
  const missing = redTarget(t, 'exit 1');
  assert.equal(candidate(missing.state, missing.repo, missing.pins(['two']), missing.root).pending, 'BASELINE_RED');
  const crashed = redTarget(t, JUNIT.replace('exit 1;', 'exit 2;'));
  assert.equal(candidate(crashed.state, crashed.repo, crashed.pins(['two']), crashed.root).pending, 'BASELINE_RED');
});
test('no-new-red requires a complete green report for a passing exit 0, in run and in verify', t => {
  const lying = redTarget(t, JUNIT.replace(`grep -q '<failure' "$r" && exit 1; exit 0`, 'exit 0'));
  const result = candidate(lying.state, lying.repo, lying.pins(['two']), lying.root);
  assert.equal(result.pending, 'BASELINE_RED'); assert.equal(result.checked.passed, false);
  // A pass recorded without the opt-in is refused once the opt-in applies.
  const plain = fixture(t), passed = candidate(plain.state, plain.repo, plain.pins(['two']), plain.root).checked;
  assert.equal(passed.passed, true);
  Object.assign(plain.repo, {noNewRed: {testCommand: plain.repo.gateCommands[0]},
    testReport: {path: 'r.xml', format: 'junit', identity: '{classname}.{name}'}});
  const verified = spawnSync('python3', [path.join(tooling, 'lane/bin/gates.py'), 'verify'],
    {cwd: plain.state.checkout, env: environment(plain.state, plain.repo, passed.attempt), encoding: 'utf8'});
  assert.notEqual(verified.status, 0); assert.match(verified.stderr, /no passing receipt/);
  assert.equal(environment(plain.state, {...plain.repo, noNewRed: undefined}, passed.attempt).NO_NEW_RED, '');
});
test('a cached tolerated candidate whose setup fails loses its approval', t => {
  const f = redTarget(t), heads = f.pins(['two']);
  f.repo.preflight = 'true';
  assert.deepEqual(candidate(f.state, f.repo, heads, f.root).checked.tolerated, ['c.legacy']);
  f.repo.preflight = 'exit 3';
  const result = candidate(f.state, f.repo, heads, f.root);
  assert.deepEqual(result.accepted, []); assert.equal(result.checked.tolerated, undefined);
  assert.ok(result.pending);
});
