import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync, spawnSync} from 'node:child_process';
import {problems, proposal, reviews, policy, rejected, settings} from './control.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), keys = ['G', 'A', 'U', 'M', 'V', 'R'];
const config = JSON.parse(fs.readFileSync(path.join(here, 'config.example.json')));
const vars = Object.fromEntries(Object.entries(config.vars).map(([key, value]) => [key, String(value)]));
const cfg = settings(vars);
const acFields = () => ({stage: {values: ['to_decide', 'to_audit']}, returns: {}, tags: {}});
const source = {address: 'source:s', kind: 'source', document: {data: {body: 'The existing rule.'}}};
const input = () => ({selected: {address: 'ac:a', document: {data: {body: 'Baseline: repo@abc mod::symbol\nOld rule.', tags: ['keep'], owner: 'owner'}}},
  claim_revision: 4, references: {sources: [source]}, schema: {types: {ac: {field_max_length: 4096, fields: acFields()}, source: {root: true}}}});
const draft = () => ({outcome: 'READY', body: 'Baseline: repo@abc mod::symbol\nThe existing rule.', sources: ['source:s'],
  new_sources: [], summary: 'The full Sources prove the rule.', note: 'Use the exact Source sentence.',
  scores: Object.fromEntries(keys.map(key => [key, {score: 1, evidence: 'The exact rule.'}])),
  research: {searches: {joppa: 'existing rule', brain: 'existing rule', manuals: 'existing rule'},
    sources: [{address: 'source:s', revision: 1, quote: 'The existing rule.'}], files: [], unavailable: []}});
const packet = () => ({research_evidence: {sources: [source], files: []}});
const review = () => ({draft_digest: 'draft', context_digest: 'context', verdict: 'APPROVE',
  scores: Object.fromEntries(keys.map(key => [key, {agree: true, evidence: 'Exact evidence.'}])), findings: [], summary: 'Checked both contracts.'});

test('CONFLICT tags the owner, keeps the stage and returns, and quotes both captured Sources in the note', () => {
  const value = draft(); value.outcome = 'CONFLICT'; value.scores.A.score = 0;
  const other = {address: 'source:t', kind: 'source', document: {data: {body: 'The other rule.'}}};
  value.sources.push('source:t'); value.research.sources.push({address: 'source:t', revision: 2, quote: 'The other rule.'});
  value.gap = {owner: 'cto', question: 'Which rule wins?', a: 'Keep the existing rule.', b: 'Keep the other rule.', recommended: 'A'};
  value.conflict = [{source: 'source:s', quote: 'The existing rule.'}, {source: 'source:t', quote: 'The other rule.'}];
  const frozen = packet(); frozen.research_evidence.sources.push(other);
  assert.deepEqual(problems(value, input()), []);
  const result = proposal(input(), value, frozen, 'conflict', cfg), data = result.operations[0].command.data;
  assert.deepEqual(data.tags, ['keep', 'source-gap-cto']); assert.equal('stage' in data, false); assert.equal('returns' in data, false);
  assert.match(result.operations[1].command.text, /Conflict source:s: The existing rule\.\nConflict source:t: The other rule\./);
  assert.match(result.operations[1].command.text, /OPEN QUESTION \(cto, tag source-gap-cto\): Which rule wins\?\nA ★: /);
  assert.equal(result.outcome.reason_code, 'CONFLICT'); assert.equal(result.outcome.status, 'blocked');
  value.conflict[1].quote = 'An invented rule.';
  assert.throws(() => proposal(input(), value, frozen, 'conflict', cfg), /exact quote of each captured Source/);
  value.conflict[1] = {...value.conflict[0]};
  assert.ok(problems(value, input()).includes('CONFLICT needs two different captured Sources with exact quotes'));
  const ready = draft(); ready.conflict = value.conflict;
  assert.ok(problems(ready, input()).includes('Conflict proof is only for CONFLICT'));
});

test('a failed step keeps the stage, adds one to returns and asks the Owner at the limit', () => {
  const first = rejected(input(), 'Critic reason in full. '.repeat(300), 'run-a', cfg);
  assert.deepEqual(first.operations[0].command.data, {returns: 1});
  assert.equal(first.operations[0].command.revision, 4);
  assert.ok(first.operations[1].command.text.includes('Critic reason in full. '.repeat(300)));
  assert.equal(first.operations.length, 2); assert.equal(first.outcome.reason_code, 'REJECTED');
  const tired = input(); tired.selected.document.data.returns = 2;
  const stuck = rejected(tired, 'Reason.', 'run-b', cfg);
  assert.deepEqual(stuck.operations[0].command.data, {returns: 3, tags: ['keep', 'stuck']});
  assert.match(stuck.operations[2].command.text, /^OPEN QUESTION \(Owner, tag stuck\): .*3 times, and the limit is 3\.[^]*\nA ★: [^]*\nB: archive the AC/);
  const bare = input(); delete bare.schema.types.ac.fields.returns;
  assert.throws(() => rejected(bare, 'Reason.', 'run-c', cfg), /returns and tags fields/);
  const other = input(); other.schema.types.ac.fields.stage.values = ['to_decide'];
  assert.throws(() => proposal(other, draft(), packet(), 'run', cfg), /no stage to_audit/);
});

