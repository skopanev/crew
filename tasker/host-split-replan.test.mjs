import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from './test-support/host-split.fixture.mjs';
import {checkRepair, repairPublication as publishRepair} from './repair-plan.mjs';
const repairPublication = options => publishRepair({stages:{task:'to_implement',ready:'to_task',review:'to_review'},...options});
import {verifiedSplitReplan} from './host-split-replan.mjs';

const checked = x => checkRepair({...x.options(), maxFiles: 8, maxLines: 300,
  forecast: () => { throw new Error('No second forecast'); }, checkPlan: () => { throw new Error('No new plan'); }});
const noArchive = x => {
  assert.equal(checked(x).ok, false);
  const result = repairPublication(x.options());
  assert.equal(result.approved,false);assert.equal(result.publication,undefined);
  assert.match(result.critique.host.invalid,/deliverables are not verified/);
};

test('confirmed host SPLIT retires for replanning without a completion claim or forecast', () => {
  const x = fixture();
  try {
    assert.ok(x.repair.split_replan);
    assert.equal(checked(x).ok, true);
    const result = repairPublication(x.options()).publication;
    assert.equal(result.outcome.reason_code, 'STALE');
    assert.deepEqual(result.operations.map(row => row.command.op), ['save_object', 'archive_object']);
    assert.deepEqual(result.operations[0].command.data, {stage: 'to_task'});
    assert.equal(result.operations[1].command.target, 'task:t');
    assert.equal(result.operations[1].command.revision, 12);
    const dry = repairPublication({...x.options(), dry: true}).publication;
    assert.deepEqual(dry.operations, []);
    x.draft.needs_code = false;
    noArchive(x);
  } finally { x.cleanup(); }
});

test('missing, stale, foreign, forged and changed host evidence keeps ordinary repair', () => {
  const cases = {
    missing: x => fs.unlinkSync(path.join(x.outer, 'launch.json')),
    stale: x => { x.input.selected.current_revision++; x.input.claim_revision++; },
    body: x => { x.input.selected.document.data.body += '\nNew work'; },
    title: x => { x.input.selected.document.data.title += ' changed'; },
    repository: x => { x.input.selected.document.data.repository = 'foreign'; },
    ac: x => { x.input.context.parent.document.data.body += ' changed'; },
    workspace: x => x.change('launch.json', run => { run.workspace = 'foreign'; }),
    foreign: x => x.change('launch.json', run => { run.task = 'task:other'; }),
    unconfirmed: x => x.change('launch.json', run => { run.result.blockConfirmed = false; }),
    forgedNote: x => { x.input.selected.annotations.comments['host-note'].actor = 'author'; },
    forgedFlag: x => { x.repair.split_replan = {run: x.id}; x.draft.split = true; },
    incoming: x => { x.input.context.incoming.push({address: 'task:dependent'}); },
    snapshot: x => { x.trees.repo.sha = 'a'.repeat(40); },
    dirty: x => fs.writeFileSync(path.join(x.repo, 'file.ts'), 'changed'),
    changedReceipt: x => x.change('launch.json', run => { run.createdAt += ' '; }),
    config: x => x.write(x.configFile, {id: 'foreign', workspace: 'fixture', stateDir: path.join(x.root, 'dispatcher')}),
    format: x => x.change('lane/2026-11-23_12-00-00-1234abcd/artifacts/plan-state.json', state => {
      state.plan.files = 1; state.plan.lines = 10; state.plan.gateSelection = {split: false}; }),
  };
  // JSONL needs its own writer. It must never be accepted as a single JSON object.
  cases.notSplit = x => {
    const file = path.join(x.lane, 'journal.jsonl');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"signal":"SPLIT"', '"signal":"OK"'));
  };
  for (const [name, change] of Object.entries(cases)) {
    const x = fixture();
    try { change(x); noArchive(x); } catch (error) { throw new Error(name, {cause: error}); }
    finally { x.cleanup(); }
  }
});

