import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {plannerRows} from '../../planning-joppa/run-rows.mjs';
import {plannerConfig} from '../../planning-joppa/planner-config.mjs';
import {renderRunTable} from '../dashboard.mjs';

const colors = {to_task: 'ready', to_prepare: 'ready', to_implement: 'ready', done: 'ready',
  to_decide: 'red', REJECTED: 'red', FAIL: 'red', default: 'yellow'};

function fixture(t, {stage, code = 'PASS', confirmed = true} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-outcome-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const folder = path.join(root, '2026-11-22_20-00-00-run1'), artifacts = path.join(folder, 'artifacts');
  fs.mkdirSync(artifacts, {recursive: true});
  const write = (name, value) => fs.writeFileSync(path.join(artifacts, name), JSON.stringify(value));
  write('input.json', {selected: {address: 'criterion:a', current_revision: 3, document: {data: {title: 'The condition'}}}});
  write('result.json', {status: 'published', reason_code: code, claim_released: true});
  const command = {op: 'save_object', kind: 'criterion', id: 'a', data: stage ? {stage} : {assignee: null}};
  write('publication.json', {status: confirmed ? 'confirmed' : 'uncertain', arguments: {operations: [{command}]}});
  return {root, folder, artifacts, write, row: () => plannerRows(root, null, 30, {result_colors: colors})[0]};
}

test('published rows show the recorded stage and reason, with configured result colors', t => {
  for (const [stage, code, tone] of [['to_prepare', 'PASS', 'ready'], ['to_task', 'PASS', 'ready'],
    ['to_implement', 'ALREADY_IN_DEVELOP', 'ready'], ['to_decide', 'DISPUTED', 'red'], ['done', 'PASS', 'ready']]) {
    const f = fixture(t, {stage, code}), row = f.row();
    assert.equal(row.status, 'READY');
    assert.equal(row.stage, `→ ${stage} · ${code}`);
    assert.equal(row.outcomeTone, tone);
  }
});

test('a publication without a stage write stays yellow, while FAIL overrides a forward stage', t => {
  const f = fixture(t);
  assert.equal(f.row().stage, 'PASS');
  assert.equal(f.row().outcomeTone, 'yellow');
  const failed = fixture(t, {stage: 'to_task', code: 'FAIL'});
  assert.equal(failed.row().outcomeTone, 'red');
});

test('foreign and unconfirmed saves never become the selected node stage', t => {
  const f = fixture(t);
  f.write('publication.json', {status: 'confirmed', arguments: {operations: [
    {command: {op: 'save_object', kind: 'work', id: 'other', data: {stage: 'done'}}}]}});
  assert.equal(f.row().stage, 'PASS');
  assert.equal(f.row().outcomeTone, 'yellow');
  const uncertain = fixture(t, {stage: 'done', confirmed: false});
  uncertain.write('result.json', {status: 'blocked', needs_recovery: true, reason_code: 'REJECTED'});
  assert.equal(uncertain.row().stage, 'RECOVERY_REQUIRED');
  assert.equal(uncertain.row().outcomeTone, 'yellow');
});

test('old rejected runs display REJECTED instead of their LIVE routing signal', t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.artifacts, 'publication.json'));
  f.write('result.json', {status: 'blocked', reason: 'critic: already implemented', claim_released: true});
  fs.writeFileSync(path.join(f.folder, 'journal.jsonl'), [
    {node: 'draft_check', next: 'rejected', signal: 'REJECTED'},
    {node: 'rejected', next: 'failed', signal: 'LIVE'},
    {node: 'failed', next: '__exit_fail__', signal: 'BLOCKED'},
  ].map(row => JSON.stringify(row)).join('\n'));
  assert.equal(f.row().stage, 'REJECTED');
  assert.equal(f.row().outcomeTone, 'red');
});

test('table result colors override READY green and retain the full reason when space permits', t => {
  const previous = process.env.COLUMNS;
  process.env.COLUMNS = '240';
  t.after(() => { if (previous === undefined) delete process.env.COLUMNS; else process.env.COLUMNS = previous; });
  const f = fixture(t, {stage: 'to_decide', code: 'FAIL'});
  const paint = (tone, value) => `<${tone}>${value}</${tone}>`;
  const lines = renderRunTable([f.row()], paint);
  assert(lines[1].includes('<red>READY'));
  assert(lines[1].includes('→ to_decide · FAIL'));
  assert(!lines[1].includes('<ready>'));
  const done = fixture(t, {stage: 'to_implement', code: 'ALREADY_IN_DEVELOP'});
  assert(renderRunTable([done.row()], paint)[1].includes('→ to_implement · ALREADY_IN_DEVELOP'));
  const mixed = renderRunTable([done.row(), {...f.row(), stage: 'PASS'}], paint).join('\n');
  assert(mixed.includes('→ to_implement · ALREADY_IN_DEVELOP'));
});

test('planner config rejects unknown result colors', t => {
  const f = fixture(t), file = path.join(f.root, 'config.json');
  fs.writeFileSync(file, JSON.stringify({workspace: 'sample', runs_folder: f.root, result_colors: {FAIL: 'invalid'}}));
  assert.throws(() => plannerConfig(file), /result_colors/);
});
