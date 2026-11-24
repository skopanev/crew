import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {plan, frozen, next, BATCH_LIMIT, PLAN_FILE} from './archive.mjs';

const script = fileURLToPath(new URL('./archive.mjs', import.meta.url));
const child = (kind, id, extra = {}) => ({address: kind + ':' + id, kind, current_revision: 4,
  document: {present: true, parent: 'ac:a', data: {title: kind + ' ' + id, ...extra}}});
const input = (tests = 2, tasks = 1) => ({
  selected: {address: 'ac:a', kind: 'ac', current_revision: 9, document: {present: true, parent: 'requirement:r',
    data: {title: 'Payout waits', body: 'A payout waits for the Travel Rule.'}}},
  claim_revision: 10,
  schema: {types: {ac: {role: 'ac'}, test: {role: 'test'}, task: {role: 'task'}, source: {role: 'document', source: true}, requirement: {role: 'requirement'}}},
  references: {sources: [{address: 'source:s', kind: 'source', historical: false,
    document: {present: true, data: {body: 'Every payout waits for the Travel Rule. Rule 7 is cancelled.'}}}]},
  children: [...Array.from({length: tests}, (_, index) => child('test', 't' + index)), ...Array.from({length: tasks}, (_, index) => child('task', 'k' + index))]});
// The Decider assignment of the same run: the Requirement, its sibling ACs and the research Sources.
const packet = () => ({requirement: {address: 'requirement:r', kind: 'requirement', historical: false, document: {present: true}},
  sibling_acs: [{address: 'ac:live', kind: 'ac', historical: false, current_revision: 3,
    document: {present: true, parent: 'requirement:r', data: {body: 'Each payout waits for the Travel Rule.'}}}],
  research_evidence: {sources: [{address: 'source:answer', kind: 'source', historical: false,
    document: {present: true, data: {body: 'The Owner cancels rule 9.'}}}], files: []}});
const duplicate = extra => ({outcome: 'DUPLICATE', duplicate_of: {address: 'ac:live', source: 'source:s',
  source_quote: 'Every payout waits for the Travel Rule.', sibling_quote: 'Each payout waits for the Travel Rule.', ...extra}});
const obsolete = extra => ({outcome: 'OBSOLETE', obsolete_by: {source: 'source:s', source_quote: 'Rule 7 is cancelled.', ...extra}});
const commands = value => value.batches.flat().map(row => row.command);
// The hook gives a fresh read of the own children. Without a change it equals the captured children.
const planned = (state, decision, value = packet(), fresh = state.children) => plan(state, decision, value, fresh);

test('DUPLICATE moves own Tests to the live AC, archives own Tasks, and archives the AC last with the sibling as reason', () => {
  const value = planned(input(), duplicate(), packet());
  assert.deepEqual(value.stop, []);
  const rows = commands(value);
  assert.deepEqual(rows.map(row => [row.op, row.target || row.kind + ':' + row.id]), [
    ['save_object', 'test:t0'], ['save_object', 'test:t1'], ['archive_object', 'task:k0'],
    ['save_object', 'ac:a'], ['note', 'ac:a'], ['archive_object', 'ac:a']]);
  assert.ok(rows.slice(0, 2).every(row => row.parent === 'ac:live' && row.revision === 4 && !row.data));
  assert.equal(rows[2].reason, 'Duplicate of ac:live.');
  assert.deepEqual(rows[3].data, {assignee: null}); assert.equal(rows[3].revision, 10);
  assert.deepEqual(rows[5].revision, {$ref: 'flow_release/saved_revision'});
  assert.equal(value.batches.at(-1).length, 3);
});

test('OBSOLETE archives every own child and then the AC, with the Source quote as reason', () => {
  const rows = commands(planned(input(), obsolete(), packet()));
  assert.deepEqual(rows.map(row => row.op), ['archive_object', 'archive_object', 'archive_object', 'save_object', 'note', 'archive_object']);
  assert.ok(rows.every(row => row.op === 'note' || row.reason === 'source:s cancels the rule: "Rule 7 is cancelled."'));
  assert.ok(rows.every(row => !row.parent));
});

