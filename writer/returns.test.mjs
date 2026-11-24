import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {acFindings, acOutcome, criteria} from './returns.mjs';
import {policy} from './control.mjs';
import {input} from './test-support/reconcile.fixture.mjs';

const state = () => {
  const value = input();
  value.selected.document.data.body = 'Given a payout.\nWhen the officer approves it,\nthen the payout goes to pending_submit.';
  value.references.sources.push({address: 'source:s1', kind: 'source', document: {data: {title: 'Payout rule', body: 'An approved payout waits for the Travel Rule.'}}});
  return value;
};
const letters = criteria('G A U M V R');
const finding = extra => ({criterion: 'U', ac_quote: 'then the payout goes to pending_submit.',
  source_quote: 'An approved payout waits for the Travel Rule.', source: 'source:s1', ...extra});
const reviewWith = (rows, digest = 'exact') => ({draft_digest: digest, ac_findings: rows});
const options = {readyStage: 'to_task', returnStage: 'to_decide', limit: '3', stuckTag: 'stuck', gapTag: 'source-gap-cto', run: 'run-1'};

test('a finding counts only with a configured letter, an exact AC quote and an exact quote of a referenced Source', () => {
  const value = state();
  assert.deepEqual(acFindings(value, [reviewWith([finding()]), reviewWith([finding()])], 'exact', letters), [finding()]);
  assert.equal(acFindings(value, [reviewWith([finding({ac_quote: 'When the officer approves it, then the payout'})])], 'exact', letters).length, 1);
  assert.deepEqual(acFindings(value, [reviewWith([finding()])], 'exact', ['G']), []);
  for (const extra of [{criterion: 'X'}, {criterion: undefined}, {ac_quote: 'the payout goes to submitted'}, {ac_quote: ''},
    {source_quote: 'A payout waits.'}, {source_quote: ''}, {source: 'source:unknown'}, {source: 'ac:a'}, {source: undefined}]) {
    assert.deepEqual(acFindings(value, [reviewWith([finding(extra)])], 'exact', letters), [], JSON.stringify(extra));
  }
  assert.deepEqual(acFindings(value, [reviewWith([finding()], 'old')], 'exact', letters), []);
  assert.deepEqual(acFindings(value, [{draft_digest: 'exact'}, null], 'exact', letters), []);
  const sibling = finding({source: 'ac:sibling', source_quote: 'The payout goes to submitted.'});
  assert.deepEqual(acFindings(value, [reviewWith([sibling])], 'exact', letters), []);
  value.context = {children: [{address: 'ac:sibling', kind: 'ac', document: {data: {body: 'Given a hold. The payout goes to submitted.'}}}]};
  assert.deepEqual(acFindings(value, [reviewWith([sibling])], 'exact', letters), []);
});

test('READY resets returns, and a GAP adds the question tag without a stage or returns change', () => {
  const value = state(); value.selected.document.data.returns = 2;
  assert.deepEqual(acOutcome(value, 'ready', options).map(row => row.command.data), [{stage: 'to_task', returns: 0}]);
  const gap = acOutcome(value, 'gap', {...options, reason: 'Missing coverage:\nThe refusal outcome.'});
  assert.deepEqual(gap.map(row => row.command.op), ['save_object', 'note']);
  assert.deepEqual(gap[0].command.data, {tags: ['keep', 'source-gap-cto']});
  value.selected.document.data.tags.push('source-gap-cto');
  assert.deepEqual(acOutcome(value, 'gap', {...options, reason: 'm'}).map(row => row.command.op), ['note']);
});

test('the configured stages must exist in the schema with the returns and tags fields', () => {
  assert.throws(() => acOutcome(state(), 'ready', {...options, readyStage: 'to_review'}), /has no stage to_review/);
  assert.throws(() => acOutcome(state(), 'defect', {...options, returnStage: 'to_nowhere', findings: [finding()]}), /has no stage to_nowhere/);
  const value = state(); delete value.schema.types.ac.fields.returns;
  assert.throws(() => acOutcome(value, 'failure', {...options, reason: 'r'}), /returns and tags fields/);
});

