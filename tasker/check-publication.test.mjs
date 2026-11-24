import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {check} from './check.mjs';
import {checkRepair} from './repair-plan.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const settings = JSON.parse(fs.readFileSync(path.join(here, "config.example.json"), "utf8")).vars;
const identity = {GIT_AUTHOR_NAME: 'lane', GIT_AUTHOR_EMAIL: 'lane@example.invalid',
  GIT_COMMITTER_NAME: 'lane', GIT_COMMITTER_EMAIL: 'lane@example.invalid', GIT_CONFIG_GLOBAL: '/dev/null'};
const ac = 'ac:sample0003';
const reporter = name => ({kind: 'test', address: 'test:sample0001',
  document: {data: {title: 't', body: `Given: x.\nRepository: example-backend. Reporter name: ${name}`}}});

// A fixed develop tree. The fixture forecast returns the given gate.
function run(draft, {children = [], gate = {long: false, split: false, detail: '3 Test file(s)'}} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tasker-check-'));
  try {
    for (const file of ['packages/a/src/b.ts', 'packages/a/src/b.itest.ts', 'packages/a/src/covered.itest.ts']) {
      fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true});
      fs.writeFileSync(path.join(root, file), 'export {};\n');
    }
    const git = (...args) => execFileSync('git', ['-C', root, ...args], {env: {...process.env, ...identity}, encoding: 'utf8'});
    git('init', '-q');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    const sha = git('rev-parse', 'HEAD').trim();
    const input = {selected: {address: ac}, children, schema: {types: {task: {field_max_length: 4096}}}};
    const result = check({input, trees: {'example-backend': {path: root, sha}}, draft: typeof draft === 'function' ? draft(sha, root) : draft,
      maxFiles: 8, maxLines: 300, forecast: () => gate});
    return result;
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
}

const body = files => `Criterion: ${ac}@28. "x"\nRepository: example-backend\nFiles (touched):\n${files.map(file => `- ${file}`).join('\n')}`;
const task = (files, extra = {}) => ({id: 't1', title: 'Do it', repository: 'example-backend',
  files, tests: [], depends_on: [], body: body(files.map(file => file.path)), ...extra});
const draft = tasks => ({verdict: 'OK', reason: 'Minimal change', tasks});

