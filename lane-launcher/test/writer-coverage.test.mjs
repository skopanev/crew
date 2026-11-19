import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {plannerRows} from '../../planning-joppa/run-rows.mjs';

const filter = fileURLToPath(new URL('../../writer/publication.jq', import.meta.url));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-writer-coverage-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const draft = {tests: [{id: 't1', title: 'A valid input is accepted', data: {body: 'A bounded test.'}}]};
  const input = {selected: {address: 'criterion:a', kind: 'criterion', document: {data: {owner: 'owner'}}},
    claim_revision: 7, children: [{kind: 'work', address: 'work:t', current_revision: 3,
      document: {data: {stage: 'waiting'}}}]};
  const review = {draft_digest: 'frozen', tests: [{id: 't1', score: '11111', reasons: []}],
    coverage: 'complete', missing: [], summary: 'The Test passes.'};
  const run = ({codex = review, claude = review, decision = 'needs_input', mode = 'create'} = {}) => {
    for (const [name, value] of Object.entries({draft, input, codex, claude})) {
      fs.writeFileSync(path.join(root, name + '.json'), JSON.stringify(value));
    }
    const args = ['-nc', '--arg', 'digest', 'frozen', '--arg', 'test', 'check', '--arg', 'task', 'work',
      '--arg', 'waiting', 'waiting', '--arg', 'ready', 'ready', '--arg', 'mode', mode,
      '--arg', 'decision', decision, '--arg', 'run', '2026-11-18_12-00-00-12345678'];
    for (const name of ['draft', 'input', 'codex', 'claude']) args.push('--slurpfile', name, path.join(root, name + '.json'));
    return JSON.parse(execFileSync('jq', [...args, '-f', filter], {encoding: 'utf8'}));
  };
  return {root, review, input, run};
}

test('coverage alone returns only the selected item and a missing note without Test or Task changes', t => {
  const f = fixture(t);
  const gap = {...f.review, coverage: 'incomplete', missing: ['The required failure outcome is unspecified.']};
  for (const reviews of [{codex: gap}, {claude: gap}, {codex: gap, claude: gap}]) {
    const value = f.run(reviews);
    assert.equal(value.approved, false);
    assert.equal(value.decision_required, true);
    assert.deepEqual(value.operations[0].command, {op: 'save_object', kind: 'criterion', id: 'a', revision: 7,
      data: {stage: 'needs_input'}, reason: 'Return the item to its owner for missing acceptance coverage.'});
    assert.equal(value.operations.length, 2);
    assert.equal(value.operations[1].command.op, 'note');
    assert.equal(value.operations[1].command.target, 'criterion:a');
    assert.match(value.operations[1].command.text, /Missing coverage:\nThe required failure outcome is unspecified/);
    assert.equal(value.outcome.reason_code, 'COVERAGE_INCOMPLETE');
    assert.equal(value.outcome.status, 'blocked');
  }
});

test('other failures, stale reviews and malformed coverage retain the rework path', t => {
  const f = fixture(t), gap = {...f.review, coverage: 'incomplete', missing: ['A required behavior is not covered.']};
  for (const edit of [r => r.tests[0].score = '11011', r => r.draft_digest = 'other',
    r => r.tests[0].id = 'other', r => r.missing = [], r => r.missing = 'not an array',
    r => r.coverage = 'complete', r => r.missing = ['']]) {
    const bad = structuredClone(gap); edit(bad);
    for (const reviews of [{codex: bad, claude: gap}, {codex: gap, claude: bad}]) {
      const value = f.run(reviews);
      assert.equal(value.approved, false);
      assert.equal(value.decision_required, undefined);
      assert.equal(value.operations, undefined);
      assert.ok(value.critique);
    }
  }
});

test('disabled decision routing and update mode keep the existing behavior', t => {
  const f = fixture(t), gap = {...f.review, coverage: 'incomplete', missing: ['A required behavior is not covered.']};
  for (const extra of [{decision: ''}, {mode: 'update'}]) {
    const value = f.run({codex: gap, claude: gap, ...extra});
    assert.equal(value.decision_required, undefined);
    assert.ok(value.critique);
  }
  const approved = f.run();
  assert.equal(approved.approved, true);
  assert.equal(approved.operations.length, 1);
  assert.equal(approved.operations[0].command.kind, 'check');
  assert.ok(approved.operations.every(({command}) => command.kind === 'check'));
});

test('the missing note stays bounded and points to the complete critic artifacts', t => {
  const f = fixture(t), gap = {...f.review, coverage: 'incomplete', missing: ['A'.repeat(6000)]};
  const value = f.run({codex: gap, claude: gap});
  assert.ok(value.operations[1].command.text.length <= 1000);
  assert.ok(value.operations[1].command.id.length <= 120);
  assert.match(value.operations[1].command.text, /critic-codex.json and artifacts\/critic-claude.json/);
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
  const f = fixture(t), gap = {...f.review, coverage: 'incomplete', missing: ['An outcome is unspecified.']};
  const value = f.run({codex: gap});
  const folder = path.join(f.root, '2026-11-18_12-00-00-example'), artifacts = path.join(folder, 'artifacts');
  fs.mkdirSync(artifacts, {recursive: true});
  fs.writeFileSync(path.join(artifacts, 'input.json'), JSON.stringify({selected: f.input.selected}));
  fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify(value.outcome));
  const [row] = plannerRows(f.root);
  assert.equal(row.status, 'BLOCKED');
  assert.equal(row.stage, 'COVERAGE_INCOMPLETE');
});