test('a note path cannot select a run and symlinks cannot supply proof files', () => {
  for (const relative of ['launch.json', 'lane/launch-claim.json',
    'lane/2026-11-23_12-00-00-1234abcd/artifacts/ticket.json',
    'lane/2026-11-23_12-00-00-1234abcd/artifacts/plan-state.json',
    'lane/2026-11-23_12-00-00-1234abcd/journal.jsonl']) {
    const x = fixture();
    try {
      const file = path.join(x.outer, relative), outside = path.join(x.root, 'outside');
      fs.renameSync(file, outside); fs.symlinkSync(outside, file);
      assert.equal(x.capture(), null); noArchive(x);
    } finally { x.cleanup(); }
  }
  const x = fixture();
  try {
    x.input.selected.annotations.comments['host-note'].text = x.input.selected.annotations.comments['host-note'].text
      .replace(x.id, '../../outside');
    assert.equal(x.capture(), null); noArchive(x);
  } finally { x.cleanup(); }
});

test('publication rechecks both exact independent approvals after the machine check', () => {
  const x = fixture();
  try {
    assert.equal(checked(x).ok, true);
    for (const mutate of [o => { o.reviews.pop(); }, o => { o.reviews[1].draft_digest = 'old'; },
      ...['gate', 'size', 'reporter_names', 'outside_files', 'already_in_develop'].map(key => o => { o.reviews[1].checks[key].ok = false; }),
      o => { o.reviews[1].checks.already_in_develop.evidence = ''; }]) {
      const options = x.options(); mutate(options);
      assert.equal(verifiedSplitReplan(options), false);
      assert.equal(repairPublication(options).approved,false);
    }
    // crew m_49e4475b: advice and an unsupported AC or Test check passed publication.jq. The host rechecks the Task checks only.
    const advised = x.options();
    advised.reviews[1] = {...advised.reviews[1], verdict: 'REWORK', findings: [{problem: 'p', advice: 'a'}],
      checks: {...advised.reviews[1].checks, ac_scope: {ok: false, evidence: 'e'}}};
    assert.equal(verifiedSplitReplan(advised), true);
    assert.notEqual(repairPublication(advised).publication.outcome.reason_code, 'DECISION_REQUIRED');
    const options = x.options(); delete options.reviews;
    assert.equal(repairPublication(options).approved,false);
    x.input.context.incoming.push({address: 'task:dependent'});
    assert.equal(repairPublication(x.options()).approved,false);
  } finally { x.cleanup(); }
});

test('a host gate SPLIT is eligible without treating an unavoidable long gate as a split', () => {
  const x = fixture();
  try {
    const reason = 'разбить: The planned gate runs the full suite or more than 200 Test files.';
    x.change('launch.json', run => { run.blockRequest.operations[1].command.text =
      x.input.selected.annotations.comments['host-note'].text = run.blockRequest.operations[1].command.text
        .replace('разбить: 485 lines, 7 files. Split the required work.', reason); });
    x.change('lane/2026-11-23_12-00-00-1234abcd/artifacts/plan-state.json', state => {
      state.reason = reason; state.plan.lines = 176; state.plan.files = 3; state.plan.gateSelection = {split: true}; });
    x.change('lane/2026-11-23_12-00-00-1234abcd/artifacts/plan-outcome.json', result => { result.reason = reason; });
    x.change('lane/2026-11-23_12-00-00-1234abcd/artifacts/origin.json', origin => { origin.message = reason; });
    x.repair.split_replan = x.capture(); assert.ok(x.repair.split_replan); assert.equal(checked(x).ok, true);
    x.change('lane/2026-11-23_12-00-00-1234abcd/artifacts/plan-state.json', state => {
      state.plan.gateSelection = {long: true, split: false, unavoidablePath: 'file.ts'}; });
    assert.equal(x.capture(), null); noArchive(x);
  } finally { x.cleanup(); }
});