function review(draftValue, reviews, dry = 'false', owner = 'fixture-owner', extra = {}, config = settings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasker-review-'));
  try {
    const write = (name, value) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
    write('draft.json', draftValue);
    write('input.json', {selected: {address: ac, kind: 'ac', document: {data: {owner, returns: 2}}}, claim_revision: 31, children: [reporter('packages/a/src/b.itest.ts > existing case')], schema: {types: {ac: {role: "ac", fields: {stage: {values: [config.TASKER_IMPLEMENT_STAGE, config.TASKER_DONE_STAGE]}}}, task: {role: "task", fields: {stage: {values: ["to_implement"]}}}, test: {role: "test"}}}, ...extra});
    write('codex.json', reviews[0]);
    write('second.json', reviews[1]);
    return JSON.parse(execFileSync('jq', ['-nc', '--arg', 'digest', 'd1', '--arg', 'run', 'run-1', '--arg', 'stage', 'to_implement',
      '--arg', 'dry', dry, '--arg', 'done_stage', config.TASKER_DONE_STAGE, "--arg", "implement_stage", config.TASKER_IMPLEMENT_STAGE, "--argjson", "gap_tags", config.TASKER_GAP_TAGS, "--arg", "finding_criteria", config.FINDING_CRITERIA, '--slurpfile', 'draft', 'draft.json', '--slurpfile', 'input', 'input.json',
      '--slurpfile', 'codex', 'codex.json', '--slurpfile', 'second', 'second.json',
      '-f', path.join(here, 'publication.jq')], {cwd: dir, encoding: 'utf8'}));
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
}
const checks = ok => Object.fromEntries(['gate', 'size', 'reporter_names', 'outside_files', 'already_in_develop', 'ac_test_consistency', 'ac_scope']
  .map(key => [key, {ok: key === 'outside_files' ? ok : true, evidence: 'b.ts::run'}]));
const approve = {draft_digest: 'd1', verdict: 'APPROVE', checks: checks(true), findings: [], summary: 's'};

test('publishes the Tasks in to_implement only when both critics approve every check of this draft', () => {
  const okDraft = {verdict: 'OK', reason: 'r', tasks: [{id: 't1', title: 'Do it', body: 'B', repository: 'example-backend', depends_on: ['task:abc']}]};
  const result = review(okDraft, [approve, approve]);
  assert.equal(result.approved, true);
  assert.deepEqual(result.publication.operations[0].command, {op: 'save_object', kind: 'ac', id: 'sample0003', revision: 31,
    data: {stage: 'to_implement', returns: 0}, reason: 'tasker: the AC goes to to_implement.'});
  assert.deepEqual(result.publication.operations[1].command, {op: 'save_object', kind: 'task', revision: 0, parent: ac,
    reason: 'Publish a Task that both independent critics approved.', data: {title: 'Do it', body: 'B', repository: 'example-backend', stage: 'to_implement', owner: 'fixture-owner'},
    relations: {depends_on: {edges: [{to: 'task:abc'}]}}});
  const configured = review(okDraft, [approve, approve], "false", "fixture-owner", {}, {...settings, TASKER_IMPLEMENT_STAGE: "ready-next"});
  assert.deepEqual(configured.publication.operations[0].command.data, {stage: "ready-next", returns: 0});
  const native = {types: {ac: {role: "ac", fields: {stage: {values: [settings.TASKER_IMPLEMENT_STAGE]}}}, work: {role: "task", fields: {stage: {values: ["to_implement"]}}}}};
  const aliased = review({...okDraft, tasks: [{...okDraft.tasks[0], depends_on: ["work:abc"]}]}, [approve, approve], "false", "fixture-owner", {schema: native});
  assert.equal(aliased.publication.operations[1].command.kind, "work");
  assert.deepEqual(aliased.publication.operations[1].command.relations.depends_on.edges, [{to: "work:abc"}]);
  assert.throws(() => review(okDraft, [approve, approve], "false", "fixture-owner", {schema: native}, {...settings, TASKER_IMPLEMENT_STAGE: "missing"}), /absent from the schema/);
  okDraft.tasks[0].owner = 'draft-owner';
  assert.equal(review(okDraft, [approve, approve], 'false', 'other-ac-owner').publication.operations[1].command.data.owner, 'other-ac-owner');
  assert.throws(() => review(okDraft, [approve, approve], 'false', null), /Parent AC owner is missing/);
  const rework = {...approve, verdict: 'REWORK', checks: checks(false), findings: [{problem: 'p', advice: 'a'}]};
  const refused = review(okDraft, [approve, rework]);
  assert.equal(refused.approved, false);
  assert.deepEqual(refused.critique.second.failing, [{check: 'outside_files', evidence: 'b.ts::run'}]);
  assert.match(review(okDraft, [approve, {...approve, draft_digest: 'old'}]).critique.second.invalid, /another draft/);
  assert.match(review(okDraft, [approve, {...approve, checks: {gate: approve.checks.gate}}]).critique.second.invalid, /output contract/);
});

test('crew m_49e4475b: an AC or Test check blocks only with a supported finding, a Task check always blocks', () => {
  const okDraft = {verdict: 'OK', reason: 'r', tasks: [{id: 't1', title: 'Do it', body: 'B', repository: 'example-backend', depends_on: []}]};
  const test = {kind: 'test', address: 'test:t', document: {data: {title: 'T', body: 'Expected result'}}};
  const input = {selected: {address: ac, kind: 'ac', document: {data: {owner: 'o', body: 'Required outcome'}}}, claim_revision: 31, children: [test],
    references: {sources: [{address: 'source:s', document: {data: {body: 'Approved rule'}}}]},
    schema: {types: {ac: {role: 'ac', fields: {stage: {values: [settings.TASKER_IMPLEMENT_STAGE]}}}, task: {role: 'task', fields: {stage: {values: ['to_implement']}}}, test: {role: 'test'}}}};
  const failed = (check, extra = {}) => ({...approve, verdict: 'REWORK', checks: {...checks(true), [check]: {ok: false, evidence: 'e'}},
    findings: [{problem: 'p', advice: 'a'}], ...extra});
  const node = {target: 'test:t', quote: 'Expected result', reason_code: 'WRONG_EXPECTED'};
  const acFinding = {criterion: 'A', ac_quote: 'Required outcome', source_quote: 'Approved rule', source: 'source:s', reason_code: 'SCOPE'};
  const result = critic => review(okDraft, [approve, critic], 'false', 'o', input);
  for (const check of ['ac_test_consistency', 'ac_scope']) {
    // A freeform finding, an uncaptured Test, a wrong quote and an unlinked Source are advice: the draft publishes.
    for (const extra of [{}, {node_findings: [{...node, target: 'test:other'}]}, {node_findings: [{...node, quote: 'not captured'}]},
      {node_findings: [{...node, reason_code: 'GAP'}]}, {ac_findings: [{...acFinding, source: 'source:unlinked'}]}, {ac_findings: [{...acFinding, criterion: 'Z'}]}])
      assert.equal(result(failed(check, extra)).approved, true, check + ' ' + JSON.stringify(extra));
    for (const extra of [{node_findings: [node]}, {ac_findings: [acFinding]}]) {
      const blocked = result(failed(check, extra));
      assert.equal(blocked.approved, false);
      assert.deepEqual(blocked.critique.second.failing, [{check, evidence: 'e'}]);
    }
  }
  // A Task check blocks without a structured finding, also with an APPROVE verdict.
  for (const check of ['gate', 'size', 'reporter_names', 'outside_files', 'already_in_develop']) {
    assert.equal(result(failed(check)).approved, false, check);
    assert.equal(result({...failed(check), verdict: 'APPROVE', findings: []}).approved, false, check);
  }
  // A Task repair finds the AC, its Sources and its Tests in the related parent context.
  const repair = {selected: {address: 'task:r', kind: 'task', document: {data: {body: 'Criterion: ac:sample0003@1. Work'}}}, claim_revision: 4,
    context: {parent: input.selected, children: [test], references: input.references}, schema: input.schema};
  const repairResult = critic => review({verdict: 'STALE', reason: 'r', needs_code: true}, [approve, critic], 'false', 'o', repair);
  assert.equal(repairResult(failed('ac_scope')).approved, true);
  assert.equal(repairResult(failed('ac_scope', {node_findings: [node]})).approved, false);
  assert.equal(repairResult(failed('ac_scope', {ac_findings: [acFinding]})).approved, false);
  // A REWORK with every check true and only freeform findings is advice.
  assert.equal(result({...approve, verdict: 'REWORK', findings: [{problem: 'p', advice: 'a'}]}).approved, true);
  // The review contract and the digest stay strict.
  assert.equal(result({...failed('ac_scope'), draft_digest: 'old'}).approved, false);
  assert.equal(result({...approve, verdict: 'REWORK', findings: []}).approved, false);
});

test('publication orders prerequisites before reversed dependents and uses existing native refs', () => {
  const extract = {id: 'extract', title: 'Extract existing code', body: 'Keep behavior', repository: 'example-backend', depends_on: []};
  const feature = {id: 'feature', title: 'Implement the AC', body: 'Required behavior', repository: 'example-backend', depends_on: ['extract', 'task:existing']};
  const value = {verdict: 'OK', reason: 'The target module needs extraction first', tasks: [feature, extract]};
  const output = review(value, [approve, approve]);
  assert.equal(output.approved, true);
  const creates = output.publication.operations.filter(row => row.command.revision === 0);
  assert.deepEqual(creates.map(row => row.ref), ['task-extract', 'task-feature']);
  assert.deepEqual(creates[1].command.relations.depends_on.edges, [
    {to: {$ref: 'task-extract/address'}}, {to: 'task:existing'}]);
  const dry = review(value, [approve, approve], 'true');
  assert.deepEqual(dry.publication.operations, []);
  assert.deepEqual(dry.would_publish.operations, output.publication.operations);
  assert.equal(review(value, [approve, {...approve, draft_digest: 'old'}]).approved, false);
  assert.throws(() => review({...value, tasks: [{...extract, depends_on: ['unknown']}]}, [approve, approve]), /dependency does not name/);
  assert.throws(() => review({...value, tasks: [{...extract, depends_on: ['feature']}, feature]}, [approve, approve]), /dependencies contain a cycle/);
});

test('DONE moves the AC with develop and Test evidence, while dry run writes nothing and GAP asks a decision', () => {
  const done = review({verdict: 'DONE', reason: 'r', done_commit: 'abc1234'}, [approve, approve]);
  assert.deepEqual(done.publication.operations[0].command, {op: 'save_object', kind: 'ac', id: 'sample0003', revision: 31,
    data: {stage: settings.TASKER_DONE_STAGE, returns: 0}, reason: 'Develop already has this behavior at abc1234. Tests: test:sample0001. r'});
  assert.equal(done.publication.operations[1].command.op, 'note');
  assert.equal(done.publication.operations[1].command.text, done.publication.operations[0].command.reason);
  assert.equal(done.publication.outcome.reason_code, 'AC_DONE');
  const gap = review({verdict: 'GAP', reason: 'r', gap: 'A=0: split the AC'}, [approve, approve]);
  assert.equal(gap.approved, false);
  assert.match(gap.critique.host.invalid, /verified owner/);
  for (const owner of ['cto', 'ceo']) {
    const question = {owner, question: 'Which rule applies?', a: 'Use A.', b: 'Use B.', recommended: 'A'};
    const output = review({verdict: 'GAP', reason: 'r', gap: question}, [approve, approve]);
    assert.deepEqual(output.publication.operations[0].command.data, {tags: ['source-gap-' + owner]});
    assert.equal(output.publication.operations[1].command.text,
      `OPEN QUESTION\nOwner: ${owner}\nQuestion: ${question.question}\n★ A: ${question.a}\nB: ${question.b}\nRecommended: A\nReason: r`);
    const tags = review({verdict: "GAP", reason: "r", gap: question}, [approve, approve], "false", "fixture-owner", {}, {...settings, TASKER_GAP_TAGS: JSON.stringify({cto: "ask-tech", ceo: "ask-policy"})});
    assert.deepEqual(tags.publication.operations[0].command.data, {tags: [owner === "cto" ? "ask-tech" : "ask-policy"]});
  }
  const full = review({verdict: 'DONE', reason: 'я'.repeat(2000) + 'END', done_commit: 'abc1234'}, [approve, approve]);
  assert.equal(full.publication.operations[0].command.reason.length, 1000);
  assert.ok(full.publication.operations[1].command.text.endsWith('END'));
  assert.equal(done.publication.operations.length, 2);
  assert.equal(done.publication.operations.some(row => row.command.kind === 'task'), false);
  assert.deepEqual(review({verdict: 'DONE', reason: 'r', done_commit: 'abc1234'}, [approve, approve], 'true').publication.operations, []);
  assert.equal(review({verdict: 'DONE', reason: 'r', done_commit: 'abc1234'}, [approve, {...approve, draft_digest: 'old'}]).approved, false);
  const dry = review({verdict: 'CONFLICT', reason: 'r', gap: {owner: 'cto', question: 'A or B?', a: 'A.', b: 'B.', recommended: 'A'}}, [approve, approve], 'true');
  assert.deepEqual(dry.publication.operations, []);
  assert.match(dry.publication.outcome.reason, /^Dry run, nothing published\. Would be DECISION_REQUIRED:/);
  assert.equal(dry.would_publish.operations[1].command.op, 'note');
});

// Only supported business findings change the claimed AC stage and returns.
test('LIVE_TASK and unsupported refusals preserve the AC, while valid findings count returns', () => {
  const workflow = fs.readFileSync(path.join(here, 'workflow.yaml'), 'utf8');
  const active = workflow.slice(workflow.indexOf('      active="$('), workflow.indexOf('      bash "$MEDULLA_WORKFLOW_DIR/trees.sh" add'));
  const rejected = workflow.split('  rejected:\n')[1].split('    shell: |\n')[1].split('    on_signal:')[0];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tasker-routes-'));
  try {
    const artifacts = path.join(root, 'artifacts');
    fs.mkdirSync(artifacts);
    const output = path.join(artifacts, 'operations.json');
    for (const data of [{stage: 'in_progress'}, {stage: 'to_review'}, {stage: 'to_implement', assignee: 'crew-lane:r1'}]) {
      fs.writeFileSync(path.join(artifacts, 'input.json'), JSON.stringify({children: [{kind: 'task', address: 'task:active', document: {data}}]}));
      const message = execFileSync('sh', ['-c', active], {encoding: 'utf8', env: {...process.env, a: artifacts, file: 'operations.json'}});
      assert.match(message, /<signal:ACTIVE>/);
      const publication = JSON.parse(fs.readFileSync(output, 'utf8'));
      assert.deepEqual(publication.operations, []);
      assert.equal(publication.outcome.reason_code, 'LIVE_TASK');
      fs.unlinkSync(output);
    }
    const input = {selected: {kind: 'ac', address: 'ac:a', document: {data: {body: 'Required outcome', stage: 'to_task', returns: 1, tags: ['keep']}}},
      claim_revision: 9, schema: {types: {ac: {role: "ac", fields: {stage: {values: [settings.TASKER_RETURN_STAGE, settings.TASKER_TEST_RETURN_STAGE]}}}, task: {role: "task"}, spec: {role: "test"}}},
      children: [{address: 'spec:t', kind: 'spec', document: {data: {body: 'Expected result'}}}],
      references: {sources: [{address: 'source:s', document: {data: {body: 'Approved rule'}}}]}};
    const saveInput = () => fs.writeFileSync(path.join(artifacts, 'input.json'), JSON.stringify(input));
    saveInput();
    const reason = 'critic: reuse the existing caller. Fix: remove the duplicate helper.\n' + 'я'.repeat(2000) + 'END';
    fs.writeFileSync(path.join(artifacts, 'failure.txt'), reason);
    const execute = (dry, limit = 3, config = settings) => {
      assert.match(execFileSync('sh', ['-c', rejected], {encoding: 'utf8', env: {...process.env, ...config,
        MEDULLA_RUN_DIR: root, MEDULLA_WORKFLOW_DIR: here, DRY_RUN: String(dry), TASKER_RETURN_LIMIT: String(limit),
        FLOW_PUBLICATION: '{"file":"operations.json"}'}}), /<signal:DECISION>/);
      return JSON.parse(fs.readFileSync(output, 'utf8'));
    };
    let publication = execute(false);
    assert.deepEqual(publication.operations.map(row => row.command.op), ['note']);
    assert.equal(publication.operations[0].command.text, reason);
    const acFinding = {criterion: 'A', ac_quote: 'Required outcome', source_quote: 'Approved rule', source: 'source:s'};
    const rework = {...approve, verdict: 'REWORK', checks: checks(false), findings: [{problem: 'p', advice: 'a'}], ac_findings: [acFinding]};
    const writeReview = critic => fs.writeFileSync(path.join(artifacts, 'rejected-review.json'), JSON.stringify(
      review({verdict: 'OK'}, [approve, critic], 'false', 'owner', input)));
    writeReview(rework);
    publication = execute(false);
    assert.deepEqual(publication.operations[0].command.data, {stage: 'to_decide', returns: 2});
    assert.equal(publication.operations[0].command.revision, 9);
    assert.equal(publication.operations[1].command.text, reason);
    assert.equal(publication.operations[0].command.reason.length, 1000);
    for (const invalid of [{...acFinding, criterion: ''}, {...acFinding, criterion: 'Z'}, {...acFinding, ac_quote: 'not captured'},
      {...acFinding, source: 'source:unlinked'}, {...acFinding, source_quote: 'not captured'}]) {
      writeReview({...rework, ac_findings: [invalid]});
      assert.deepEqual(execute(false).operations.map(row => row.command.op), ['note']);
    }
    writeReview({...rework, draft_digest: 'old'});
    assert.deepEqual(execute(false).operations.map(row => row.command.op), ['note']);
    writeReview({...rework, ac_findings: [], node_findings: [{target: 'spec:t', quote: 'Expected result', reason_code: 'WRONG_EXPECTED'}]});
    assert.deepEqual(execute(false).operations[0].command.data, {stage: 'to_prepare', returns: 2});
    for (const code of ['GAP', 'CONFLICT']) {
      writeReview({...rework, ac_findings: [], node_findings: [{target: 'spec:t', quote: 'Expected result', reason_code: code}]});
      assert.deepEqual(execute(false).operations.map(row => row.command.op), ['note']);
    }
    const configured = {...settings, FINDING_CRITERIA: "Z", STUCK_TAG: "needs-owner", TASKER_RETURN_STAGE: "decide-again", TASKER_TEST_RETURN_STAGE: "prepare-again"};
    input.schema.types.ac.fields.stage.values.push("decide-again", "prepare-again"); saveInput();
    writeReview({...rework, ac_findings: [{...acFinding, criterion: "Z"}]});
    assert.deepEqual(execute(false, 3, configured).operations[0].command.data, {stage: "decide-again", returns: 2});
    assert.deepEqual(execute(false, 2, configured).operations[0].command.data, {stage: "decide-again", returns: 2, tags: ["keep", "needs-owner"]});
    assert.throws(() => execute(false, 3, {...configured, TASKER_RETURN_STAGE: "missing"}), /absent from the selected schema/);
    writeReview({...rework, ac_findings: [], node_findings: [{target: "spec:t", quote: "Expected result", reason_code: "WRONG_EXPECTED"}]});
    assert.deepEqual(execute(false, 3, configured).operations[0].command.data, {stage: "prepare-again", returns: 2});
    writeReview(rework);
    assert.deepEqual(execute(false, 3, configured).operations.map(row => row.command.op), ["note"]);
    for (const limit of [2, 3]) for (const [critic, stage] of [
      [rework, settings.TASKER_RETURN_STAGE],
      [{...rework, ac_findings: [], node_findings: [{target: 'spec:t', quote: 'Expected result', reason_code: 'WRONG_EXPECTED'}]}, settings.TASKER_TEST_RETURN_STAGE],
    ]) {
      writeReview(critic);
      input.selected.document.data.returns = limit - 1; saveInput();
      publication = execute(false, limit);
      assert.equal(publication.operations.filter(row => row.command.op === 'save_object').length, 1);
      assert.deepEqual(publication.operations[0].command.data, {stage, returns: limit, tags: ['keep', 'stuck']});
      assert.equal(publication.outcome.reason_code, 'STUCK');
      assert.ok(publication.operations[1].command.text.startsWith(reason));
      assert.match(publication.operations[1].command.text, /Owner: CTO\nQuestion:/);
      assert.match(publication.operations[1].command.text, /\nA:.*\nB:.*\nRecommended: A/);
      assert.deepEqual(execute(true, limit).operations, []);
    }

  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('publishes a reviewed test-only Task and refuses a critic rejection of repeated product work', () => {
  const value = draft([task([{path: 'packages/a/src/b.itest.ts', change: 'edit', lines: 9}])]);
  const approved = review(value, [approve, approve]);
  assert.equal(approved.approved, true);
  assert.equal(approved.publication.operations.filter(row => row.command.kind === 'task').length, 1);
  const rejectsRepeat = {...approve, verdict: 'REWORK',
    checks: {...approve.checks, already_in_develop: {ok: false, evidence: 'The product behavior exists. Reuse its module::symbol.'}},
    findings: [{problem: 'The plan repeats product behavior.', advice: 'Plan only the missing exact Test cases.'}]};
  assert.equal(review(value, [rejectsRepeat, approve]).approved, false);
  assert.equal(review(value, [approve, rejectsRepeat]).approved, false);
  assert.equal(review(value, [approve, {...approve, draft_digest: 'old'}]).approved, false);
});
test('a rejected result records REJECTED and preserves the critic reason for the dashboard', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tasker-rejected-'));
  try {
    const artifacts = path.join(root, 'artifacts'); fs.mkdirSync(artifacts);
    fs.writeFileSync(path.join(artifacts, 'failure-code.txt'), 'REJECTED\n');
    fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify({status: 'blocked', reason: 'critic: existing code', claim_released: true}));
    fs.writeFileSync(path.join(root, 'trees.sh'), 'exit 0\n');
    const workflow = fs.readFileSync(path.join(here, 'workflow.yaml'), 'utf8');
    const script = workflow.split('  failed:\n')[1].split('    shell: |\n')[1].split('    on_signal:')[0];
    execFileSync('sh', ['-c', script], {env: {...process.env, MEDULLA_RUN_DIR: root, MEDULLA_WORKFLOW_DIR: root}});
    const result = JSON.parse(fs.readFileSync(path.join(artifacts, 'result.json'), 'utf8'));
    assert.equal(result.reason_code, 'REJECTED');
    assert.equal(result.reason, 'critic: existing code');
    assert.equal(result.claim_released, true);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});