test('policy refuses failure_escalation, missing question tags and missing stage settings', () => {
  const env = {...vars, FLOW_PUBLICATION: JSON.stringify(config.publication)};
  assert.throws(() => policy(env, {...config, failure_escalation: {after: 3, data: {stage: 'to_decide'}}}), /failure_escalation/);
  assert.throws(() => policy(env, {...config, exclude_tags: ['source-gap-cto', 'source-gap-ceo']}), /exclude_tags/);
  for (const key of ['READY_STAGE', 'RETURNS_LIMIT', 'STUCK_TAG', 'CTO_TAG', 'CEO_TAG'])
    assert.throws(() => policy({...env, [key]: ''}, config), /Configure READY_STAGE/);
});

test('an invalid second draft or critic output is technical, and only a critic rejection publishes returns', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'decider-rejected-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const directory = path.join(root, 'run-x', 'artifacts'); fs.mkdirSync(directory, {recursive: true});
  fs.writeFileSync(path.join(directory, 'input.json'), JSON.stringify(input()));
  fs.writeFileSync(path.join(directory, 'draft.json'), JSON.stringify({...draft(), outcome: 'MAYBE'}));
  const call = (mode, extra = {}) => spawnSync(process.execPath, [path.join(here, 'control.mjs'), mode, directory],
    {encoding: 'utf8', env: {...process.env, ...vars, DRY_RUN: 'false', ...extra}});
  const check = call('check', {shape_retries: '1'});
  assert.equal(check.status, 0, check.stderr); assert.match(check.stdout, /<signal:FAILED>/);
  assert.match(fs.readFileSync(path.join(directory, 'failure.txt'), 'utf8'), /^INVALID: [^]*Unknown outcome/);
  assert.equal(fs.existsSync(path.join(directory, 'operations.json')), false);
  fs.writeFileSync(path.join(directory, 'draft.json'), JSON.stringify(draft()));
  fs.writeFileSync(path.join(directory, 'decider-assignment.json'), JSON.stringify(packet()));
  const digest = name => createHash('sha256').update(fs.readFileSync(path.join(directory, name + '.json'))).digest('hex');
  const critic = extra => ({...review(), draft_digest: digest('draft'), context_digest: digest('decider-assignment'), ...extra});
  const write = (codex, second) => { for (const [seat, value] of [['codex', codex], ['second', second]])
    fs.writeFileSync(path.join(directory, 'critic-' + seat + '.json'), JSON.stringify(value)); };
  const disagree = Object.fromEntries(keys.map(key => [key, {agree: key !== 'G', evidence: 'Exact evidence.'}]));
  for (const broken of [{draft_digest: 'old'}, {verdict: 'MAYBE'}, {scores: {}}, {findings: [{problem: ''}]},
    {verdict: 'REWORK', findings: [], summary: 'No change is required.'}, {verdict: 'APPROVE', scores: disagree}]) {
    write(critic({verdict: 'REWORK', findings: [{problem: 'Wrong.', advice: 'Fix.'}]}), critic(broken));
    const failed = call('review', {round: '2', REWORK_LIMIT: '1'});
    assert.equal(failed.status, 0, failed.stderr); assert.match(failed.stdout, /<signal:FAILED>/, JSON.stringify(broken));
    assert.match(fs.readFileSync(path.join(directory, 'failure.txt'), 'utf8'), /^INVALID_REVIEW:/);
  }
  write(critic({verdict: 'REWORK', findings: [{problem: 'The clause is wrong.', advice: 'Keep the rule.'}]}),
    critic({findings: [{problem: 'A text fix is needed.', advice: 'Use the Source sentence.'}]}));
  const refused = call('review', {round: '2', REWORK_LIMIT: '1'});
  assert.equal(refused.status, 0, refused.stderr); assert.match(refused.stdout, /<signal:REJECTED>/);
  const result = call('rejected'); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /<signal:RETURN>/);
  const operations = JSON.parse(fs.readFileSync(path.join(directory, 'operations.json'))).operations;
  assert.deepEqual(operations[0].command.data, {returns: 1}); assert.equal(operations[1].command.id, 'decider-rejected-run-x');
  assert.match(operations[1].command.text, /The clause is wrong\./);
  assert.equal(call('rejected', {DRY_RUN: 'true'}).status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'operations.json'))).operations, []);
});
