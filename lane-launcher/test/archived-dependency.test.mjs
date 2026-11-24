import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {nextTask} from '../joppa.mjs';
import {read} from '../runtime.mjs';
import {guardPublications} from '../publication-guard.mjs';
import {fixture} from '../test-support/requirement-delivery.fixture.mjs';
import {packageFixture} from '../test-support/launcher-joppa.fixture.mjs';
import {execute, worker} from '../test-support/launcher.fixture.mjs';

test('an archived prerequisite without a commit returns the consumer before repository execution', async t => {
  const f = await packageFixture(t);
  f.queue.splice(0, 1);
  const task = f.objects.get('task:t1'), parent = f.objects.get('ac:a1');
  task.document.data.returns = 2;
  parent.document.data.returns = 1;
  const dependency = structuredClone(f.objects.get('task:t2'));
  dependency.address = 'task:old';
  dependency.document.present = false;
  dependency.document.data.stage = 'review';
  const before = structuredClone(dependency);
  f.objects.set(dependency.address, dependency);
  task.document.links = [{relation: 'depends_on', blocking: true, target: dependency.address}];
  const selected = await nextTask(f.run.config);
  assert.equal(selected.candidate.id, task.address);
  assert.equal(f.calls.some(call => call.name === 'joppa_batch'), false);
  f.run.tasks = selected.candidate.tasks;
  const bins = path.join(f.root, 'bins'), marker = path.join(f.root, 'execution');
  fs.mkdirSync(bins);
  Object.assign(f.run.config, {worktreeRoot: path.join(f.root, 'worktrees'), sshDir: f.root, readOnlyRepos: []});
  for (const name of ['bash', 'codex', 'claude', 'medulla']) {
    fs.writeFileSync(path.join(bins, name), '#!/bin/sh\necho started >> "$EXECUTION_MARKER"\nexit 99\n', {mode: 0o755});
  }
  fs.writeFileSync(path.join(bins, 'docker'), '#!/bin/sh\n[ "$1" != run ] || echo started >> "$EXECUTION_MARKER"\nexit 0\n', {mode: 0o755});
  f.persist();
  const result = await execute(worker, [f.stateFile], {...process.env, PATH: `${bins}:${process.env.PATH}`, EXECUTION_MARKER: marker});
  assert.equal(result.code, 2, result.stderr);
  assert.equal(fs.existsSync(marker), false);
  const saved = read(f.stateFile);
  assert.equal(saved.result.blockConfirmed, true);
  assert.match(saved.result.error, /DEPENDENCY_REPLAN: task:old/);
  assert.equal(task.document.data.stage, f.run.config.FAILED_TASK_STAGE);
  assert.equal(task.document.data.assignee, undefined);
  assert.equal(task.document.data.returns, 2);
  assert.equal(parent.document.data.returns, 1);
  assert.deepEqual(f.objects.get(dependency.address), before);
});

test('an archived prerequisite still needs its recorded commit on the delivery branch', async () => {
  const f = fixture(), task = f.objects.get('work:two');
  f.objects.get('work:one').document.links = [{relation: 'depends_on', blocking: true, target: task.address}];
  const run = {...f.run, repository: {id: 'repo'}};
  let reads = 0;
  const ancestor = async () => { reads++; return false; };
  delete task.document.data.commit;
  await assert.rejects(guardPublications(run, f.read, ancestor), {code: 'DEPENDENCY_REPLAN'});
  assert.equal(reads, 0);
  task.document.data.commit = `repo ${'a'.repeat(40)}`;
  await assert.rejects(guardPublications(run, f.read, ancestor), {code: 'DEPENDENCY_NOT_LANDED'});
  assert.equal(reads, 1);
});
