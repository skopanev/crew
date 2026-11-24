import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {plannerRows} from '../../planning-joppa/run-rows.mjs';

const filter = fileURLToPath(new URL('../../writer/publication.jq', import.meta.url));
const writer = path.dirname(filter);
// The project config of the final Writer contract: AC stages, criterion letters, returns limit and stuck tag.
const contract = {READY_STAGE: 'to_task', RETURN_STAGE: 'to_decide', FINDING_CRITERIA: 'G A U M V', RETURNS_LIMIT: '3', STUCK_TAG: 'stuck'};
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-writer-coverage-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const draft = {tests: [{id: 't1', title: 'A valid input is accepted', data: {body: 'A bounded test.'}}]};
  const input = {selected: {address: 'criterion:a', kind: 'criterion', document: {data: {owner: 'owner'}}},
    claim_revision: 7, children: [{kind: 'work', address: 'work:t', current_revision: 3,
      document: {data: {stage: 'waiting'}}}],
    schema: {types: {criterion: {fields: {stage: {type: 'enum', values: ['author_tests', 'to_task', 'to_decide']},
      returns: {type: 'number'}, tags: {type: 'list'}}}}}};
  const review = {draft_digest: 'frozen', tests: [{id: 't1', score: '11111', reasons: []}],
    coverage: 'complete', missing: [], summary: 'The Test passes.'};
  const run = ({codex = review, second = review, gapTag = 'source-gap-owner', mode = 'create'} = {}) => {
    for (const [name, value] of Object.entries({draft, input, codex, second})) {
      fs.writeFileSync(path.join(root, name + '.json'), JSON.stringify(value));
    }
    const args = ['-nc', '--arg', 'digest', 'frozen', '--arg', 'test', 'check', '--arg', 'task', 'work',
      '--arg', 'waiting', 'waiting', '--arg', 'ready', 'ready', '--arg', 'mode', mode,
      '--arg', 'gap_tag', gapTag, '--arg', 'run', '2026-11-18_12-00-00-12345678'];
    for (const name of ['draft', 'input', 'codex', 'second']) args.push('--slurpfile', name, path.join(root, name + '.json'));
    return JSON.parse(execFileSync('jq', [...args, '-f', filter], {encoding: 'utf8'}));
  };
  // The host review of the same files. It adds the AC writes that the jq verdict leaves out.
  const host = ({codex = review, second = review, gapTag = 'source-gap-owner', mode = 'create'} = {}) => {
    const artifacts = path.join(root, 'host', 'artifacts');
    fs.mkdirSync(artifacts, {recursive: true});
    for (const [name, value] of Object.entries({draft, input})) fs.writeFileSync(path.join(artifacts, name + '.json'), JSON.stringify(value));
    const digest = createHash('sha256').update(fs.readFileSync(path.join(artifacts, 'draft.json'))).digest('hex');
    for (const [name, value] of Object.entries({codex, second})) {
      fs.writeFileSync(path.join(artifacts, 'critic-' + name + '.json'), JSON.stringify({...value, draft_digest: digest}));
    }
    return JSON.parse(execFileSync('node', [path.join(writer, 'control.mjs'), 'review', artifacts], {encoding: 'utf8', env: {...process.env,
      ...contract, MEDULLA_WORKFLOW_DIR: writer, TEST_KIND: 'check', TEST_OPERATION: mode, SOURCE_GAP_TAG: gapTag}}));
  };
  return {root, review, input, run, host};
}

test('an AC coverage gap returns only the selected item and a missing note without Test or Task changes', t => {
  const f = fixture(t);
  const gap = {...f.review, coverage: 'incomplete', coverage_gap_kind: 'ac',
    missing: ['The required failure outcome is unspecified.']};
  f.input.selected.document.data.tags = ['keep'];
  const failedDraft = {...gap, tests: [{id: 't1', score: '11011', reasons: ['The Source gives no outcome.']}]};
  for (const reviews of [{codex: gap}, {second: gap}, {codex: gap, second: gap}, {codex: failedDraft}]) {
    const verdict = f.run(reviews);
    assert.equal(verdict.decision_required, true);
    assert.deepEqual(verdict.missing, ['The required failure outcome is unspecified.']);
    assert.equal(verdict.operations, undefined);
    const value = f.host(reviews);
    assert.equal(value.approved, false);
    assert.equal(value.decision_required, true);
    assert.deepEqual(value.operations[0].command, {op: 'save_object', kind: 'criterion', id: 'a', revision: 7,
      data: {tags: ['keep', 'source-gap-owner']}, reason: 'Writer needs an owner decision. The AC keeps its stage.'});
    assert.equal(value.operations.length, 2);
    assert.equal(value.operations[1].command.op, 'note');
    assert.equal(value.operations[1].command.target, 'criterion:a');
    assert.match(value.operations[1].command.text, /Missing coverage:\nThe required failure outcome is unspecified/);
    assert.equal(value.outcome.reason_code, 'COVERAGE_INCOMPLETE');
    assert.equal(value.outcome.status, 'blocked');
  }
  f.input.selected.document.data.tags.push('source-gap-owner');
  assert.deepEqual(f.host({codex: gap}).operations.map(row => row.command.op), ['note']);
});

test('other failures, stale reviews and malformed coverage retain the rework path', t => {
  const f = fixture(t), gap = {...f.review, coverage: 'incomplete', coverage_gap_kind: 'ac', missing: ['A required behavior is not covered.']};
  for (const edit of [r => r.draft_digest = 'other',
    r => r.tests[0].id = 'other', r => r.missing = [], r => r.missing = 'not an array',
    r => r.coverage = 'complete', r => r.missing = ['']]) {
    const bad = structuredClone(gap); edit(bad);
    for (const reviews of [{codex: bad, second: gap}, {codex: gap, second: bad}]) {
      const value = f.run(reviews);
      assert.equal(value.approved, false);
      assert.equal(value.decision_required, undefined);
      assert.equal(value.operations, undefined);
      assert.ok(value.critique);
    }
  }
});

