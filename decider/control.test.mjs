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

test('model versions come from config while the critics retain distinct vendor seats', () => {
  const env = {...Object.fromEntries(Object.entries(config.vars).map(([key, value]) => [key, String(value)])),
    FLOW_PUBLICATION: JSON.stringify(config.publication), AUTHOR_MODEL: 'configured-author',
    CRITIC_CODEX_MODEL: 'configured-codex', CRITIC_SECOND_MODEL: 'configured-claude'};
  policy(env, config);
  for (const change of [{AUTHOR_MODEL: ''}, {CRITIC_SECOND_MODEL: env.AUTHOR_MODEL},
    {CRITIC_SECOND_MODEL: env.CRITIC_CODEX_MODEL}, {CRITIC_SECOND_HARNESS: 'codex'}]) assert.throws(() => policy({...env, ...change}, config));
});

test('AC bodies use the native 1024 default and an explicit schema override', () => {
  const base = input(), value = draft(), prefix = base.selected.document.data.body.split('\n')[0] + '\n';
  delete base.schema.types.ac.field_max_length;
  value.body = prefix + 'a'.repeat(1024 - prefix.length);
  assert.deepEqual(problems(value, base), []);
  value.body += 'a';
  assert.ok(problems(value, base).includes('AC body is empty or exceeds its schema limit'));
  base.schema.types.ac.field_max_length = 2048;
  assert.deepEqual(problems(value, base), []);
});

test('verified Source proposals have no private count limit', () => {
  const value = draft();
  value.new_sources = Array.from({length: 4}, (_, i) => ({id: 'new_' + i, title: 'Policy section',
    document_title: 'Policy', section: String(i), path: '/approved/policy.md', quote: 'Exact rule ' + i}));
  value.sources.push(...value.new_sources.map(item => item.id));
  assert.deepEqual(problems(value, input()), []);
  value.new_sources = {};
  assert.ok(problems(value, input()).includes('New Sources must be an array'));
});

test('READY and GAP construct only the selected AC fields and a decision note', () => {
  const ready = proposal(input(), draft(), packet(), 'run', cfg);
  assert.deepEqual(ready.operations.map(row => row.command.op), ['save_object', 'note']);
  assert.deepEqual(Object.keys(ready.operations[0].command.data).sort(), ['body', 'returns', 'sources', 'stage', 'tags']);
  assert.equal(ready.operations[0].command.data.stage, 'to_audit'); assert.equal(ready.operations[0].command.data.returns, 0);
  const gap = draft(); gap.outcome = 'GAP'; gap.scores.G.score = 0;
  gap.gap = {owner: 'ceo', question: 'Which visible outcome applies?', a: 'Use A.', b: 'Use B.', recommended: 'A'};
  const result = proposal(input(), gap, packet(), 'gap', cfg);
  assert.equal('stage' in result.operations[0].command.data, false); assert.equal('returns' in result.operations[0].command.data, false);
  assert.deepEqual(result.operations[0].command.data.tags, ['keep', 'source-gap-ceo']);
  assert.match(result.operations[1].command.text, /OPEN QUESTION \(ceo, tag source-gap-ceo\): Which visible outcome applies\?\nA ★: Use A\.\nB: Use B\./);
  assert.match(result.operations[1].command.text, /source:s@1/);
  gap.research.unavailable = [{route: 'brain', error: 'EIO'}];
  assert.throws(() => proposal(input(), gap, packet(), 'gap', cfg), /SEARCH_UNAVAILABLE/);
});

test('decision comments preserve long notes while score evidence retains its contract limit', () => {
  const value = draft(); value.note = 'A complete reason. '.repeat(400);
  assert.deepEqual(problems(value, input()), []);
  const result = proposal(input(), value, packet(), 'long-note', cfg);
  assert.ok(result.operations[1].command.text.includes(value.note));
  assert.ok(result.operations[1].command.text.length > 4000);
  value.scores.G.evidence = 'a'.repeat(1001);
  assert.ok(problems(value, input()).includes('G needs a score and evidence'));
  value.note = ' ';
  assert.ok(problems(value, input()).includes('Give a change note, including reasons for removed qualifiers'));
});

