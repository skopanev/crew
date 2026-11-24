import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {plannerRows} from '../../planning-joppa/run-rows.mjs';
import {plannerConfig} from '../../planning-joppa/planner-config.mjs';
import {renderRunTable} from '../dashboard.mjs';
import {planner, watch} from '../test-support/config-reload.fixture.mjs';

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
    ['to_implement', 'ALREADY_IN_DEVELOP', 'ready'], ['to_decide', 'DISPUTED', 'red'],
    ['to_prepare', 'RECONCILED', 'ready'], ['done', 'PASS', 'ready']]) {
    const f = fixture(t, {stage, code}), row = f.row();
    assert.equal(row.status, 'READY');
    assert.equal(row.displayStatus, code);
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
    {command: {op: 'save_object', kind: 'work', id: 'other', data: {stage: 'to_decide'}}}]}});
  assert.equal(f.row().stage, 'PASS');
  assert.equal(f.row().outcomeTone, 'yellow');
  const uncertain = fixture(t, {stage: 'done', confirmed: false});
  uncertain.write('result.json', {status: 'blocked', needs_recovery: true, reason_code: 'REJECTED'});
  assert.equal(uncertain.row().stage, 'RECOVERY_REQUIRED');
  assert.equal(uncertain.row().status, 'HELD', 'The recovery guard retains its internal status');
  assert.equal(uncertain.row().displayStatus, 'REJECTED');
  assert.equal(uncertain.row().outcomeTone, 'red');
  assert.equal(fixture(t, {stage: 'to_decide', confirmed: false}).row().outcomeTone, 'yellow');
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
  assert.equal(f.row().displayStatus, 'REJECTED');
  assert.equal(f.row().outcomeTone, 'red');
});

test('table result colors show the actual verdict and retain the full reason when space permits', t => {
  const previous = process.env.COLUMNS;
  process.env.COLUMNS = '240';
  t.after(() => { if (previous === undefined) delete process.env.COLUMNS; else process.env.COLUMNS = previous; });
  const f = fixture(t, {stage: 'to_decide', code: 'FAIL'});
  const paint = (tone, value) => `<${tone}>${value}</${tone}>`;
  const display = row => ({...row, status: row.displayStatus});
  const lines = renderRunTable([display(f.row())], paint, 7, {statusWidth: Infinity});
  assert(lines[1].includes('<red>FAIL'));
  assert(lines[1].includes('→ to_decide · FAIL'));
  assert(!lines[1].includes('<ready>'));
  const done = fixture(t, {stage: 'to_implement', code: 'ALREADY_IN_DEVELOP'});
  assert(renderRunTable([display(done.row())], paint, 7, {statusWidth: Infinity})[1].includes('→ to_implement · ALREADY_IN_DEVELOP'));
  const mixed = renderRunTable([display(done.row()), {...display(f.row()), stage: 'PASS'}], paint, 7,
    {statusWidth: Infinity}).join('\n');
  assert(mixed.includes('→ to_implement · ALREADY_IN_DEVELOP'));
});

test('negative verdicts and confirmed decision stages stay red without a color map or with a green override', t => {
  for (const [stage, code] of [['done', 'FAIL'], ['to_task', 'DISPUTED'], ['to_prepare', 'REJECTED'],
    ['to_decide', 'RECONCILED']]) {
    const f = fixture(t, {stage, code});
    fs.writeFileSync(path.join(f.folder, 'launch.json'), JSON.stringify({address: 'criterion:a',
      attemptKey: JSON.stringify(['criterion:a', 3]), result: {code: 0}}));
    for (const scope of [null, {result_colors: {[code]: 'ready', [stage]: 'ready', default: 'ready'}}]) {
      const row = plannerRows(f.root, null, 30, scope)[0];
      assert.equal(row.displayStatus, code);
      assert.equal(row.outcomeTone, 'red');
      assert.equal(row.status, 'READY');
    }
  }
});

test('an active worker shows RUNNING while terminal rows without a reason retain their fallback', t => {
  const f = fixture(t, {code: 'FAIL'});
  fs.writeFileSync(path.join(f.folder, 'launch.json'), JSON.stringify({address: 'criterion:a',
    attemptKey: JSON.stringify(['criterion:a', 3]), dispatcherPid: process.pid}));
  assert.equal(f.row().displayStatus, 'RUNNING');
  assert.equal(f.row().outcomeTone, undefined);
  fs.unlinkSync(path.join(f.folder, 'launch.json'));
  for (const [result, status] of [[{status: 'published'}, 'READY'], [{status: 'blocked'}, 'BLOCKED']]) {
    f.write('result.json', result);
    assert.equal(f.row().displayStatus, status);
  }
});

test('the planning monitor shows complete long verdicts at wide and narrow table widths', async t => {
  const f = fixture(t, {stage: 'to_implement', code: 'ALREADY_IN_DEVELOP'});
  const file = path.join(f.root, 'config.json');
  fs.writeFileSync(file, JSON.stringify({workspace: 'sample', runs_folder: f.root, result_colors: colors}));
  for (const width of [240, 40]) {
    const run = watch(t, planner, ['--config', file, '--monitor'], {...process.env, COLUMNS: String(width), NO_COLOR: '1'});
    await run.until(output => /STATUS/.test(output) && /Ctrl\+C to stop/.test(output));
    const lines = run.output().split('\n'), header = lines.findIndex(line => line.includes('STATUS'));
    assert.match(lines[header + 1], /ALREADY_IN_DEVELOP/);
    assert.doesNotMatch(lines[header + 1], /ALREADY_IN_DEVE…|\bREADY\b/);
    assert.equal(await run.stop(), 130);
  }
});

test('planner config rejects unknown result colors', t => {
  const f = fixture(t), file = path.join(f.root, 'config.json');
  fs.writeFileSync(file, JSON.stringify({workspace: 'sample', runs_folder: f.root, result_colors: {FAIL: 'invalid'}}));
  assert.throws(() => plannerConfig(file), /result_colors/);
});

test('old active-work skips leave the panel but uncertain claims remain visible',t=>{
  const f=fixture(t,{code:'ACTIVE_TASK'});
  f.write('result.json',{status:'blocked',reason_code:'ACTIVE_TASK',claim_released:false});
  assert.equal(f.row(),undefined);
  f.write('result.json',{status:'blocked',reason_code:'ACTIVE_TASK',needs_recovery:true});
  assert.equal(f.row().status,'HELD');
});