test('disabled decision routing and update mode keep the existing behavior', t => {
  const f = fixture(t), gap = {...f.review, coverage: 'incomplete', coverage_gap_kind: 'ac', missing: ['A required behavior is not covered.']};
  for (const extra of [{gapTag: ''}, {mode: 'update'}]) {
    const value = f.run({codex: gap, second: gap, ...extra});
    assert.equal(value.decision_required, undefined);
    assert.ok(value.critique);
  }
  const approved = f.run();
  assert.equal(approved.approved, true);
  assert.equal(approved.operations.length, 1);
  assert.equal(approved.operations[0].command.kind, 'check');
  assert.ok(approved.operations.every(({command}) => command.kind === 'check'));
});

test('the missing note keeps every missing behavior in full, and the outcome reason stays bounded', t => {
  const f = fixture(t), gap = {...f.review, coverage: 'incomplete', coverage_gap_kind: 'ac', missing: ['A'.repeat(6000), 'B'.repeat(6000)]};
  const value = f.host({codex: gap, second: gap});
  assert.ok(value.operations[1].command.text.endsWith('Missing coverage:\n' + 'A'.repeat(6000) + '\n' + 'B'.repeat(6000)));
  assert.ok(value.operations[1].command.id.length <= 120);
  assert.ok(value.outcome.reason.length <= 1000);
});

test('approved create and update write only Test text and preserve item and Task stages', t => {
  const f = fixture(t);
  f.input.selected.document.data.stage = 'author_tests';
  f.input.children.push({kind: 'check', address: 'check:t1', current_revision: 5,
    document: {data: {title: 'A valid input is accepted', body: 'Earlier text.'}}});
  for (const mode of ['create', 'update']) {
    const value = f.run({mode});
    assert.equal(value.approved, true);
    assert.equal(value.operations.length, 1);
    assert.equal(value.operations[0].command.kind, 'check');
    assert.equal(value.operations[0].command.data.stage, undefined);
    assert.equal(f.input.selected.document.data.stage, 'author_tests');
    assert.equal(f.input.children[0].document.data.stage, 'waiting');
  }
});

test('the dashboard shows the coverage reason code for the completed blocked run', t => {
  const f = fixture(t), gap = {...f.review, coverage: 'incomplete', coverage_gap_kind: 'ac', missing: ['An outcome is unspecified.']};
  const value = f.run({codex: gap});
  const folder = path.join(f.root, '2026-11-18_12-00-00-example'), artifacts = path.join(folder, 'artifacts');
  fs.mkdirSync(artifacts, {recursive: true});
  fs.writeFileSync(path.join(artifacts, 'input.json'), JSON.stringify({selected: f.input.selected}));
  fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify(value.outcome));
  const [row] = plannerRows(f.root);
  assert.equal(row.status, 'BLOCKED');
  assert.equal(row.stage, 'COVERAGE_INCOMPLETE');
});

test('draft_check sends an empty source gap directly to decision publication', t => {
  const f = fixture(t), artifacts = path.join(f.root, 'artifacts');
  fs.mkdirSync(artifacts);
  const workflow = fileURLToPath(new URL('../../writer/workflow.yaml', import.meta.url));
  const shell = fs.readFileSync(workflow, 'utf8').match(/^  draft_check:\n[\s\S]*?    shell: \|\n([\s\S]*?)^    on_signal:/m)[1]
    .replace(/^      /gm, '');
  fs.writeFileSync(path.join(artifacts, 'input.json'), JSON.stringify(f.input));
  for (const [draft, mode, gapTag, signal] of [
    [{tests: [], coverage: 'GAP. The source gives no refusal outcome.'}, 'create', 'needs_input', 'SOURCE_GAP'],
    [{tests: [], coverage: 'GAP. Missing source.'}, 'update', 'needs_input', 'REVISE'],
    [{tests: [], coverage: 'GAP. Missing source.'}, 'create', '', 'REVISE'],
    [{tests: [], coverage: 'Complete.'}, 'create', 'needs_input', 'REVISE'],
    [{tests: [], coverage: 'GAP. '}, 'create', 'needs_input', 'REVISE'],
  ]) {
    const file = path.join(artifacts, 'operations.json');
    fs.rmSync(file, {force: true});
    fs.writeFileSync(path.join(artifacts, 'draft.json'), JSON.stringify(draft));
    const output = execFileSync('bash', ['-c', shell], {encoding: 'utf8', env: {...process.env,
      MEDULLA_RUN_DIR: f.root, MEDULLA_WORKFLOW_DIR: path.dirname(workflow), TEST_KIND: 'check',
      TEST_OPERATION: mode, SOURCE_GAP_TAG: gapTag, REWORK_LIMIT: '1', round: '1',
      FLOW_PUBLICATION: JSON.stringify({file: 'operations.json'})}});
    assert.ok(output.includes(`<signal:${signal}>`), output);
    assert.equal(fs.existsSync(file), signal === 'SOURCE_GAP');
    if (signal === 'SOURCE_GAP') {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(value.outcome.reason_code, 'SOURCE_GAP');
      assert.equal(value.outcome.status, 'blocked');
      assert.deepEqual(value.operations[0].command.data, {tags: [gapTag]});
      assert.equal(value.operations[0].command.revision, f.input.claim_revision);
      assert.equal(value.operations.length, 2);
      assert.match(value.operations[1].command.text, /^GAP\. The source gives no refusal outcome/);
    }
  }
});
