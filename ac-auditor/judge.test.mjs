import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = new URL('.', import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), 'judge-'));
const input = join(tmp, 'input.json');
writeFileSync(input, JSON.stringify({ selected: { address: 'ac:abc', kind: 'ac', current_revision: 5,
  document: { data: { returns: 2, tags: ['wallet'] } } }, claim_revision: 5 }));
const finding = { criterion: 'G', ac_quote: 'x', source_quote: 'y', source: 'source:a', fix: 'z' };

function publish(judge, extra = {}) {
  const file = join(tmp, 'judge.json');
  writeFileSync(file, JSON.stringify(judge));
  const args = { run: 'r1', date: '2026-11-24', stages: 'true', dry: 'false', limit: '3', stuck_tag: 'stuck', pass_stage: 'to_prepare', fail_stage: 'to_decide', ...extra };
  const argv = ['-nc', ...Object.entries(args).flatMap(([k, v]) => ['--arg', k, v]),
    '--slurpfile', 'judge', file, '--slurpfile', 'input', input, '-f', join(dir, 'judge.jq')];
  return JSON.parse(execFileSync('jq', argv, { encoding: 'utf8' })).publication;
}

function shape(judge) {
  return JSON.parse(execFileSync('jq', ['-c', '-f', join(dir, 'judge-shape.jq')], { input: JSON.stringify(judge), encoding: 'utf8' }));
}

test('PASS moves the AC to to_prepare and resets returns', () => {
  const p = publish({ verdict: 'PASS', accepted: [], summary: 's' });
  assert.deepEqual(p.operations[0].command.data, { stage: 'to_prepare', returns: 0 });
  assert.equal(p.outcome.reason_code, 'PASS');
});

test('FAIL returns the AC to to_decide and adds 1', () => {
  const p = publish({ verdict: 'FAIL', accepted: [finding], summary: 's' }, { limit: '5' });
  assert.deepEqual(p.operations[0].command.data, { stage: 'to_decide', returns: 3 });
  assert.match(p.operations[1].command.text, /G: "x" breaks "y"/);
});

test('FAIL at the limit sets the tag stuck', () => {
  const p = publish({ verdict: 'FAIL', accepted: [finding], summary: 's' });
  assert.deepEqual(p.operations[0].command.data.tags, ['stuck', 'wallet']);
});

test('dry run publishes nothing', () => {
  assert.deepEqual(publish({ verdict: 'PASS', accepted: [], summary: 's' }, { dry: 'true' }).operations, []);
});

test('shape refuses a FAIL without a three-part finding', () => {
  assert.deepEqual(shape({ verdict: 'PASS', accepted: [] }), []);
  assert.ok(shape({ verdict: 'FAIL', accepted: [] }).length > 0);
  assert.ok(shape({ verdict: 'FAIL', accepted: [{ criterion: 'G', ac_quote: 'x' }] }).length > 0);
  assert.ok(shape({ verdict: 'MAYBE', accepted: [] }).length > 0);
});

test('the note keeps every accepted finding in full, the last one too', () => {
  const long = 'q'.repeat(900);
  const accepted = Array.from({ length: 12 }, (_, i) => ({ criterion: 'G', ac_quote: `ac${i} ${long}`,
    source_quote: `src${i} ${long}`, source: 'source:a', fix: `fix${i} ${long}` }));
  const note = publish({ verdict: 'FAIL', accepted, summary: 's' }, { limit: '9' }).operations[1].command.text;
  for (let i = 0; i < 12; i++) {
    assert.ok(note.includes(`ac${i} ${long}`) && note.includes(`src${i} ${long}`) && note.includes(`fix${i} ${long}`), `finding ${i}`);
  }
});

test('FAIL at the limit writes an Owner question with A and B', () => {
  const p = publish({ verdict: 'FAIL', accepted: [finding], summary: 's' });
  assert.match(p.operations[2].command.text, /OPEN QUESTION \(Owner, tag stuck\)/);
  assert.match(p.operations[2].command.text, /A ★/);
});

test('finder shape refuses a finding without three parts', () => {
  const check = (r) => JSON.parse(execFileSync('jq', ['-c', '-f', join(dir, 'finder-shape.jq')], { input: JSON.stringify(r), encoding: 'utf8' }));
  assert.deepEqual(check({ findings: [] }), []);
  assert.deepEqual(check({ findings: [finding] }), []);
  assert.ok(check({ findings: [{ criterion: 'G', ac_quote: 'x' }] }).length > 0);
  assert.ok(check({ summary: 'no list' }).length > 0);
});
