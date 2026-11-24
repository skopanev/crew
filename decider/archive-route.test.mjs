import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync, spawnSync} from 'node:child_process';
import {problems} from './control.mjs';
// The digests that freeze gives to the critic step. The host stamps them on each critic output.
const frozenDigests = directory => Object.fromEntries([['draft_digest', 'draft'], ['context_digest', 'decider-assignment']].map(([key, name]) =>
  [key, fs.existsSync(path.join(directory, name + '.json')) ? createHash('sha256').update(fs.readFileSync(path.join(directory, name + '.json'))).digest('hex') : '']));

const here = path.dirname(fileURLToPath(import.meta.url)), keys = ['G', 'A', 'U', 'M', 'V', 'R'];
const vars = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(path.join(here, 'config.example.json'))).vars).map(([key, value]) => [key, String(value)]));
const workflow = fs.readFileSync(path.join(here, 'workflow.yaml'), 'utf8');
const shell = name => workflow.split('  ' + name + ':\n')[1].split('    shell: |\n')[1].split('    on_signal:')[0].replace(/^      /gm, '');

function fixture(outcome) {
  const source = {address: 'source:rule', kind: 'source', historical: false, current_revision: 4,
    document: {present: true, data: {body: 'The verified Source rule. Rule 7 is cancelled.'}}};
  const input = {selected: {address: 'ac:selected', kind: 'ac', current_revision: 5, document: {present: true, parent: 'requirement:r',
    data: {body: 'The selected rule.', sources: ['source:rule'], tags: ['wallet']}}}, claim_revision: 6,
    references: {sources: [source]},
    children: [{address: 'test:t1', kind: 'test', current_revision: 2, document: {present: true, parent: 'ac:selected', data: {title: 'T1'}}},
      {address: 'task:k1', kind: 'task', current_revision: 3, document: {present: true, parent: 'ac:selected', data: {stage: 'to_implement'}}}],
    schema: {types: {ac: {role: 'ac', fields: {stage: {values: ['to_decide', 'to_audit']}, returns: {}, tags: {}}},
      test: {role: 'test'}, task: {role: 'task'}, source: {role: 'document', root: true, source: true}}}};
  const packet = {requirement: {address: 'requirement:r', kind: 'requirement', historical: false, document: {present: true}},
    sibling_acs: [{address: 'ac:sibling', kind: 'ac', historical: false, current_revision: 7,
      document: {parent: 'requirement:r', present: true, data: {body: 'The sibling already covers the rule.'}}}],
    research_evidence: {sources: [], files: []}};
  const draft = {outcome, body: 'The selected rule.', sources: ['source:rule'], new_sources: [],
    scores: Object.fromEntries(keys.map(key => [key, {score: key === 'R' && outcome === 'DUPLICATE' ? 0 : 1, evidence: 'Captured evidence.'}])),
    summary: outcome + ' by captured evidence.', note: 'The AC goes to the archive.',
    research: {searches: {joppa: 'rule', brain: 'rule', manuals: 'rule'}, sources: [], files: [], unavailable: []},
    ...(outcome === 'DUPLICATE' ? {duplicate_of: {address: 'ac:sibling', source: 'source:rule', source_quote: 'The verified Source rule.',
      sibling_quote: 'The sibling already covers the rule.'}} : {obsolete_by: {source: 'source:rule', source_quote: 'Rule 7 is cancelled.'}})};
  return {input, packet, draft};
}

test('DUPLICATE and OBSOLETE need their own proof, keep the AC text and ask no question', () => {
  for (const outcome of ['DUPLICATE', 'OBSOLETE']) assert.deepEqual(problems(fixture(outcome).draft, fixture(outcome).input, fixture(outcome).packet), []);
  for (const [outcome, mutate] of [['OBSOLETE', f => { delete f.draft.obsolete_by; }], ['OBSOLETE', f => { f.draft.obsolete_by.source = 'source:unknown'; }],
    ['OBSOLETE', f => { f.draft.obsolete_by.extra = 'x'; }], ['OBSOLETE', f => { f.draft.body = 'A rewritten rule.'; }],
    ['OBSOLETE', f => { f.draft.gap = {owner: 'cto'}; }], ['OBSOLETE', f => { f.draft.duplicate_of = fixture('DUPLICATE').draft.duplicate_of; }],
    ['DUPLICATE', f => { f.draft.scores.R.score = 1; }], ['DUPLICATE', f => { f.draft.obsolete_by = fixture('OBSOLETE').draft.obsolete_by; }],
    ['DUPLICATE', f => { f.draft.duplicate_of.address = 'ac:unknown'; }], ['DUPLICATE', f => { f.draft.sources = []; }]]) {
    const f = fixture(outcome); mutate(f);
    assert.notDeepEqual(problems(f.draft, f.input, f.packet), [], outcome + ' ' + mutate);
  }
  const ready = fixture('OBSOLETE'); ready.draft.outcome = 'READY';
  assert.ok(problems(ready.draft, ready.input, ready.packet).includes('Obsolete proof is only for OBSOLETE'));
});

