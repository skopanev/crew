import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {packageFixture} from '../lane-launcher/test-support/launcher-joppa.fixture.mjs';
import {api} from '../lane-launcher/joppa-common.mjs';
import {nextConfiguredItem} from './queue.mjs';
import {completionPolicy} from '../tasker/completion-policy.mjs';
import {inspect} from '../tasker/completion.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
test('only free red pending review evidence passes queue, fresh completion and the prepare guard', async t => {
  const f = await packageFixture(t), task = f.objects.get('task:t2');
  for (const id of ['ac:a1', 'ac:a2']) f.objects.get(id).document.data.stage = 'ready';
  const vars = {TASKER_READY_STAGE: 'ready', TASKER_IMPLEMENT_STAGE: 'build', TASKER_DONE_STAGE: 'done',
    TASK_STAGE: 'ready', TASKER_TASK_REVIEW_STAGE: 'review'};
  const config = {workspace: f.run.workspace, url: f.run.config.joppa.url, workflow: '/workflow.yaml', vars,
    selection: {kind: 'ac', data: {stage: 'ready'}}, exclude_children: [
      {kind: 'task', data: {stage: 'ready'}}, {kind: 'task', data: {stage: 'review'}, except_pending_tag: 'red'}]};
  const normal = structuredClone(task.document.data);
  const input = {schema: f.schema, selected: f.objects.get('ac:a2'), children: [task]};
  const read = (tool, args) => api(f.run.config, f.run.joppaWorker, tool, {workspace: f.run.workspace, ...args});
  const stages = await completionPolicy(config, root);
  const configFile = path.join(f.root, 'config.json'), inputFile = path.join(f.root, 'input.json');
  fs.writeFileSync(configFile, JSON.stringify(config));
  for (const [change, expected] of [[{}, true], [{assignee: 'worker'}, false], [{tags: []}, false],
    [{delivery: {state: 'other'}}, false], [{stage: 'ready'}, false]]) {
    task.document.data = {...normal, stage: 'review', tags: ['red'], delivery: {state: 'pending'}, ...change};
    const selected = await nextConfiguredItem(config, f.run.joppaWorker.tokenFile);
    assert.equal(selected.next?.address === 'ac:a2', expected);
    assert.equal(await inspect(input, read, [], stages, () => false, () => []), expected ? 'CONTINUE' : 'WAIT');
    fs.writeFileSync(inputFile, JSON.stringify(input));
    const result = spawnSync(process.execPath, [path.join(root, 'planning-joppa/child-filter.mjs'), 'active', inputFile, configFile], {encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), expected ? '' : task.address);
  }
});

test('Python fresh child guards preserve full evidence and refuse an assigned red pending child', () => {
  const script = `import sys
from pathlib import Path
root=Path(sys.argv[1])
sys.path[:0]=[str(root/'planning-joppa'),str(root/'planning-joppa/tests'),str(root/'planning')]
from test_configured_flow import Tracker
from flow_context import children
api=Tracker()
task=api.nodes['work:t']
task['document']['data'].update(stage='review',tags=['red'],delivery={'state':'pending'})
config={'workspace':'example'}
selected=api.nodes['criterion:a']
query={'kind':'work','data':{'stage':'review'},'except_pending_tag':'red'}
assert children(api,config,selected,query,excluding=True)==[]
assert len(children(api,config,selected,{'kind':'work'}))==1
task['document']['data']['assignee']='worker'
assert len(children(api,config,selected,query,excluding=True))==1
`;
  const result = spawnSync('python3', ['-c', script, root], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
