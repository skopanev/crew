import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {contextAdmission} from '../../planning-joppa/context-admission.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-context-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const related = {limit: 10, parent: {kind: 'group'}, incoming: {kind: 'item', relation: 'follows'}};
  const config = {inputs: [{selection: {kind: 'group'}}, {selection: {kind: 'item'}, related}]};
  const file = path.join(root, 'config.json'); fs.writeFileSync(file, JSON.stringify(config));
  const objects = new Map(), calls = [];
  const object = (address, parent = 'group:one', present = true) => ({address, kind: address.split(':')[0], historical: false,
    current_revision: 1, document: {parent, present, data: {}}, relations: {}});
  for (const address of ['item:left', 'item:right']) objects.set(address, object(address));
  objects.set('item:other', object('item:other', 'group:two'));
  const links = new Map();
  const read = async (tool, args) => {
    calls.push({tool, args});
    if (args.address) return objects.get(args.address);
    const rows = links.get(args.relations_of) || [];
    const start = Number(args.cursor || 0), page = rows.slice(start, start + 1);
    return {items: page, ...(start + 1 < rows.length ? {next_cursor: String(start + 1)} : {})};
  };
  const run = (address = 'item:left', input = 1) => ({address, input, args: ['run.sh', '--config', file]});
  return {root, related, config, file, objects, object, calls, links, read, run};
}

test('startup reserves a configured parent before input.json and permits disjoint contexts', async t => {
  const f = fixture(t), skip = contextAdmission([f.run()]);
  const profile = {related: {parent: f.related.parent}};
  assert.equal(await skip({address: 'group:one'}, {}, f.read), true);
  assert.equal(await skip({address: 'item:right', parent: 'group:one'}, profile, f.read), true);
  assert.equal(await skip({address: 'item:other', parent: 'group:two'}, profile, f.read), false);
  assert.equal(await skip({address: 'group:two'}, {}, f.read), false);
});

test('unconfigured parents, Sources and ancestors do not reserve the project', async t => {
  const f = fixture(t);
  const config = {related: undefined, references: ['sources']};
  const skip = contextAdmission([{address: 'item:left', input: 0, config}]);
  assert.equal(await skip({address: 'group:one'}, {}, f.read), false);
  assert.equal(await skip({address: 'item:right', parent: 'group:one'}, config, f.read), false);
  assert.equal(await skip({address: 'item:left'}, config, f.read), true);
  assert.equal(f.calls.length, 0);
});

test('configured incoming consumers conflict in either launch order and queries paginate', async t => {
  const f = fixture(t), relation = 'follows';
  f.objects.get('item:right').relations[relation] = {edges: [{to: 'item:left'}]};
  const archived = f.object('item:archived', 'group:three', false);
  f.objects.set(archived.address, archived);
  f.links.set('item:left', [archived, f.objects.get('item:right')]);
  const active = contextAdmission([f.run()]);
  assert.equal(await active({address: 'item:right'}, {}, f.read), true);
  const reverse = contextAdmission([{address: 'item:right', config: {}}]);
  assert.equal(await reverse({address: 'item:left', parent: 'group:one'}, {related: f.related}, f.read), true);
  assert.equal(await active({address: 'item:archived'}, {}, f.read), false);
  assert.ok(f.calls.some(call => call.args.cursor === '1'));
  assert.ok(f.calls.filter(call => call.args.relations_of).every(call => call.args.relation === relation));
});

test('active profiles use their own config snapshot after input order changes', async t => {
  const f = fixture(t), current = {inputs: [f.config.inputs[1], f.config.inputs[0]]};
  const skip = contextAdmission([f.run()]);
  assert.equal(await skip({address: 'group:one'}, current.inputs[1], f.read), true);
  const withoutParent = contextAdmission([f.run('item:left', 0)]);
  assert.equal(await withoutParent({address: 'group:one'}, current.inputs[0], f.read), false);
});

test('legacy startup defers without a profile and resumes after captured input supplies it', async t => {
  const f = fixture(t), run = f.run(); delete run.input;
  await assert.rejects(contextAdmission([run])({address: 'item:other'}, {}, f.read), /profile is unavailable/);
  const folder = path.join(f.root, 'worker'); fs.mkdirSync(path.join(folder, 'artifacts'), {recursive: true});
  run.medullaRun = folder;
  fs.writeFileSync(path.join(folder, 'artifacts/input.json'), JSON.stringify({input: 1,
    selected: f.objects.get('item:left'), context: {parent: {address: 'group:one'}, incoming: []}}));
  assert.equal(await contextAdmission([run])({address: 'group:one'}, {}, f.read), true);
  assert.equal(await contextAdmission([run])({address: 'item:other'}, {}, f.read), false);
});

test('legacy inputs without an index retain only their captured parent and incoming consumers', async t => {
  const f = fixture(t), run = f.run(); delete run.input;
  const folder = path.join(f.root, 'legacy'); fs.mkdirSync(path.join(folder, 'artifacts'), {recursive: true});
  run.medullaRun = folder;
  const file = path.join(folder, 'artifacts/input.json');
  const selected = f.objects.get('item:left');
  fs.writeFileSync(file, JSON.stringify({selected, context: {parent: {address: 'group:one'},
    incoming: [f.objects.get('item:right')], children: [{address: 'item:other'}],
    references: {sources: [{address: 'source:shared'}]}}}));
  const skip = contextAdmission([run]);
  for (const address of ['group:one', 'item:right', 'item:left']) assert.equal(await skip({address}, {}, f.read), true);
  for (const address of ['group:two', 'item:other', 'source:shared']) assert.equal(await skip({address}, {}, f.read), false);
  assert.equal(f.calls.length, 0);
  fs.writeFileSync(file, JSON.stringify({selected}));
  assert.equal(await contextAdmission([run])({address: 'group:one'}, {}, f.read), false);
});

test('missing snapshots, changed identities and incoming read failures never become empty scopes', async t => {
  const f = fixture(t), candidate = {address: 'group:two'};
  const missing = {...f.run(), args: ['run.sh', '--config', path.join(f.root, 'missing')]};
  await assert.rejects(contextAdmission([missing])(candidate, {}, f.read), /snapshot is unavailable/);
  await assert.rejects(contextAdmission([f.run()])(candidate, {}, async () => { throw new Error('transport'); }), /transport/);
  const folder = path.join(f.root, 'worker'); fs.mkdirSync(path.join(folder, 'artifacts'), {recursive: true});
  fs.writeFileSync(path.join(folder, 'artifacts/input.json'), JSON.stringify({input: 1, selected: {address: 'item:foreign'}}));
  await assert.rejects(contextAdmission([{...f.run(), medullaRun: folder}])(candidate, {}, f.read), /identity differs/);
});