test('an approved DUPLICATE or OBSOLETE keeps a preview, freezes no plan and goes to the hook, and a dry run publishes nothing', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'decider-archive-route-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  for (const outcome of ['DUPLICATE', 'OBSOLETE']) for (const dry of ['false', 'true']) {
    const f = fixture(outcome), directory = path.join(root, outcome + dry, 'artifacts'); fs.mkdirSync(directory, {recursive: true});
    for (const [name, value] of [['input', f.input], ['draft', f.draft], ['decider-assignment', f.packet]]) {
      fs.writeFileSync(path.join(directory, name + '.json'), JSON.stringify(value));
    }
    const call = mode => spawnSync(process.execPath, [path.join(here, 'control.mjs'), mode, directory],
      {encoding: 'utf8', env: {...process.env, ...vars, ...frozenDigests(directory), DRY_RUN: dry, round: '1', REWORK_LIMIT: '1'}});
    assert.match(call('check').stdout, /<signal:CHECKED>/);
    const digest = name => createHash('sha256').update(fs.readFileSync(path.join(directory, name + '.json'))).digest('hex');
    const critic = {draft_digest: digest('draft'), context_digest: digest('decider-assignment'), verdict: 'APPROVE',
      scores: Object.fromEntries(keys.map(key => [key, {agree: true, evidence: 'Confirmed.'}])), findings: [], summary: 'Verified.'};
    for (const seat of ['codex', 'second']) fs.writeFileSync(path.join(directory, 'critic-' + seat + '.json'), JSON.stringify(critic));
    const reviewed = call('review'); assert.equal(reviewed.status, 0, reviewed.stderr);
    assert.equal(fs.existsSync(path.join(directory, 'archive-plan.json')), false);
    const plan = JSON.parse(fs.readFileSync(path.join(directory, 'would-publish.json'), 'utf8')).archive;
    assert.deepEqual(plan.batches.flat().map(row => row.command.op),
      [outcome === 'DUPLICATE' ? 'save_object' : 'archive_object', 'archive_object', 'save_object', 'note', 'archive_object']);
    if (dry === 'true') {
      assert.match(reviewed.stdout, /<signal:APPROVED>/);
      const published = JSON.parse(fs.readFileSync(path.join(directory, 'operations.json'), 'utf8'));
      assert.deepEqual(published.operations, []); assert.equal(published.outcome.reason_code, 'DRY_RUN');
    } else {
      assert.match(reviewed.stdout, /<signal:ARCHIVE>/);
      assert.equal(fs.existsSync(path.join(directory, 'operations.json')), false);
    }
  }
});

test('the archive node verifies the context and runs only the configured hook with the artifacts folder', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'decider-archive-node-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const artifacts = path.join(root, 'artifacts'); fs.mkdirSync(artifacts);
  const calls = path.join(root, 'calls'), python = path.join(root, 'python.sh'), hook = path.join(root, 'hook.sh');
  fs.writeFileSync(python, `#!/bin/sh\nprintf ' %s' "$(basename "$1")" "$2" >> ${JSON.stringify(calls)}\n`, {mode: 0o755});
  fs.writeFileSync(hook, `printf ' hook %s' "$1" >> ${JSON.stringify(calls)}; echo '<signal:READY>Archived</signal:READY>'\n`);
  const run = hookCommand => execFileSync('bash', ['-c', shell('archive')], {encoding: 'utf8', env: {...process.env, MEDULLA_RUN_DIR: root,
    MEDULLA_WORKFLOW_DIR: here, PLANNING_PYTHON: python, ARCHIVE_HOOK: hookCommand}});
  assert.match(workflow.split('  review_join:\n')[1].split('  rejected:\n')[0], /\n      ARCHIVE: archive\n/);
  assert.match(run(''), /<signal:FAILED>/);
  assert.match(fs.readFileSync(path.join(artifacts, 'failure.txt'), 'utf8'), /^Decider technical failure: ARCHIVE_HOOK is not configured/);
  fs.rmSync(path.join(artifacts, 'failure.txt'));
  assert.match(run('sh ' + hook), /<signal:READY>/);
  assert.equal(fs.readFileSync(calls, 'utf8'), ' context.py verify context.py verify hook ' + artifacts);
});
