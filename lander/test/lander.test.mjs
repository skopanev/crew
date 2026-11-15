import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {git, create, targetHead, pin, candidate, cleanup} from '../git.mjs';

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
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
