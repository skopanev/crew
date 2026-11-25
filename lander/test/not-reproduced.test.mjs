import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {candidate, environment, git, tooling} from '../git.mjs';

function fixture(t, mode = 'green') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lander-rerun-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const checkout = path.join(root, 'checkout'), origin = path.join(root, 'origin.git');
  fs.mkdirSync(checkout);
  git(root, 'init', '--bare', origin);
  git(checkout, 'init', '-b', 'main');
  git(checkout, 'config', 'user.name', 'Fixture');
  git(checkout, 'config', 'user.email', 'fixture@example.invalid');
  for (const name of ['one.test.ts', 'two.test.ts']) fs.writeFileSync(path.join(checkout, name), 'test source\n');
  git(checkout, 'add', '.'); git(checkout, 'commit', '-m', 'Base');
  git(checkout, 'remote', 'add', 'origin', origin); git(checkout, 'push', 'origin', 'main');
  const base = git(checkout, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(checkout, 'change.txt'), 'candidate\n');
  git(checkout, 'add', '.'); git(checkout, 'commit', '-m', 'Candidate');
  const head = git(checkout, 'rev-parse', 'HEAD'), count = path.join(root, 'calls');
  const runner = path.join(root, 'runner.py');
  fs.writeFileSync(runner, `import os, pathlib, sys
full = sys.argv[1] == 'full'
mode = ${JSON.stringify(mode)}
with open(${JSON.stringify(count)}, 'a') as f: f.write('F' if full else 'R')
failed = full or mode == 'red'
second = '' if mode == 'missing' and not full else '<testcase name="one keeps its state" file="one.test.ts"/>'
report = '<testsuite><testcase name="one obeys its budget" file="one.test.ts">' + ('<failure message="budget"/>' if failed else '') + '</testcase>' + second
if full: report += '<testcase name="two passes" file="two.test.ts"/>'
report += '</testsuite>'
pathlib.Path(os.environ['CREW_TEST_REPORT_DIR'], 'results.xml').write_text(report)
print('native file result:', sys.argv[1])
sys.exit(1 if failed else 0)
`);
  const repo = {id: 'service', path: checkout, gateTimeoutSeconds: 10,
    gateCommands: [`python3 '${runner}' full`],
    testReport: {path: 'results.xml', format: 'junit', identity: '{name}'},
    notReproduced: {command: ['python3', runner], attempts: 2}};
  const state = {checkout, base, target: 'main', cache: {}};
  return {root, checkout, origin, repo, state, heads: [{address: 'task:one', head}],
    calls: () => fs.readFileSync(count, 'utf8')};
}

const verify = (f, checked) => spawnSync('python3', [path.join(tooling, 'lane/bin/gates.py'), 'verify'],
  {cwd: f.checkout, env: environment(f.state, f.repo, checked.attempt), encoding: 'utf8'});

test('a test-only red batch uses two file samples, skips the baseline and can pass the normal push verifier', t => {
  const f = fixture(t), result = candidate(f.state, f.repo, f.heads, f.root);
  assert.equal(result.checked.passed, true);
  assert.deepEqual(result.accepted.map(item => item.address), ['task:one']);
  assert.equal(f.calls(), 'FRR', 'One full run, only the failed file runs again');
  let check = verify(f, result.checked);
  assert.equal(check.status, 0, check.stderr);
  const landed = spawnSync('bash', [path.join(tooling, 'lane/bin/land.sh'), 'main'],
    {cwd: f.checkout, encoding: 'utf8', env: {...environment(f.state, f.repo, result.checked.attempt),
      JOPPA_READER_COMMAND_JSON: '', REQUIREMENT_READER_FILE: ''}});
  assert.equal(landed.status, 0, landed.stderr);
  assert.equal(git(f.checkout, 'ls-remote', 'origin', 'refs/heads/main').split(/\s/)[0], result.checked.commit);
  const receipt = JSON.parse(fs.readFileSync(result.checked.receipt));
  assert.equal(receipt.checks[0].exit_code, 1, 'The original failure stays recorded');
  assert.ok(receipt.not_reproduced);
  fs.appendFileSync(receipt.checks[0].log, 'changed evidence\n');
  check = verify(f, result.checked);
  assert.notEqual(check.status, 0, 'A changed original log invalidates recovery');
});

for (const mode of ['red', 'missing']) test(`a ${mode} file rerun keeps the original red path`, t => {
  const f = fixture(t, mode), result = candidate(f.state, f.repo, f.heads, f.root);
  assert.equal(result.checked.passed, false);
  assert.deepEqual(result.accepted, []);
  assert.equal(result.pending, 'BASELINE_RED');
  assert.equal(f.calls().includes('RR'), false, 'A failed or incomplete first sample stops recovery');
});
