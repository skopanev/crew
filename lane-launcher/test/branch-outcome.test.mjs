import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {claimTask, finishTask, nextTask} from '../joppa.mjs';
import {packageFixture, packageLanding} from '../test-support/launcher-joppa.fixture.mjs';
import {branchOutcome} from '../branch-outcome.mjs';
import {renderRunTable} from '../dashboard.mjs';
import {spawnSync} from 'node:child_process';
import {scopeDirectory} from '../scope.mjs';
import {recordPendingDelivery} from '../pending-delivery.mjs';

const batches = f => f.calls.filter(call => call.name === 'joppa_batch').map(call => call.args.operations.map(({command}) => command));

test('branch publication releases Tasks for Lander without archiving or selecting them again', async t => {
  const f = await packageFixture(t);
  await claimTask(f.run, f.persist, f.runId);
  const objects = ['task:t1', 'task:t2'].map(id => structuredClone(f.objects.get(id)));
  const artifacts = packageLanding(f, 'branch'), result = {code: 0, status: 'exited'};
  const sha = fs.readFileSync(path.join(artifacts, 'landing.txt'), 'utf8').match(/^Landed SHA: (\S+)$/m)[1];
  await assert.rejects(recordPendingDelivery({run: f.run, objects, sha,
    branch: f.run.deliveryBranch || `ticket-${f.run.executionId}`, runId: f.runId, result,
    persist: () => { throw new Error('Interrupted after saving the request'); }}), /Interrupted/);
  const timestamp = f.run.pendingDeliveryRequest.operations[0].command.data.delivery.pushed_at;
  await finishTask(f.run, f.stateFile, result, artifacts);
  assert.equal(result.pendingDelivery, true);
  assert.equal(result.status, 'DONE');
  assert.equal(branchOutcome(f.run, result), 'DONE');
  assert.equal(result.completed, undefined);
  assert.equal(batches(f).flat().some(command => command.op === 'archive_object'), false);
  for (const address of ['task:t1', 'task:t2']) {
    const node = f.objects.get(address);
    assert.equal(node.document.present, true);
    assert.equal(node.document.data.assignee, undefined);
    assert.equal(node.document.data.stage, 'to_review');
    assert.equal(node.document.data.delivery.head, node.document.data.commit);
    assert.equal(node.document.data.delivery.target, 'main');
    assert.equal(node.document.data.delivery.state, 'pending');
    assert.ok(Number.isFinite(Date.parse(node.document.data.delivery.pushed_at)));
  }
  assert.equal(f.run.pendingDeliveryRequest.operations[0].command.data.delivery.pushed_at, timestamp);
  assert.equal((await nextTask(f.run.config, {})).candidate, null);
  const stateDir = path.join(f.root, 'collector'), folder = path.join(scopeDirectory(stateDir, 'example'), 'runs', f.runId);
  fs.mkdirSync(folder, {recursive: true});
  fs.writeFileSync(path.join(folder, 'launch.json'), JSON.stringify({...f.run,
    createdAt: '2026-01-01T00:00:00Z', result: {...result, finishedAt: '2026-01-01T00:01:00Z'}}));
  const configFile = path.join(f.root, 'collect.json'), output = path.join(f.root, 'runs.jsonl');
  fs.writeFileSync(configFile, JSON.stringify({id: 'example', stateDir}));
  const collected = spawnSync(process.execPath, [new URL('../collect-runs.mjs', import.meta.url).pathname, configFile, output], {encoding: 'utf8'});
  assert.equal(collected.status, 0, collected.stderr);
  const row = JSON.parse(fs.readFileSync(output, 'utf8').trim());
  assert.equal(row.status, 'DONE');
  assert.equal(row.delivery.state, 'pending');
  const display = renderRunTable([{ticket: 'task:t1', status: 'PENDING_LANDING', stage: 'PENDING_LANDING',
    runId: f.runId, start: '2026-01-01T00:00:00Z', end: '2026-01-01T00:01:00Z'}],
  (tone, value) => tone === 'ready' ? `<green>${value}</green>` : value).join('\n');
  assert.match(display, /<green>DONE/);
  assert.doesNotMatch(display, /PENDING_LANDING/);
  assert.equal(branchOutcome(f.run, {...result, code: 2}), null);
  assert.equal(branchOutcome(f.run, {...result, held: true}), null);
  assert.equal(branchOutcome({...f.run, config: {...f.run.config, branchSuccessStatus: 'DELIVERED'}}, result), 'DELIVERED');
});
