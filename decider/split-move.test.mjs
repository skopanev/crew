import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {problems, proposal, policy, settings} from './control.mjs';
import {STRUCTURE} from './split-move.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), keys = ['G', 'A', 'U', 'M', 'V', 'R'];
const config = JSON.parse(fs.readFileSync(path.join(here, 'config.example.json')));
const vars = Object.fromEntries(Object.entries(config.vars).map(([key, value]) => [key, String(value)]));
const cfg = settings(vars);
const source = {address: 'source:s', kind: 'source', document: {data: {body: 'The existing rule.'}}};
const input = () => ({selected: {address: 'ac:a', kind: 'ac', current_revision: 6, document: {parent: 'requirement:r',
  data: {body: 'Old rule.', tags: ['keep'], owner: 'owner', consumer: 'consumer:c', sources: ['source:s']}}},
  claim_revision: 4, references: {sources: [source]}, schema: {types: {
    ac: {fields: {stage: {values: ['to_decide', 'to_audit']}, returns: {}, tags: {}}},
    requirement: {parents: ['capability', 'tech']}, source: {root: true},
    test: {role: 'test', title_max_length: 400, fields: {case: {values: ['nominal', 'boundary', 'off_nominal']}}}}}});
const packet = () => ({requirement: {address: 'requirement:r', kind: 'requirement'}, research_evidence: {sources: [source], files: []}});
const part = n => ({title: 'Part ' + n, body: 'The rule of part ' + n + '.', sources: ['source:s'],
  tests: [{title: 'Part ' + n + ' holds', case: 'nominal'}, {title: 'Part ' + n + ' refuses', case: 'off_nominal'}]});
const draft = action => ({outcome: 'READY', body: 'The existing rule.', sources: ['source:s'], new_sources: [],
  summary: 'Split by behavior.', note: 'One behavior for each AC.', action,
  scores: Object.fromEntries(keys.map(key => [key, {score: 1, evidence: 'The exact rule.'}])),
  research: {searches: {joppa: 'rule', brain: 'rule', manuals: 'rule'},
    sources: [{address: 'source:s', revision: 1, quote: 'The existing rule.'}], files: [], unavailable: []}});
const ops = value => value.operations.map(row => row.command);

test('SPLIT keeps part 1 and all Tests on the AC and creates each new part with new Tests under the Requirement', () => {
  const value = draft({split: [part(2), part(3)]});
  assert.deepEqual(problems(value, input(), packet()), []);
  const result = proposal(input(), value, packet(), 'run-s', cfg), rows = ops(result);
  assert.deepEqual(result.operations.map(row => row.ref || row.command.op + ':' + (row.command.kind || '')), ['decider_part_2',
    'decider_part_2_test_1', 'decider_part_2_test_2', 'decider_part_3', 'decider_part_3_test_1', 'decider_part_3_test_2',
    'save_object:ac', 'note:', 'note:', 'note:']);
  const [second] = rows;
  assert.equal(second.parent, 'requirement:r'); assert.equal(second.revision, 0);
  assert.deepEqual(second.data, {title: 'Part 2', body: 'The rule of part 2.', sources: ['source:s'], stage: 'to_decide', returns: 0,
    consumer: 'consumer:c', owner: 'owner'});
  assert.deepEqual(rows[1].parent, {$ref: 'decider_part_2/address'}); assert.equal(rows[1].kind, 'test');
  assert.deepEqual(rows[1].data, {title: 'Part 2 holds', case: 'nominal', owner: 'owner'});
  const save = rows[6];
  assert.equal(save.id, 'a'); assert.equal('parent' in save, false);
  assert.equal(save.data.body, 'The existing rule.'); assert.equal(save.data.stage, 'to_audit'); assert.equal(save.data.returns, 0);
  assert.match(rows[7].text, /SPLIT: 3 parts\. Part 1 stays in ac:a with all its Tests\.\nSPLIT part 2: "Part 2"\nThe rule of part 2\./);
  assert.deepEqual(rows[8].target, {$ref: 'decider_part_2/address'}); assert.match(rows[8].text, /^Decider SPLIT part 2 of ac:a \(revision 6\)/);
  assert.equal(rows.some(row => row.kind === 'test' && row.revision !== 0), false, 'no existing Test changes');
});