test('the plan writes only the own subtree of the selected AC, deepest first, in batches of at most 100 operations', () => {
  const value = planned(input(150, 60), duplicate(), packet());
  assert.deepEqual(value.batches.map(batch => batch.length), [BATCH_LIMIT, BATCH_LIMIT, 10, 3]);
  const own = new Set(['ac:a', ...input(150, 60).children.map(node => node.address)]);
  assert.ok(commands(value).every(row => own.has(row.target || row.kind + ':' + row.id)));
  // A nested subtree: a Task under the Test t0, a Test under that Task, and an earlier archived Task with a live Test under it.
  const nested = input(); const under = (kind, id, parent, present = true) => ({...child(kind, id), document: {present, parent, data: {}}});
  const fresh = [...nested.children, under('task', 'n1', 'test:t0'), under('test', 'n2', 'task:n1'),
    under('task', 'gone', 'ac:a', false), under('test', 'n3', 'task:gone')];
  const rows = commands(plan(nested, duplicate(), packet(), fresh));
  assert.deepEqual(rows.map(row => [row.op, row.target || row.kind + ':' + row.id]), [
    ['save_object', 'test:n2'], ['save_object', 'test:n3'], ['archive_object', 'task:n1'],
    ['save_object', 'test:t0'], ['save_object', 'test:t1'], ['archive_object', 'task:k0'],
    ['save_object', 'ac:a'], ['note', 'ac:a'], ['archive_object', 'ac:a']]);
  assert.ok(rows.filter(row => row.parent).every(row => row.parent === 'ac:live'));
  for (const [node, pattern] of [[under('task', 'other', 'ac:other'), /parent chain of task:other is outside the selected AC or incomplete/],
    [under('test', 'orphan', 'task:missing'), /parent chain of test:orphan is outside/],
    [under('note', 'n', 'ac:a'), /Only Test and Task nodes/]]) {
    const state = input(); state.schema.types.note = {role: 'document'};
    assert.throws(() => plan(state, duplicate(), packet(), [...state.children, node]), pattern);
  }
  const loop = input();
  assert.throws(() => plan(loop, duplicate(), packet(), [...loop.children, under('task', 'x', 'task:y'), under('task', 'y', 'task:x')]),
    /parent chain of task:x is outside/);
});

test('a held own child stops only its own lanes, and the plan uses the fresh read after they finish', () => {
  const state = input(); state.children[2].document.data.assignee = 'lane-run-1';
  const value = planned(state, obsolete(), packet());
  assert.deepEqual(value, {stop: [{address: 'task:k0', assignee: 'lane-run-1'}], batches: [], reason: 'source:s cancels the rule: "Rule 7 is cancelled."'});
  const released = structuredClone(state.children); delete released[2].document.data.assignee; released[2].current_revision = 6;
  const rows = commands(plan(state, obsolete(), packet(), released));
  assert.deepEqual(rows.find(row => row.target === 'task:k0').revision, 6);
  assert.throws(() => plan(state, obsolete(), packet(), released.slice(0, 2)), /fresh read misses a captured child/);
  assert.throws(() => plan(state, obsolete(), packet()), /fresh read of the own children/);
});