test('file Sources contain the host hash and exact Verbatim quote, use native refs, and reuse existing Sources', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'decider-source-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const file = path.join(root, 'policy.md'), quote = 'The exact Brain rule.'; fs.writeFileSync(file, quote);
  const value = draft(); value.new_sources = [{id: 'new_1', title: 'Policy section', document_title: 'Policy', section: '1', path: file, quote}];
  value.sources.push('new_1'); value.research.files = [{path: file, quote}];
  const frozen = packet(); frozen.research_evidence.files = [{path: file, route: 'brain', text: quote, sha256: createHash('sha256').update(quote).digest('hex')}];
  const result = proposal(input(), value, frozen, 'run', cfg), first = result.operations[0].command;
  assert.equal(first.kind, 'source'); assert.equal(first.parent, null); assert.equal(first.revision, 0);
  assert.match(first.data.body, /SHA256: [a-f0-9]{64}\n\n## Verbatim\n\nThe exact Brain rule\./);
  assert.deepEqual(result.operations[1].command.data.sources, ['source:s', {$ref: 'new_1/address'}]);
  assert.equal(result.operations.some(row => ['test', 'task'].includes(row.command.kind)), false);
  frozen.research_evidence.sources.push({address: 'source:reuse', document: {data: {body: quote}}});
  const reused = proposal(input(), value, frozen, 'run', cfg);
  assert.equal(reused.operations.length, 2); assert.deepEqual(reused.operations[0].command.data.sources, ['source:s', 'source:reuse']);
  value.new_sources[0].quote = 'An invented quote.';
  assert.throws(() => proposal(input(), value, frozen, 'run', cfg), /exact frozen file quote/);
});

test('arbitrary operations, unknown Sources, Baseline edits, wrong scores and stale reviews cannot publish', () => {
  for (const change of [value => { value.operations = []; }, value => { value.sources = ['source:invented']; },
    value => { value.body = 'No Baseline.'; }, value => { value.scores.G.score = 0; },
    value => { value.research.sources = {}; }, value => { value.research.files = null; }]) {
    const value = draft(); change(value); assert.ok(problems(value, input()).length > 0);
    assert.throws(() => proposal(input(), value, packet(), 'bad', cfg));
  }
  const local = draft(); local.new_sources = [{id: 'new_1'}]; local.body += ' See new_1.';
  assert.ok(problems(local, input()).includes('Keep local Source IDs out of prose'));
  assert.equal(reviews(draft(), review(), review(), 'draft', 'context'), true);
  assert.equal(reviews(draft(), review(), {...review(), draft_digest: 'old'}, 'draft', 'context'), false);
  assert.equal(reviews(draft(), review(), {...review(), context_digest: 'old'}, 'draft', 'context'), false);
  assert.equal(reviews(draft(), review(), {...review(), findings: [{problem: 'Wrong fix', advice: 'Exact correction'}]}, 'draft', 'context'), false);
});

test('the private config, both contracts, frozen prompts and readonly author route use the existing patterns', () => {
  const workflow = Bun.YAML.parse(fs.readFileSync(path.join(here, 'workflow.yaml'), 'utf8'));
  policy({...vars, FLOW_PUBLICATION: JSON.stringify(config.publication)}, config);
  assert.equal(config.selection.assignee, ''); assert.equal(config.selection.data.stage, 'to_decide');
  assert.equal(config.concurrency, 6); assert.equal(config.retry, 'always'); assert.equal(config.failure_escalation, undefined);
  assert.deepEqual(config.exclude_tags, ['source-gap-cto', 'source-gap-ceo', 'manual-check', 'stuck']);
  for (const [seat, signal] of [['review_join', 'REJECTED'], ['rejected', 'RETURN']])
    assert.equal(workflow.nodes[seat].on_signal[signal], signal === 'RETURN' ? 'publish' : 'rejected');
  assert.equal(workflow.nodes.draft_check.on_signal.REJECTED, undefined); assert.equal(workflow.nodes.draft_check.on_signal.FAILED, 'failed');
  for (const seat of ['author', 'critics']) for (const token of ['{{var:decider_contract}}', '{{var:audit_contract}}', '{{file:{{var:decider_assignment_path}}}}']) assert.ok(workflow.nodes[seat].prompt.includes(token));
  assert.ok(workflow.nodes.author.agent.args.includes('--tools=Read,Glob,Grep'));
  assert.ok(workflow.nodes.critics.inputs.shell.includes('../writer/control.mjs'));
  assert.match(workflow.nodes.prepare.shell, /FLOW_ASSIGNMENT_INLINE=false/);
  assert.match(workflow.nodes.publish.shell, /context.py.*verify/);
  assert.match(workflow.nodes.publish.shell, /CREW_FLOW_STAGES.*publish/);
});

