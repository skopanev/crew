import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {nextTask, claimTask, guardTaskClaims, finishTask} from '../joppa.mjs';
import {writeLaunchClaim} from '../joppa-claims.mjs';
import {validateTaskFilter} from '../task-filter.mjs';
import {packageFixture, packageLanding} from '../test-support/launcher-joppa.fixture.mjs';

const exec = promisify(execFile);
const tags = ['hold-owner', 'hold-policy', 'hold-retry'];
const checker = fileURLToPath(new URL('../../lane/bin/requirement-current.mjs', import.meta.url));

test('tag exclusions use the configuration and reject malformed lists', async t => {
  const f = await packageFixture(t);
  for (const invalid of [null, 'hold', [''], [' hold'], [42]]) {
    assert.throws(() => validateTaskFilter({...f.run.config, joppa: {...f.run.config.joppa, excludeTags: invalid}}), /excludeTags/);
  }
  f.run.config.joppa.excludeTags = tags;
  f.objects.get('ac:a1').document.data.tags = ['hold-owner'];
  assert.equal((await nextTask(f.run.config)).candidate.id, 'task:t2');
  f.run.tasks = [f.run.tasks[0]];
  f.objects.get('task:t1').document.data.tags = ['hold-policy'];
  await assert.rejects(claimTask(f.run, f.persist, f.runId), /QUESTION_TAG: task:t1/);
  assert.equal(f.calls.some(call => call.name === 'joppa_batch'), false);
});

for (const tag of tags) test(`a configured tag stops startup and push but preserves a completed publication: ${tag}`, async t => {
  const f = await packageFixture(t);
  f.run.config.joppa.excludeTags = tags;
  f.run.tasks = [f.run.tasks[0]];
  await claimTask(f.run, f.persist, f.runId);
  const parent = f.objects.get('ac:a1'), originalStage = parent.document.data.stage;
  const artifacts = packageLanding(f);
  f.run.runFolder = f.root;
  const captured = writeLaunchClaim(f.run, f.root);
  fs.copyFileSync(captured, path.join(artifacts, 'claim.json'));
  assert.deepEqual(JSON.parse(fs.readFileSync(captured, 'utf8')).excluded_tags, tags);
  const env = {...process.env, MEDULLA_RUN_DIR: f.root, REQUIREMENT_READER_FILE: f.run.joppaWorker.tokenFile};
  parent.document.data.tags = ['unrelated'];
  await guardTaskClaims(f.run, f.persist);
  assert.match((await exec(process.execPath, [checker, '--tasks'], {env})).stdout, /are current/);
  parent.document.data.tags = ['unrelated', tag];
  await assert.rejects(guardTaskClaims(f.run, f.persist), /QUESTION_TAG: ac:a1/);
  await assert.rejects(exec(process.execPath, [checker, '--tasks'], {env}),
    error => /QUESTION_TAG: ac:a1; publication refused/.test(error.stderr));
  const result = {code: 0, status: 'exited'};
  await finishTask(f.run, f.stateFile, result, artifacts);
  assert.equal(result.completed, true);
  assert.equal(parent.document.data.stage, originalStage);
  assert.deepEqual(parent.document.data.tags, ['unrelated', tag]);
});
