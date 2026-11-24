import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {problems, proposal, settings} from './control.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), keys = ['G', 'A', 'U', 'M', 'V', 'R'];
const vars = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(path.join(here, 'config.example.json'))).vars).map(([key, value]) => [key, String(value)]));
const cfg = settings(vars);
function fixture() {
  const source = {address: 'source:rule', kind: 'source', historical: false, current_revision: 4,
    document: {present: true, data: {body: '## Verbatim\nThe verified Source rule.'}}};
  const input = {selected: {address: 'ac:selected', kind: 'ac', document: {parent: 'requirement:r',
    data: {body: 'The selected rule.', sources: ['source:rule'], tags: ['wallet']}}}, claim_revision: 5,
    references: {sources: [source]}, schema: {types: {ac: {fields: {stage: {values: ['to_decide', 'to_audit']}, returns: {}, tags: {}}}, source: {root: true}}}};
  const sibling = {address: 'ac:sibling', kind: 'ac', historical: false, current_revision: 7,
    document: {parent: 'requirement:r', present: true, data: {body: 'The sibling already covers the rule.'}}};
  const packet = {sibling_acs: [sibling], research_evidence: {sources: [], files: []}};
  const draft = {outcome: 'MANUAL_CHECK', body: input.selected.document.data.body, sources: ['source:rule'], new_sources: [],
    scores: Object.fromEntries(keys.map(key => [key, {score: key === 'R' ? 0 : 1, evidence: 'The captured sibling covers the verified rule.'}])),
    summary: 'The active sibling already covers this Source rule.', note: 'Keep the selected AC for manual duplicate review.',
    duplicate_of: {address: sibling.address, source: source.address, source_quote: 'The verified Source rule.', sibling_quote: sibling.document.data.body},
    research: {searches: {joppa: 'rule', brain: 'rule', manuals: 'rule'}, sources: [], files: [], unavailable: []}};
  return {input, packet, draft, source, sibling};
}

test('a verified duplicate changes only selected tags and stage and preserves body and Sources', () => {
  const f = fixture(), before = JSON.stringify(f.input);
  assert.equal('sibling_acs' in f.input, false); assert.deepEqual(problems(f.draft, f.input, f.packet), []);
  const value = proposal(f.input, f.draft, f.packet, 'duplicate-run', cfg);
  assert.deepEqual(value.operations[0].command.data, {tags: ['wallet', 'manual-check'], stage: 'to_decide'});
  assert.deepEqual(value.operations.map(row => [row.command.op, row.command.kind || row.command.target]), [['save_object', 'ac'], ['note', 'ac:selected']]);
  assert.equal(value.operations[0].command.id, 'selected'); assert.equal(value.operations[0].command.revision, 5);
  assert.ok(value.operations[1].command.text.includes(f.sibling.address));
  assert.ok(value.operations[1].command.text.includes(f.draft.duplicate_of.source_quote));
  assert.equal(value.outcome.reason_code, 'MANUAL_CHECK'); assert.equal(value.outcome.status, 'blocked');
  assert.equal(JSON.stringify(f.input), before);
});

test('unknown, inactive, foreign or historical siblings and unsupported duplicate edits cannot publish', () => {
  const mutations = [
    f => { f.draft.duplicate_of.address = 'ac:unknown'; }, f => { f.sibling.document.present = false; },
    f => { f.sibling.document.parent = 'requirement:foreign'; }, f => { f.sibling.historical = true; },
    f => { f.sibling.address = f.input.selected.address; f.draft.duplicate_of.address = f.sibling.address; },
    f => { f.draft.duplicate_of.sibling_quote = 'Invented sibling quote.'; }, f => { f.draft.scores.R.score = 1; },
    f => { f.draft.body = 'A rewritten rule.'; }, f => { f.draft.sources = []; },
    f => { f.draft.new_sources = [{id: 'new_1'}]; }, f => { f.draft.gap = {owner: 'cto'}; },
    f => { f.draft.operations = [{command: {op: 'archive_object'}}]; },
    f => { f.input.sibling_acs = f.packet.sibling_acs; delete f.packet.sibling_acs; },
  ];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f);
    assert.throws(() => proposal(f.input, f.draft, f.packet, 'refused', cfg));
  }
});

test('the duplicate Source rule needs full captured current evidence and creates no new Source', () => {
  for (const mutate of [f => { f.draft.duplicate_of.source_quote = 'Invented Source rule.'; },
    f => { f.input.references.sources = []; }, f => { f.source.document.present = false; },
    f => { f.source.historical = true; }]) {
    const f = fixture(); mutate(f);
    assert.throws(() => proposal(f.input, f.draft, f.packet, 'refused', cfg));
  }
  const f = fixture(); f.input.references.sources = []; f.input.selected.document.data.sources = []; f.draft.sources = [];
  f.draft.research.sources = [{address: f.source.address, revision: 4, quote: f.draft.duplicate_of.source_quote}];
  f.packet.research_evidence.sources = [f.source];
  assert.deepEqual(problems(f.draft, f.input, f.packet), []);
  const value = proposal(f.input, f.draft, f.packet, 'captured', cfg);
  assert.equal(value.operations.length, 2); assert.equal('sources' in value.operations[0].command.data, false);
});

test('the production CLI reads siblings from the full packet and requires both exact critic approvals', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'decider-duplicate-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  for (const approve of [false, true]) {
    const f = fixture(), directory = path.join(root, String(approve), 'artifacts'); fs.mkdirSync(directory, {recursive: true});
    for (const [name, value] of [['input', f.input], ['draft', f.draft], ['decider-assignment', f.packet]]) {
      fs.writeFileSync(path.join(directory, name + '.json'), JSON.stringify(value));
    }
    const call = mode => spawnSync(process.execPath, [path.join(here, 'control.mjs'), mode, directory],
      {encoding: 'utf8', env: {...process.env, ...vars, DRY_RUN: 'false', round: '1', REWORK_LIMIT: '1'}});
    const checked = call('check'); assert.equal(checked.status, 0, checked.stderr); assert.match(checked.stdout, /<signal:CHECKED>/);
    const digest = name => createHash('sha256').update(fs.readFileSync(path.join(directory, name + '.json'))).digest('hex');
    const critic = {draft_digest: digest('draft'), context_digest: digest('decider-assignment'), verdict: 'APPROVE',
      scores: Object.fromEntries(keys.map(key => [key, {agree: true, evidence: 'Confirmed the captured duplicate and unchanged selected AC.'}])), findings: [], summary: 'Verified the duplicate.'};
    fs.writeFileSync(path.join(directory, 'critic-codex.json'), JSON.stringify(critic));
    fs.writeFileSync(path.join(directory, 'critic-second.json'), JSON.stringify(approve ? critic : {...critic, verdict: 'REWORK',
      findings: [{problem: 'The sibling quote is shorter than the duplicate.', advice: 'Quote the full sibling rule.'}]}));
    const reviewed = call('review'); assert.equal(reviewed.status, 0, reviewed.stderr);
    assert.match(reviewed.stdout, approve ? /<signal:APPROVED>/ : /<signal:REVISE>/);
    assert.equal(fs.existsSync(path.join(directory, 'operations.json')), approve);
    if (approve) assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'operations.json'))).operations[0].command.data,
      {tags: ['wallet', 'manual-check'], stage: 'to_decide'});
  }
});