test('technical search failure creates no product operations and never receives a gap tag', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'decider-failure-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.writeFileSync(path.join(root, 'input.json'), JSON.stringify(input()));
  fs.writeFileSync(path.join(root, 'draft.json'), JSON.stringify({outcome: 'SEARCH_UNAVAILABLE', summary: 'Brain read returned EIO.'}));
  const result = spawnSync(process.execPath, [path.join(here, 'control.mjs'), 'check', root], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /<signal:FAILED>/);
  assert.match(fs.readFileSync(path.join(root, 'failure.txt'), 'utf8'), /SEARCH_UNAVAILABLE/);
  assert.equal(fs.existsSync(path.join(root, 'operations.json')), false);
});

test('CLI publication note IDs are stable per run and distinct between runs for the same AC', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'decider-run-ids-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const ids = [];
  for (const run of ['run-one', 'run-two', 'run-one']) {
    const directory = path.join(root, run, 'artifacts'); fs.mkdirSync(directory, {recursive: true});
    for (const [name, value] of [['input', input()], ['draft', draft()], ['decider-assignment', packet()]]) {
      fs.writeFileSync(path.join(directory, name + '.json'), JSON.stringify(value));
    }
    const digest = name => createHash('sha256').update(fs.readFileSync(path.join(directory, name + '.json'))).digest('hex');
    const approved = {...review(), draft_digest: digest('draft'), context_digest: digest('decider-assignment')};
    for (const seat of ['codex', 'second']) fs.writeFileSync(path.join(directory, 'critic-' + seat + '.json'), JSON.stringify(approved));
    const result = spawnSync(process.execPath, [path.join(here, 'control.mjs'), 'review', directory],
      {encoding: 'utf8', env: {...process.env, ...vars, DRY_RUN: 'false', REWORK_LIMIT: '1'}});
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /<signal:APPROVED>/);
    const operations = JSON.parse(fs.readFileSync(path.join(directory, 'operations.json'))).operations;
    ids.push(operations.find(row => row.command.op === 'note').command.id);
  }
  assert.deepEqual(ids, ['decider-run-one', 'decider-run-two', 'decider-run-one']);
});

test('READY with an unavailable route reports the actual search error and preserves the draft', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'decider-unavailable-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const value = draft(); value.research.unavailable = [{route: 'brain', path: '/policy.pdf', error: 'pdftoppm missing on page 86'}];
  fs.writeFileSync(path.join(root, 'input.json'), JSON.stringify(input()));
  const original = JSON.stringify(value); fs.writeFileSync(path.join(root, 'draft.json'), original);
  const result = spawnSync(process.execPath, [path.join(here, 'control.mjs'), 'check', root], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /<signal:FAILED>/);
  const failure = fs.readFileSync(path.join(root, 'failure.txt'), 'utf8');
  assert.match(failure, /^SEARCH_UNAVAILABLE:/); assert.match(failure, /pdftoppm missing on page 86/);
  assert.ok(!failure.includes('READY')); assert.equal(fs.existsSync(path.join(root, 'operations.json')), false);
  assert.equal(fs.readFileSync(path.join(root, 'draft.json'), 'utf8'), original);
});

test('final rejection preserves every finding, quote, reason and correction from both critics', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'decider-rejection-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  for (const [name, value] of [['input', input()], ['draft', draft()], ['decider-assignment', packet()]]) {
    fs.writeFileSync(path.join(root, name + '.json'), JSON.stringify(value));
  }
  const digest = name => createHash('sha256').update(fs.readFileSync(path.join(root, name + '.json'))).digest('hex');
  const critics = Object.fromEntries(['codex', 'second'].map(seat => [seat, {...review(),
    draft_digest: digest('draft'), context_digest: digest('decider-assignment'),
    findings: [0, 1].map(i => ({problem: seat + ' quote "Exact disputed clause ' + i + '": wrong because ' + 'reason '.repeat(200),
      advice: seat + ' correction ' + i + ': keep the verified condition.'}))}]));
  for (const [seat, value] of Object.entries(critics)) fs.writeFileSync(path.join(root, 'critic-' + seat + '.json'), JSON.stringify(value));
  const result = spawnSync(process.execPath, [path.join(here, 'control.mjs'), 'review', root],
    {encoding: 'utf8', env: {...process.env, ...vars, DRY_RUN: 'false', round: '2', REWORK_LIMIT: '1'}});
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /<signal:REJECTED>/);
  const failure = fs.readFileSync(path.join(root, 'failure.txt'), 'utf8');
  assert.ok(failure.length > 4000); assert.deepEqual(JSON.parse(failure.slice(failure.indexOf('\n') + 1)), critics);
  assert.equal(fs.existsSync(path.join(root, 'operations.json')), false);
});
