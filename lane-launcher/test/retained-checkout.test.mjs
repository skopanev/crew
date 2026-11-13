import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {recordRetained, retainedCheckout, retainedLine, prepareReuse} from '../retained-checkout.mjs';
import {claimTask, finishTask} from '../joppa.mjs';
import {packageFixture} from '../test-support/launcher-joppa.fixture.mjs';
import {fakeDocker, git, laneCheckout, stoppedPgid, reuseFixture, ORIGIN} from '../test-support/retained-checkout.fixture.mjs';
import {defaultWorkflow, supportsRetainedCheckout, workflowDigest} from '../workflow-config.mjs';

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
  assert.notEqual(x.run.workflow.digest, workflowDigest(defaultWorkflow));
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
  const workflow = x.prior.workflow, bytes = fs.readFileSync(workflow.file);
  for (const prior of [undefined, {...workflow, digest: 'bad'}, {...workflow, digest: 'f'.repeat(64)}]) {
    x.prior.workflow = prior; x.savePrior();
    await refused(/workflow changed|workflow digest/);
  }
  x.prior.workflow = workflow; x.savePrior();
  fs.appendFileSync(workflow.file, '\n# Changed timeout.\n');
  await refused(/workflow changed/);
  assert.equal(recordRetained(x.prior, x.artifacts), null);
  fs.writeFileSync(workflow.file, bytes);
  x.run.workflow.file = path.join(x.f.root, 'relocated.yaml');
  fs.writeFileSync(x.run.workflow.file, bytes);
  assert.ok((await retainedCheckout(x.run, x.dir)).retained);
  for (const value of ['2', '']) {
    fs.writeFileSync(x.run.workflow.file, bytes.toString().replace("RETAINED_CHECKOUT_PROTOCOL: '1'", `RETAINED_CHECKOUT_PROTOCOL: '${value}'`));
    x.run.workflow.digest = workflowDigest(x.run.workflow.file);
    x.prior.workflow = {...x.run.workflow}; x.savePrior();
    assert.equal(supportsRetainedCheckout(x.run.workflow.file), false);
    await refused(/workflow changed/);
    assert.equal(recordRetained(x.prior, x.artifacts), null);
  }
  fs.writeFileSync(x.run.workflow.file, bytes); x.run.workflow.digest = workflow.digest;
  x.prior.workflow = workflow; x.savePrior();
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
  f.run.workflow = {file: defaultWorkflow, digest: workflowDigest()};
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