test('a decision needs captured proof: a live sibling of the same Requirement or a cancelling Source quote', () => {
  for (const decision of [duplicate({address: 'ac:a'}), duplicate({address: 'ac:missing'}), duplicate({sibling_quote: 'Paraphrase.'}),
    duplicate({source: 'source:other'}), duplicate({source_quote: 'Invented rule.'}), obsolete({source_quote: 'Rule 8 is cancelled.'}),
    obsolete({source: 'ac:live'}), {outcome: 'MERGE'}]) {
    assert.throws(() => planned(input(), decision, packet()), undefined, JSON.stringify(decision));
  }
  for (const change of [value => { value.sibling_acs[0].document.parent = 'requirement:other'; },
    value => { value.sibling_acs[0].document.present = false; }, value => { value.sibling_acs[0].historical = true; },
    value => { value.sibling_acs[0].document.data.assignee = 'x'; }, value => { value.sibling_acs[0].kind = 'test'; },
    value => { value.requirement.address = 'requirement:other'; }, value => { delete value.sibling_acs; }]) {
    const value = packet(); change(value);
    assert.throws(() => planned(input(), duplicate(), value), /live AC/);
  }
  assert.equal(planned(input(), obsolete({source: 'source:answer', source_quote: 'The Owner cancels rule 9.'}), packet()).reason,
    'source:answer cancels the rule: "The Owner cancels rule 9."');
  const stale = input(); stale.references.sources[0].historical = true;
  assert.throws(() => planned(stale, obsolete(), packet()), /referenced Source/);
});

test('the frozen plan and the publication receipts give the next batch and stop on an unconfirmed or changed receipt', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decider-archive-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const first = frozen(dir, input(150, 0), duplicate(), packet(), input(150, 0).children);
  assert.deepEqual(frozen(dir, input(1, 0), obsolete(), packet(), input(1, 0).children), first);
  const receipt = (index, status, operations = first.batches[index]) => fs.writeFileSync(path.join(dir, 'archive-batch-00' + (index + 1) + '.json'),
    JSON.stringify({tool: 'joppa_batch', arguments: {workspace: 'w', operations, request_id: 'r'}, status}));
  assert.equal(next(dir).index, 0); assert.equal(next(dir).receipt, 'archive-batch-001.json');
  receipt(0, 'confirmed');
  assert.deepEqual([next(dir).index, next(dir).operations.length], [1, 50]);
  receipt(1, 'uncertain');
  assert.throws(() => next(dir), /batch 2 needs receipt recovery: uncertain/);
  receipt(1, 'confirmed', []);
  assert.throws(() => next(dir), /batch 2 receipt differs/);
  receipt(1, 'confirmed'); receipt(2, 'confirmed');
  assert.deepEqual(next(dir), {done: true, batches: 3});
});

test('the CLI freezes no plan while own lanes hold children, and reports its errors', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decider-archive-cli-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const state = input(); state.children[0].document.data.assignee = 'lane-run-2';
  fs.writeFileSync(path.join(dir, 'input.json'), JSON.stringify(input()));
  fs.writeFileSync(path.join(dir, 'draft.json'), JSON.stringify(duplicate()));
  fs.writeFileSync(path.join(dir, 'decider-assignment.json'), JSON.stringify(packet()));
  const absent = spawnSync(process.execPath, [script, 'plan', dir], {encoding: 'utf8'});
  assert.equal(absent.status, 1); assert.match(absent.stderr, /write archive-children\.json from a fresh read/);
  fs.writeFileSync(path.join(dir, 'archive-children.json'), JSON.stringify(state.children));
  const run = (...args) => spawnSync(process.execPath, [script, ...args], {encoding: 'utf8'});
  const held = run('plan', dir);
  assert.equal(held.status, 0, held.stderr); assert.equal(JSON.parse(held.stdout).stop[0].assignee, 'lane-run-2');
  assert.equal(fs.existsSync(path.join(dir, PLAN_FILE)), false);
  fs.writeFileSync(path.join(dir, 'archive-children.json'), JSON.stringify(input().children));
  assert.equal(JSON.parse(run('plan', dir).stdout).batches.length, 2);
  assert.equal(JSON.parse(run('next', dir).stdout).index, 0);
  const bad = run('merge', dir);
  assert.equal(bad.status, 1); assert.match(bad.stderr, /^decider-archive: Use plan or next/);
});
