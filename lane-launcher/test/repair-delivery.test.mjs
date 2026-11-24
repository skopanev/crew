import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {packageFixture, packageLanding} from '../test-support/launcher-joppa.fixture.mjs';
import {nextTask, claimTask, guardTaskClaims, finishTask, executionId} from '../joppa.mjs';
import {repairEvidence} from '../repair-delivery.mjs';
import {api} from '../joppa-common.mjs';
import {recordPendingDelivery} from '../pending-delivery.mjs';

async function fixture(t) {
  const f = await packageFixture(t), address = 'task:t2', head = 'a'.repeat(40), branch = 'saved-task-branch';
  f.run.config.delivery = 'branch';
  f.run.config.sourceRoot = f.root;
  f.run.config.worktreeRoot = path.join(f.root, 'worktrees');
  f.run.config.pendingDeliveryData = {stage: 'ready'};
  f.run.config.repositories[0].targetBranch = 'main';
  const task = f.objects.get(address);
  task.document.data.repository = 'app'; task.document.data.commit = head;
  task.document.data.delivery = {state: 'pending', branch, head, target: 'main'};
  const original = structuredClone(task);
  task.document.data.tags = ['keep', 'integration-red']; task.document.data.hold = 'RED';
  for (const ac of ['ac:a1', 'ac:a2']) f.objects.get(ac).document.data.stage = 'ready';
  f.schema.types.ac.fields = {stage: {from: 'own', values: ['ready', 'decide']}};
  const runsFolder = path.join(f.root, 'integration-runs'), artifacts = path.join(runsFolder, 'red-run', 'artifacts');
  fs.mkdirSync(artifacts, {recursive: true});
  fs.writeFileSync(path.join(artifacts, 'input.json'), JSON.stringify({selected: original}));
  fs.writeFileSync(path.join(artifacts, 'lander.json'), JSON.stringify({repository: 'app', target: 'main',
    failed: {[address]: 'BRANCH_GATE_FAIL'}, pins: [{address, branch, head}]}));
  f.run.config.joppa.excludeTags = [...(f.run.config.joppa.excludeTags || []), 'stuck'];
  const policy = {redTag: 'integration-red', redData: {hold: 'RED'}, runsFolder, parentStage: 'ready', returnStage: 'decide', defectTaskStage: 'review',
    attemptField: 'repair_attempt', maxAttempts: 2, exhaustedTag: 'stuck'};
  return {...f, policy, address, head, branch, task};
}
function chooseRepair(f) {
  f.run.config.repairDelivery = f.policy;
  f.run.task = f.address; f.run.taskRevision = 3;
  f.run.tasks = [{address: f.address, revision: 3}]; f.run.executionId = executionId(f.address);
}

test('ordinary pending stays excluded while configured red pending wins before new work', async t => {
  const f = await fixture(t);
  assert.equal((await nextTask(f.run.config)).candidate.id, 'task:t1');
  f.run.config.repairDelivery = f.policy;
  assert.equal((await nextTask(f.run.config)).candidate.id, f.address);
  f.objects.get('ac:a2').document.data.stage = 'decide';
  assert.equal((await nextTask(f.run.config)).candidate.id, 'task:t1');
});

test('repair claim keeps the Task, exact branch and evidence and refuses a changed marker', async t => {
  const f = await fixture(t); chooseRepair(f);
  await claimTask(f.run, f.persist, f.runId);
  assert.equal(f.run.claim.address, f.address);
  assert.equal(f.run.deliveryBranch, f.branch);
  assert.equal(f.run.claim.ticket.integrationRepair.head, f.head);
  assert.match(f.run.claim.ticket.integrationRepair.evidence, /integration-runs\/red-run\/artifacts$/);
  f.task.document.data.tags = ['keep'];
  await assert.rejects(guardTaskClaims(f.run, f.persist), /frozen repair marker/);
});

test('repair refuses failure evidence from a different contract or saved head', async t => {
  const f = await fixture(t); chooseRepair(f);
  f.task.document.data.steps = ['Change a different mechanism.'];
  assert.throws(() => repairEvidence(f.run.config, f.task), /original Task contract changed/);
});

test('repair cannot take another worker claim or start after its acceptance parent leaves implementation', async t => {
  const f = await fixture(t); chooseRepair(f);
  f.task.document.data.assignee = 'another-worker';
  await assert.rejects(claimTask(f.run, f.persist, f.runId), /TASK_ASSIGNED/);
  f.task.document.data.assignee = undefined;
  await claimTask(f.run, f.persist, f.runId);
  f.objects.get('ac:a2').document.data.stage = 'decide';
  await assert.rejects(guardTaskClaims(f.run, f.persist), /acceptance parent/);
  assert.equal(f.task.document.data.assignee, f.run.claim.assignee);
});

