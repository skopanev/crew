import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {save} from '../runtime.mjs';
import {recordRetained, retainedCheckout, retainedLine, prepareReuse} from '../retained-checkout.mjs';
import {claimTask, finishTask, contractDigest} from '../joppa.mjs';
import {packageFixture} from '../test-support/launcher-joppa.fixture.mjs';
import {defaultWorkflow, supportsRetainedCheckout} from '../workflow-config.mjs';

// A fake Docker answers from DOCKER_ROWS: an empty list means no running container.
function fakeDocker(root) {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env node
const rows = JSON.parse(process.env.DOCKER_ROWS || '[]');
if (process.argv[2] === 'ps') console.log(rows.map((row, index) => 'c' + index).join('\\n'));
else console.log(JSON.stringify(rows));
`, {mode: 0o755});
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  process.env.DOCKER_ROWS = '[]';
  return () => { process.env.PATH = previous; delete process.env.DOCKER_ROWS; };
}

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], {encoding: 'utf8',
  env: {...process.env, GIT_AUTHOR_NAME: 'lane', GIT_AUTHOR_EMAIL: 'lane@local', GIT_COMMITTER_NAME: 'lane',
    GIT_COMMITTER_EMAIL: 'lane@local'}}).trim();

const ORIGIN = 'ssh://example.invalid/app.git';
// The process group of a lane that has already stopped.
const stoppedPgid = () => spawnSync('true').pid;

// A clean lane branch with one commit above lane-base and ignored dependencies.
function laneCheckout(checkout, executionId) {
  fs.mkdirSync(checkout, {recursive: true});
  git(checkout, 'init', '-q', '-b', `ticket-${executionId}`);
  git(checkout, 'remote', 'add', 'origin', ORIGIN);
  fs.writeFileSync(path.join(checkout, 'a.txt'), 'base\n');
  fs.writeFileSync(path.join(checkout, '.gitignore'), 'node_modules/\n');
  git(checkout, 'add', '-A'); git(checkout, 'commit', '-qm', 'base');
  fs.writeFileSync(path.join(checkout, '.git/lane-base'), git(checkout, 'rev-parse', 'HEAD') + '\n');
  fs.writeFileSync(path.join(checkout, 'a.txt'), 'change\n');
  git(checkout, 'commit', '-qam', 'change');
  // Ignored dependencies stay in place and do not make the checkout dirty.
  fs.mkdirSync(path.join(checkout, 'node_modules'));
  fs.writeFileSync(path.join(checkout, 'node_modules/dep.js'), '');
}

async function reuseFixture(t, {node = 'implement_code', signal = 'GATE_FAIL'} = {}) {
  const f = await packageFixture(t);
  t.after(fakeDocker(f.root));
  const config = {...f.run.config, delivery: 'target', worktreeRoot: path.join(f.root, 'wt'),
    stateDir: path.join(f.root, 'state')};
  const executionId = 'joppa-' + 'a'.repeat(32), checkout = path.join(config.worktreeRoot, executionId);
  laneCheckout(checkout, executionId);
  const canonical = path.join(f.root, 'canonical');
  fs.mkdirSync(canonical);
  git(canonical, 'init', '-q');
  git(canonical, 'remote', 'add', 'origin', ORIGIN);
  const repository = {id: 'app', path: canonical, targetBranch: 'main'};
  // The new claim holds the live Task. Its digest is the digest of the live contract.
  const task = f.objects.get('task:t1');
  task.document.data.assignee = 'crew-lane:new';
  const digest = contractDigest(task);
  const claim = (assignee, retained) => ({claimed: true, id: executionId, assignee, address: 'task:t1',
    tasks: [{address: 'task:t1', digest}], contexts: [{address: 'ac:a1', digest: 'c1'}],
    ticket: {id: executionId, modulePaths: ['a.txt'], ...(retained ? {retained} : {})}});
  const runDir = name => path.join(config.stateDir, 'runs', name);
  const priorId = randomUUID(), prior = {config, workspace: 'fixture', joppaWorker: f.run.joppaWorker, task: 'task:t1',
    executionId, repository, createdAt: '2026-11-13T10:00:00.000Z', runFolder: path.join(runDir(priorId), 'lane'),
    claim: claim('crew-lane:old'), launchPgid: stoppedPgid()};
  const artifacts = path.join(prior.runFolder, 'm1', 'artifacts');
  fs.mkdirSync(path.join(prior.runFolder, 'm1', 'steps', '007-expert_review'), {recursive: true});
  fs.mkdirSync(artifacts);
  fs.writeFileSync(path.join(artifacts, 'origin.json'), JSON.stringify({node, signal, message: 'stopped'}));
  for (const name of ['scout.txt', 'coder-report.txt', 'failure.txt', 'rejects.txt', 'security.md', 'reviewed-tree.txt',
    'test-bindings-receipt.json', 'test-bindings.json']) fs.writeFileSync(path.join(artifacts, name), `${name}\n`);
  fs.writeFileSync(path.join(prior.runFolder, 'm1', 'steps', '007-expert_review', 'inputs.json'),
    JSON.stringify([{slug: 'security'}, {slug: '../escape'}]));
  // The failure outcome records the checkout and notes it in the Task block.
  prior.retained = recordRetained(prior, artifacts);
  assert.ok(prior.retained, 'a clean lane checkout is recorded');
  const note = {op: 'note', target: 'task:t1', id: randomUUID(), reply_to: null,
    text: `CREW_FAILURE\nTask: task:t1\nRun: ${priorId}\nReason: ${signal}\n${retainedLine(prior.retained)}\nlane stopped`};
  prior.blockRequest = {operations: [{command: note}]};
  prior.result = {status: 'failed', code: 1, blocked: true, blockConfirmed: true};
  f.objects.get('task:t1').annotations.comments[note.id] = {actor: 'lane-1', text: note.text, withdrawn: false};
  const savePrior = () => { fs.mkdirSync(runDir(priorId), {recursive: true}); save(path.join(runDir(priorId), 'launch.json'), prior); };
  savePrior();
  const currentId = randomUUID();
  fs.mkdirSync(runDir(currentId), {recursive: true});
  const run = {config, workspace: 'fixture', joppaWorker: f.run.joppaWorker, task: 'task:t1', executionId, repository,
    createdAt: '2026-11-13T11:00:00.000Z', runFolder: path.join(runDir(currentId), 'lane'), claim: claim('crew-lane:new')};
  return {f, run, dir: runDir(currentId), prior, savePrior, artifacts, checkout, note};
}

test('a confirmed GATE_FAIL checkout returns to the coder with prior reports only', async t => {
  const x = await reuseFixture(t);
  const head = git(x.checkout, 'rev-parse', 'HEAD'), lines = [];
  fs.mkdirSync(x.run.runFolder, {recursive: true});
  assert.equal(await prepareReuse(x.run, x.dir, line => lines.push(line), () => {}), head);
  assert.deepEqual(x.run.claim.ticket.retained, {head, tree: git(x.checkout, 'rev-parse', 'HEAD^{tree}'),
    base: x.prior.retained.base, route: 'coder', previousRun: path.basename(path.dirname(x.prior.runFolder))});
  assert.match(lines[0], /^\[lane\] REUSE [0-9a-f]{12} from .* · route coder$/);
  const inputs = path.join(x.run.runFolder, 'resume-inputs');
  assert.deepEqual(fs.readdirSync(inputs).sort(), ['prior', 'scout.txt', 'test-bindings.json']);
  assert.deepEqual(fs.readdirSync(path.join(inputs, 'prior')).sort(), ['coder-report.txt', 'failure.txt', 'rejects.txt', 'security.md']);
  // Without a scout report the run does not resume.
  fs.writeFileSync(path.join(x.artifacts, 'scout.txt'), '');
  fs.rmSync(inputs, {recursive: true});
  assert.equal(await prepareReuse(x.run, x.dir, line => lines.push(line), () => {}), '');
  assert.match(lines.at(-1), /prior scout.txt is missing or empty/);
  const workflow = path.join(x.f.root, 'workflow.yaml');
  fs.copyFileSync(defaultWorkflow, workflow);
  assert.equal(supportsRetainedCheckout(workflow), true);
  fs.appendFileSync(workflow, '\n# A custom workflow needs its own retained-state support.\n');
  assert.equal(supportsRetainedCheckout(workflow), false);
});

test('REVIEW_INCOMPLETE reviews again only without a known blocker', async t => {
  const x = await reuseFixture(t, {node: 'expert_review_synthesis', signal: 'REVIEW_INCOMPLETE'});
  const round = lines => fs.writeFileSync(path.join(x.artifacts, 'panel-findings.txt'), `- codex: CLEAR\n---\n${lines}\n---\n`);
  round('- agy: TIMEOUT (m, rc=124, attempts=2)\n- claude-code: CLEAR');
  assert.equal((await retainedCheckout(x.run, x.dir)).retained.route, 'review');
  // Prior receipts are not scheduling inputs. The new run must produce its own evidence.
  fs.rmSync(path.join(x.artifacts, 'test-bindings-receipt.json'));
  assert.equal((await retainedCheckout(x.run, x.dir)).retained.route, 'review');
  round('- agy: no verdict\n- claude-code: REJECT: HIGH findings contradict CLEAR');
  assert.equal((await retainedCheckout(x.run, x.dir)).retained.route, 'coder');
  round('- agy: no verdict\n- HIGH - unsafe write - a.js:1 - loss - FIX: guard');
  assert.equal((await retainedCheckout(x.run, x.dir)).retained.route, 'coder');
  fs.writeFileSync(path.join(x.artifacts, 'panel-findings.txt'), '');
  assert.equal((await retainedCheckout(x.run, x.dir)).retained.route, 'coder');
});

test('reuse fails closed on any mismatch', async t => {
  const x = await reuseFixture(t);
  const refused = async pattern => {
    const reuse = await retainedCheckout(x.run, x.dir);
    assert.equal(reuse.retained, undefined);
    assert.match(reuse.reason, pattern);
  };
  fs.writeFileSync(path.join(x.checkout, 'stray.txt'), 'x');
  await refused(/uncommitted changes/);
  // A local core.worktree written by an agent cannot point the clean check elsewhere.
  const elsewhere = fs.mkdtempSync(path.join(path.dirname(x.checkout), 'elsewhere-'));
  for (const name of ['a.txt', '.gitignore']) fs.copyFileSync(path.join(x.checkout, name), path.join(elsewhere, name));
  git(x.checkout, 'config', 'core.worktree', elsewhere);
  await refused(/uncommitted changes/);
  git(x.checkout, 'config', '--unset', 'core.worktree');
  fs.rmSync(elsewhere, {recursive: true});
  fs.rmSync(path.join(x.checkout, 'stray.txt'));
  // A filter or an include in the agent-writable config is refused before Git status runs.
  const marker = path.join(path.dirname(x.checkout), 'filter-ran');
  fs.writeFileSync(path.join(x.checkout, '.git/info/attributes'), '* filter=evil\n');
  for (const [key, value] of [['filter.evil.clean', `touch ${marker}; cat`], ['includeIf.gitdir:/.path', '/dev/null'],
    ['include.path', '/dev/null'], ['extensions.worktreeConfig', 'true']]) {
    git(x.checkout, 'config', key, value);
    await refused(/\.git\/config sets/);
    git(x.checkout, 'config', '--unset', key);
  }
  fs.rmSync(path.join(x.checkout, '.git/info/attributes'));
  assert.equal(fs.existsSync(marker), false);
  fs.writeFileSync(path.join(x.checkout, '.git/config.worktree'), '');
  await refused(/\.git\/config\.worktree/);
  fs.rmSync(path.join(x.checkout, '.git/config.worktree'));
  process.env.DOCKER_ROWS = JSON.stringify([{Config: {Labels: {'medulla.runs_under': x.prior.runFolder}}, Mounts: []}]);
  await refused(/container uses the checkout/);
  process.env.DOCKER_ROWS = JSON.stringify([{Config: {Labels: {}}, Mounts: [{Source: x.checkout}]}]);
  await refused(/container uses the checkout/);
  process.env.DOCKER_ROWS = '[]';
  const digest = x.run.claim.tasks[0].digest;
  x.run.claim.tasks[0].digest = 'd2';
  await refused(/contract or context changed/);
  x.prior.claim.tasks[0].digest = 'd2';
  x.savePrior();
  // An owner edit after the claim makes the stored claim stale.
  await refused(/changed after it/);
  x.prior.claim.tasks[0].digest = digest;
  x.savePrior();
  x.run.claim.tasks[0].digest = digest;
  x.f.objects.get('task:t1').document.data.assignee = 'crew-lane:other';
  await refused(/not held by this claim/);
  x.f.objects.get('task:t1').document.data.assignee = 'crew-lane:new';
  x.f.objects.get('task:t1').annotations.comments[x.note.id].withdrawn = true;
  await refused(/no matching failure note/);
  x.f.objects.get('task:t1').annotations.comments[x.note.id].withdrawn = false;
  for (const retained of [{head: x.prior.retained.head, tree: 'f'.repeat(40)},
    {head: 'e'.repeat(40), tree: x.prior.retained.tree}]) {
    x.prior.claim.ticket.retained = retained;
    x.savePrior();
    await refused(/already retried once/);
  }
  delete x.prior.claim.ticket.retained;
  x.prior.result.code = 73;
  x.savePrior();
  await refused(/no failed run/);
  x.prior.result.code = 1;
  x.savePrior();
  fs.writeFileSync(path.join(x.checkout, 'a.txt'), 'other\n');
  git(x.checkout, 'commit', '-qam', 'other');
  await refused(/head changed/);
  git(x.checkout, 'reset', '-q', '--hard', 'HEAD~1');
  for (const run of [x.run, x.prior]) {
    run.claim.ticket.modulePaths = ['src'];
    x.savePrior();
    await refused(/outside the Task modulePaths/);
    run.claim.ticket.modulePaths = ['a.txt'];
    x.savePrior();
  }
  git(x.checkout, 'remote', 'set-url', 'origin', 'ssh://example.invalid/other.git');
  await refused(/origin differs/);
  git(x.checkout, 'remote', 'set-url', 'origin', ORIGIN);
  assert.ok((await retainedCheckout(x.run, x.dir)).retained);
  x.run.config = {...x.run.config, delivery: 'requirement'};
  await refused(/single Task with target or branch delivery/);
});

test('an unknown failure origin and a live writer leave no reusable record', async t => {
  const x = await reuseFixture(t, {node: 'prepare_review', signal: '__timeout__'});
  assert.match((await retainedCheckout(x.run, x.dir)).reason, /prepare_review\/__timeout__ cannot resume/);
  fs.writeFileSync(path.join(x.artifacts, 'origin.json'), JSON.stringify({node: 'create_worktree', signal: 'RETAINED_CHANGED'}));
  assert.equal(recordRetained(x.prior, x.artifacts), null);
  fs.writeFileSync(path.join(x.artifacts, 'origin.json'), JSON.stringify({node: 'implement_code', signal: 'GATE_FAIL'}));
  assert.ok(recordRetained(x.prior, x.artifacts));
  process.env.DOCKER_ROWS = JSON.stringify([{Config: {Labels: {}}, Mounts: [{Source: x.checkout}]}]);
  assert.equal(recordRetained(x.prior, x.artifacts), null);
  process.env.DOCKER_ROWS = '[]';
  fs.writeFileSync(path.join(x.checkout, 'a.txt'), 'dirty\n');
  assert.equal(recordRetained(x.prior, x.artifacts), null);
  git(x.checkout, 'checkout', '-q', '--', 'a.txt');
  assert.ok(recordRetained(x.prior, x.artifacts));
  // Without a valid process group the writer is not proven to be gone.
  assert.equal(recordRetained({...x.prior, launchPgid: undefined}, x.artifacts), null);
});

test('a single-Task failure records the clean checkout and notes it in the Task block', async t => {
  const f = await packageFixture(t);
  t.after(fakeDocker(f.root));
  f.run.tasks = [{address: 'task:t1', revision: 3}];
  f.run.launchPgid = stoppedPgid();
  f.run.config = {...f.run.config, delivery: 'target', worktreeRoot: path.join(f.root, 'wt')};
  await claimTask(f.run, f.persist, f.runId);
  const checkout = path.join(f.run.config.worktreeRoot, f.run.executionId);
  laneCheckout(checkout, f.run.executionId);
  const artifacts = path.join(f.run.runFolder, 'm1', 'artifacts');
  fs.mkdirSync(artifacts, {recursive: true});
  fs.writeFileSync(path.join(artifacts, 'failure.txt'), 'Required check failed\n');
  fs.writeFileSync(path.join(artifacts, 'origin.json'), JSON.stringify({node: 'implement_code', signal: 'GATE_FAIL'}));
  const result = {code: 1, status: 'failed'};
  await finishTask(f.run, f.stateFile, result, artifacts);
  assert.equal(result.blockConfirmed, true);
  assert.deepEqual(f.run.retained, {checkout, branch: `refs/heads/ticket-${f.run.executionId}`,
    head: git(checkout, 'rev-parse', 'HEAD'), tree: git(checkout, 'rev-parse', 'HEAD^{tree}'),
    base: fs.readFileSync(path.join(checkout, '.git/lane-base'), 'utf8').trim(),
    node: 'implement_code', signal: 'GATE_FAIL', artifacts});
  const note = f.run.blockRequest.operations[1].command;
  assert.equal(note.text, `CREW_FAILURE\nTask: task:t1\nRun: ${f.runId}\nReason: GATE_FAIL\n` +
    `${retainedLine(f.run.retained)}\nRequired check failed`);
});
