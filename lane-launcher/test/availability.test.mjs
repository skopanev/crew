import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {dolberAvailability} from '../availability.mjs';
import {packageFixture} from '../test-support/launcher-joppa.fixture.mjs';
import {watch} from '../test-support/config-reload.fixture.mjs';

test('Dolber counts schema Task kinds with native filters, tag exclusions and no admission reads', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dolber-available-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const config = {workspace: 'fixture', stateDir: root, joppa: {filter: {parent: 'project:one', depth: 5,
    data: {stage: 'working'}}, excludeTags: ['human']}};
  const calls = [];
  const read = async (tool, args) => {
    calls.push({tool, args});
    if (tool === 'joppa_tree') return {schema: {types: {work: {role: 'task'}, criterion: {role: 'ac'}}}};
    return {total: 8, groups: [{tags: null, count: 3}, {tags: ['human'], count: 5}]};
  };
  assert.equal((await dolberAvailability(config, null, read)).text, '3');
  assert.deepEqual(calls, [{tool: 'joppa_tree', args: {}}, {tool: 'joppa_objects', args: {
    workspace: 'fixture', kind: ['work'], parent: 'project:one', depth: 5, data: {stage: 'working'},
    assignee: '', group_by: ['tags']}}]);
  const runs = path.join(root, 'runs', 'one'); fs.mkdirSync(runs, {recursive: true});
  fs.writeFileSync(path.join(runs, 'launch.json'), JSON.stringify({ticket: 'work:a'}));
  assert.equal((await dolberAvailability(config, null, read)).text, '?');
  fs.writeFileSync(path.join(runs, 'launch.json'), JSON.stringify({claim: {assignee: 'held'}}));
  assert.equal((await dolberAvailability(config, null, read)).text, '3');
  assert.equal((await dolberAvailability(config, null, async () => { throw Error('Unavailable'); })).text, '?');
  assert.equal((await dolberAvailability({...config, joppa: {...config.joppa, priorities: ['highest']}}, null, read)).text, '?');
});

test('the read-only Dolber monitor refreshes available counts and stops without claims', async t => {
  const f = await packageFixture(t);
  const config = {id: 'fixture', workspace: 'fixture', stateDir: path.join(f.root, 'history'), repositories: [], limit: 1,
    intervalSeconds: 1, joppa: {...f.run.config.joppa, filter: {data: {stage: 'ready'}}}};
  const file = path.join(f.root, 'monitor-config.json'), runner = path.join(f.root, 'monitor.mjs');
  fs.writeFileSync(file, JSON.stringify(config));
  fs.writeFileSync(runner, `import fs from 'node:fs';
import {monitorDashboard} from ${JSON.stringify(new URL('../monitor.mjs', import.meta.url).href)};
await monitorDashboard(JSON.parse(fs.readFileSync(process.argv[2])), (_, value) => String(value));`);
  const run = watch(t, runner, [file], {...process.env, NO_COLOR: '1'});
  try {
    await run.until(output => /Running lanes 0 of 1 · available 2/.test(output));
    f.objects.get('task:t2').document.data.stage = 'done';
    await run.until(output => /Running lanes 0 of 1 · available 1/.test(output));
    assert.equal(f.calls.some(call => call.name === 'joppa_batch'), false);
    assert.ok(f.calls.filter(call => call.args.count).every(call => !call.args.cursor && !call.args.fields));
  } finally { assert.equal(await run.stop(), 0); }
});