test('a failure keeps the stage and adds 1 to returns, and the limit adds stuck and an OPEN QUESTION with A and B', () => {
  const value = state();
  const reason = 'codex:\n' + Array.from({length: 40}, (_, index) => '- Test t' + index + ' score 01111: reason ' + index + ' ' + 'x'.repeat(80)).join('\n');
  const first = acOutcome(value, 'failure', {...options, reason});
  assert.deepEqual(first[0].command.data, {returns: 1});
  assert.equal(first[0].command.revision, 11);
  assert.equal(first.length, 2);
  assert.ok(first[1].command.text.endsWith(reason) && first[1].command.text.length > 3900);
  value.selected.document.data.returns = 2;
  const third = acOutcome(value, 'failure', {...options, reason: 'r'});
  assert.deepEqual(third[0].command.data, {returns: 3, tags: ['keep', 'stuck']});
  assert.equal(third[2].command.id, 'writer-stuck-run-1');
  assert.match(third[2].command.text, /^OPEN QUESTION \(Owner, tag stuck\): Writer failed on this AC 3 times in a row, and the limit is 3\./);
  assert.match(third[2].command.text, /\nA ★: fix the AC by the findings and run Writer again\.\nB: archive the AC\.\n/);
});

test('a defect goes to the return stage with returns + 1 and a note with every three-part finding in full', () => {
  const value = state(); value.selected.document.data.returns = 2;
  const operations = acOutcome(value, 'defect', {...options, findings: [finding()]});
  assert.deepEqual(operations[0].command.data, {stage: 'to_decide', returns: 3, tags: ['keep', 'stuck']});
  assert.equal(operations[1].command.id, 'writer-ac-defect-run-1');
  assert.match(operations[1].command.text, /- U: "then the payout goes to pending_submit\." breaks "An approved payout waits for the Travel Rule\." \(source:s1\)/);
  assert.match(operations[2].command.text, /^OPEN QUESTION \(Owner, tag stuck\):/);
  const long = Array.from({length: 12}, (_, index) => finding({criterion: 'GAUMVR'[index % 6], source_quote: 'An approved payout waits ' + 'y'.repeat(700) + index}));
  const text = acOutcome(state(), 'defect', {...options, findings: long})[1].command.text;
  for (const row of long) assert.ok(text.includes('"' + row.source_quote + '"'), row.source_quote.slice(-3));
  assert.ok(text.includes('- R: "then the payout goes to pending_submit." breaks "' + long[11].source_quote + '" (source:s1)'));
});

test('the example Writer config passes the policy, skips stuck and source-gap AC and has no failure escalation', () => {
  const file = new URL('./config.example.json', import.meta.url).pathname, config = JSON.parse(fs.readFileSync(file, 'utf8'));
  const env = {AUTHOR_MODEL: 'author', CRITIC_CODEX_MODEL: 'first', ...Object.fromEntries(Object.entries(config.vars).map(([key, value]) => [key, String(value)])),
    PLANNING_JOPPA_CONFIG: file, CREW_FLOW_STAGES: '/fixture/flow.py', FLOW_PUBLICATION: JSON.stringify(config.publication)};
  assert.doesNotThrow(() => policy(env));
  for (const tag of ['stuck', 'source-gap-owner']) assert.ok(config.exclude_tags.includes(tag), tag);
  assert.equal(config.failure_escalation, undefined);
  assert.throws(() => policy({...env, STUCK_TAG: 'other'}), /exclude_tags/);
  assert.throws(() => policy({...env, RETURNS_LIMIT: '0'}), /RETURNS_LIMIT/);
  assert.throws(() => policy({...env, STUCK_TAG: ''}), /STUCK_TAG/);
  assert.throws(() => policy({...env, RETURN_STAGE: env.READY_STAGE}), /distinct stages/);
  assert.throws(() => policy({...env, FINDING_CRITERIA: ' '}), /FINDING_CRITERIA/);
});