test('more than 3 behaviors, bad parts and a SPLIT with MANUAL_CHECK are refused', () => {
  assert.ok(problems(draft({split: [part(2), part(3), part(4)]}), input(), packet())
    .includes('More than 3 behaviors: do not split. Return GAP with owner cto'));
  for (const [change, message] of [[row => { row.tests = []; }, /new Tests/], [row => { row.tests[0].case = 'odd'; }, /new Tests/],
    [row => { row.sources = ['source:invented']; }, /captured evidence/], [row => { row.body = 'The existing rule.'; }, /own behavior/],
    [row => { row.extra = 1; }, /title, body, sources and tests/]]) {
    const row = part(2); change(row);
    const issues = problems(draft({split: [row]}), input(), packet());
    assert.ok(issues.some(issue => message.test(issue)), JSON.stringify(issues));
    assert.throws(() => proposal(input(), draft({split: [row]}), packet(), 'bad', cfg));
  }
  assert.ok(problems(draft({split: []}), input(), packet()).includes('SPLIT needs 1 or 2 new parts'));
  assert.ok(problems(draft({other: true}), input(), packet()).includes('action holds only move and split'));
  const manual = draft({split: [part(2)]}); manual.outcome = 'MANUAL_CHECK';
  assert.ok(problems(manual, input(), packet()).includes('MOVE and SPLIT go with READY, GAP or CONFLICT'));
});

test('MOVE to an existing Requirement changes only the parent of the selected AC in the same run', () => {
  const value = draft({move: {to: 'requirement:x', reason: 'The rule belongs to the withdraw fee Requirement.'}});
  assert.deepEqual(problems(value, input(), packet()), []);
  const rows = ops(proposal(input(), value, packet(), 'run-m', cfg));
  assert.deepEqual(rows.map(row => row.op), ['save_object', 'note']);
  assert.equal(rows[0].parent, 'requirement:x'); assert.equal(rows[0].data.stage, 'to_audit');
  assert.match(rows[1].text, /MOVE: requirement:r -> requirement:x\. Reason: The rule belongs/);
  for (const to of ['requirement:r', 'capability:x', 7])
    assert.ok(problems(draft({move: {to, reason: 'Why.'}}), input(), packet()).includes('MOVE needs another requirement address'));
  assert.ok(problems(draft({move: {reason: 'Why.'}}), input(), packet()).includes('MOVE needs to or new, and a reason'));
});

test('MOVE to a new Requirement creates it first, and SPLIT parts go under that new Requirement', () => {
  const value = draft({move: {new: {parent: 'capability:c', title: 'Fees', body: 'Fee behavior and scope.'}, reason: 'No Requirement fits.'},
    split: [part(2)]});
  assert.deepEqual(problems(value, input(), packet()), []);
  const result = proposal(input(), value, packet(), 'run-n', cfg), rows = ops(result);
  assert.equal(result.operations[0].ref, 'decider_requirement');
  assert.deepEqual(rows[0], {op: 'save_object', kind: 'requirement', revision: 0, parent: 'capability:c',
    data: {title: 'Fees', body: 'Fee behavior and scope.', owner: 'owner'}, reason: 'Create the requirement that the Decider MOVE needs.'});
  assert.deepEqual(rows[1].parent, {$ref: 'decider_requirement/address'});
  const save = rows.find(row => row.op === 'save_object' && row.kind === 'ac' && row.id === 'a');
  assert.deepEqual(save.parent, {$ref: 'decider_requirement/address'});
  assert.ok(rows.indexOf(save) > rows.indexOf(rows[1]), 'creates come before the save of the selected AC');
  const wrong = draft({move: {new: {parent: 'domain:d', title: 'Fees', body: 'Scope.'}, reason: 'Why.'}});
  assert.ok(problems(wrong, input(), packet()).some(issue => /schema parent kind/.test(issue)));
});

test('policy needs the agreed structure permissions and the new part stage', () => {
  const env = {...vars, FLOW_PUBLICATION: JSON.stringify(config.publication)};
  assert.deepEqual(config.publication.structure, STRUCTURE); policy(env, config);
  const wider = {...config, publication: {...config.publication, structure: {...STRUCTURE, move: {...STRUCTURE.move, task: ['created']}}}};
  assert.throws(() => policy({...env, FLOW_PUBLICATION: JSON.stringify(wider.publication)}, wider), /SPLIT and MOVE/);
  assert.throws(() => policy({...env, NEW_STAGE: ''}, config), /NEW_STAGE/);
  assert.throws(() => policy(env, {...config, related: undefined}), /related\.parent/);
});