test('failed repair releases only its claim and preserves the original pending branch without Tasker stage', async t => {
  const f = await fixture(t); chooseRepair(f);
  await claimTask(f.run, f.persist, f.runId);
  const artifacts = path.join(f.root, 'failed-artifacts'); fs.mkdirSync(artifacts);
  fs.writeFileSync(path.join(artifacts, 'failure.txt'), 'The gate did not complete.');
  const result = {code: 2, status: 'failed'};
  await finishTask(f.run, f.stateFile, result, artifacts);
  assert.equal(result.repairPending, true);
  assert.equal(result.released, true);
  assert.equal(f.task.document.data.stage, 'ready');
  assert.equal(f.task.document.data.delivery.head, f.head);
  assert.equal(f.task.document.data.delivery.branch, f.branch);
  assert.equal(f.task.document.data.assignee, undefined);
  assert.equal(f.task.document.data.hold, 'RED');
  assert.deepEqual(f.task.document.data.repair_attempt, {branch: f.branch, head: f.head, count: 1});
});

test('the configured attempt limit excludes a persistent repair and preserves its pending branch', async t => {
  const f = await fixture(t); chooseRepair(f);
  f.task.document.data.repair_attempt = {branch: f.branch, head: f.head, count: 1};
  await claimTask(f.run, f.persist, f.runId);
  const result = {code: 2, status: 'failed'};
  await finishTask(f.run, f.stateFile, result, null);
  assert.equal(f.task.document.data.repair_attempt.count, 2);
  assert.ok(f.task.document.data.tags.includes('stuck'));
  assert.equal(f.task.document.data.delivery.head, f.head);
  assert.equal((await nextTask(f.run.config)).candidate.id, 'task:t1');
});

test('an unfinished merge keeps the repair claim and checkout before any release request', async t => {
  const f = await fixture(t); chooseRepair(f);
  await claimTask(f.run, f.persist, f.runId);
  const directory = path.join(f.run.config.worktreeRoot, f.run.executionId, '.git');
  fs.mkdirSync(directory, {recursive: true});
  fs.writeFileSync(path.join(directory, 'MERGE_HEAD'), f.head + '\n');
  await assert.rejects(finishTask(f.run, f.stateFile, {code: 2, status: 'failed'}, null), /MERGE_HEAD/);
  assert.equal(f.task.document.data.assignee, f.run.claim.assignee);
  assert.equal(f.run.repairFailureRequest, undefined);
  assert.equal(fs.readFileSync(path.join(directory, 'MERGE_HEAD'), 'utf8'), f.head + '\n');
});

test('an explicit acceptance defect returns its parent with a finding and preserves the pending Task', async t => {
  const f = await fixture(t); chooseRepair(f);
  await claimTask(f.run, f.persist, f.runId);
  const artifacts = path.join(f.root, 'ac-defect'); fs.mkdirSync(artifacts);
  fs.writeFileSync(path.join(artifacts, 'origin.json'), JSON.stringify({signal: 'AC_DEFECT', message: 'The AC requires contradictory outcomes.'}));
  const result = {code: 2, status: 'failed'};
  await finishTask(f.run, f.stateFile, result, artifacts);
  assert.equal(f.objects.get('ac:a2').document.data.stage, 'decide');
  assert.equal(f.task.document.data.stage, 'review');
  assert.equal(f.task.document.data.delivery.head, f.head);
  assert.equal(f.task.document.present, true);
  assert.equal(result.completed, undefined);
});

test('new checked head reuses the saved branch and clears only configured red markers', async t => {
  const f = await fixture(t); chooseRepair(f);
  await claimTask(f.run, f.persist, f.runId);
  const node = await api(f.run.config, f.run.joppaWorker, 'joppa_objects', {workspace: f.run.workspace, address: f.address});
  const result = {}, sha = 'b'.repeat(40);
  await recordPendingDelivery({run: f.run, objects: [node], sha, branch: f.run.deliveryBranch, runId: f.runId,
    persist: f.persist, result});
  assert.equal(result.pendingDelivery, true);
  assert.equal(f.task.document.data.delivery.branch, f.branch);
  assert.equal(f.task.document.data.delivery.head, sha);
  assert.equal(f.task.document.data.hold, undefined);
  assert.deepEqual(f.task.document.data.tags, ['keep']);
  assert.equal(f.task.document.present, true);
});
