import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {plannerRows} from '../../planning-joppa/run-rows.mjs';

const filter = fileURLToPath(new URL('../../writer/publication.jq', import.meta.url));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-writer-coverage-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const draft = {tests: [{id: 't1', title: 'A valid input is accepted', data: {body: 'A bounded test.'}}]};
  const input = {selected: {address: 'criterion:a', kind: 'criterion', document: {data: {owner: 'owner'}}},
    claim_revision: 7, children: [{kind: 'work', address: 'work:t', current_revision: 3,
      document: {data: {stage: 'waiting'}}}]};
  const review = {draft_digest: 'frozen', tests: [{id: 't1', score: '11111', reasons: []}],
    coverage: 'complete', missing: [], summary: 'The Test passes.'};
  const run = ({codex = review, second = review, gapTag = 'source-gap-owner', mode = 'create'} = {}) => {
    for (const [name, value] of Object.entries({draft, input, codex, second})) {
      fs.writeFileSync(path.join(root, name + '.json'), JSON.stringify(value));
    }
    const args = ['-nc', '--arg', 'digest', 'frozen', '--arg', 'test', 'check', '--arg', 'task', 'work',
      '--arg', 'waiting', 'waiting', '--arg', 'ready', 'ready', '--arg', 'mode', mode,
      '--arg', 'gap_tag', gapTag, '--arg', 'run', '2026-11-18_12-00-00-12345678'];
    for (const name of ['draft', 'input', 'codex', 'second']) args.push('--slurpfile', name, path.join(root, name + '.json'));
    return JSON.parse(execFileSync('jq', [...args, '-f', filter], {encoding: 'utf8'}));
  };
  return {root, review, input, run};
}

test('an AC coverage gap returns only the selected item and a missing note without Test or Task changes', t => {
  const f = fixture(t);
  const gap = {...f.review, coverage: 'incomplete', coverage_gap_kind: 'ac',
    missing: ['The required failure outcome is unspecified.']};
  f.input.selected.document.data.tags = ['keep'];
  const failedDraft = {...gap, tests: [{id: 't1', score: '11011', reasons: ['The Source gives no outcome.']}]};
  for (const reviews of [{codex: gap}, {second: gap}, {codex: gap, second: gap}, {codex: failedDraft}]) {
    const value = f.run(reviews);
    assert.equal(value.approved, false);
    assert.equal(value.decision_required, true);
    assert.deepEqual(value.operations[0].command, {op: 'save_object', kind: 'criterion', id: 'a', revision: 7,
      data: {tags: ['keep', 'source-gap-owner']}, reason: 'Return the item to its owner for missing acceptance coverage.'});
    assert.equal(value.operations.length, 2);
    assert.equal(value.operations[1].command.op, 'note');
    assert.equal(value.operations[1].command.target, 'criterion:a');
    assert.match(value.operations[1].command.text, /Missing coverage:\nThe required failure outcome is unspecified/);
    assert.equal(value.outcome.reason_code, 'COVERAGE_INCOMPLETE');
    assert.equal(value.outcome.status, 'blocked');
  }
  f.input.selected.document.data.tags.push('source-gap-owner');
  assert.deepEqual(f.run({codex: gap}).operations.map(row => row.command.op), ['note']);
});

test('other failures, stale reviews and malformed coverage retain the rework path', t => {
  const f = fixture(t), gap = {...f.review, coverage: 'incomplete', coverage_gap_kind: 'ac', missing: ['A required behavior is not covered.']};
  for (const edit of [r => r.draft_digest = 'other',
    r => r.tests[0].id = 'other', r => r.missing = [], r => r.missing = 'not an array',
    r => r.coverage = 'complete', r => r.missing = ['']]) {
    const bad = structuredClone(gap); edit(bad);
    for (const reviews of [{codex: bad, second: gap}, {codex: gap, second: bad}]) {
      const value = f.run(reviews);
      assert.equal(value.approved, false);
      assert.equal(value.decision_required, undefined);
      assert.equal(value.operations, undefined);
      assert.ok(value.critique);
    }
  }
});

test('disabled decision routing and update mode keep the existing behavior', t => {
  const f = fixture(t), gap = {...f.review, coverage: 'incomplete', coverage_gap_kind: 'ac', missing: ['A required behavior is not covered.']};
  for (const extra of [{gapTag: ''}, {mode: 'update'}]) {
    const value = f.run({codex: gap, second: gap, ...extra});
    assert.equal(value.decision_required, undefined);
    assert.ok(value.critique);
  }
  const approved = f.run();
  assert.equal(approved.approved, true);
  assert.equal(approved.operations.length, 1);
  assert.equal(approved.operations[0].command.kind, 'check');
  assert.ok(approved.operations.every(({command}) => command.kind === 'check'));
});

test('the missing note stays bounded and points to the complete critic artifacts', t => {
  const f = fixture(t), gap = {...f.review, coverage: 'incomplete', coverage_gap_kind: 'ac', missing: ['A'.repeat(6000)]};
  const value = f.run({codex: gap, second: gap});
  assert.ok(value.operations[1].command.text.length <= 1000);
  assert.ok(value.operations[1].command.id.length <= 120);
  assert.match(value.operations[1].command.text, /critic-codex.json and artifacts\/critic-second.json/);
  assert.ok(value.outcome.reason.length <= 1000);
});

test('approved create and update write only Test text and preserve item and Task stages', t => {
  const f = fixture(t);
  f.input.selected.document.data.stage = 'author_tests';
  f.input.children.push({kind: 'check', address: 'check:t1', current_revision: 5,
    document: {data: {title: 'A valid input is accepted', body: 'Earlier text.'}}});
  for (const mode of ['create', 'update']) {
    const value = f.run({mode});
    assert.equal(value.approved, true);
    assert.equal(value.operations.length, 1);
    assert.equal(value.operations[0].command.kind, 'check');
    assert.equal(value.operations[0].command.data.stage, undefined);
    assert.equal(f.input.selected.document.data.stage, 'author_tests');
    assert.equal(f.input.children[0].document.data.stage, 'waiting');
  }
});

test('the dashboard shows the coverage reason code for the completed blocked run', t => {
  const f = fixture(t), gap = {...f.review, coverage: 'incomplete', coverage_gap_kind: 'ac', missing: ['An outcome is unspecified.']};
  const value = f.run({codex: gap});
  const folder = path.join(f.root, '2026-11-18_12-00-00-example'), artifacts = path.join(folder, 'artifacts');
  fs.mkdirSync(artifacts, {recursive: true});
  fs.writeFileSync(path.join(artifacts, 'input.json'), JSON.stringify({selected: f.input.selected}));
  fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify(value.outcome));
  const [row] = plannerRows(f.root);
  assert.equal(row.status, 'BLOCKED');
  assert.equal(row.stage, 'COVERAGE_INCOMPLETE');
});

test('draft_check sends an empty source gap directly to decision publication', t => {
  const f = fixture(t), artifacts = path.join(f.root, 'artifacts');
  fs.mkdirSync(artifacts);
  const workflow = fileURLToPath(new URL('../../writer/workflow.yaml', import.meta.url));
  const shell = fs.readFileSync(workflow, 'utf8').match(/^  draft_check:\n[\s\S]*?    shell: \|\n([\s\S]*?)^    on_signal:/m)[1]
    .replace(/^      /gm, '');
  fs.writeFileSync(path.join(artifacts, 'input.json'), JSON.stringify(f.input));
  for (const [draft, mode, gapTag, signal] of [
    [{tests: [], coverage: 'GAP. The source gives no refusal outcome.'}, 'create', 'needs_input', 'SOURCE_GAP'],
    [{tests: [], coverage: 'GAP. Missing source.'}, 'update', 'needs_input', 'REVISE'],
    [{tests: [], coverage: 'GAP. Missing source.'}, 'create', '', 'REVISE'],
    [{tests: [], coverage: 'Complete.'}, 'create', 'needs_input', 'REVISE'],
    [{tests: [], coverage: 'GAP. '}, 'create', 'needs_input', 'REVISE'],
  ]) {
    const file = path.join(artifacts, 'operations.json');
    fs.rmSync(file, {force: true});
    fs.writeFileSync(path.join(artifacts, 'draft.json'), JSON.stringify(draft));
    const output = execFileSync('bash', ['-c', shell], {encoding: 'utf8', env: {...process.env,
      MEDULLA_RUN_DIR: f.root, MEDULLA_WORKFLOW_DIR: path.dirname(workflow), TEST_KIND: 'check',
      TEST_OPERATION: mode, SOURCE_GAP_TAG: gapTag, REWORK_LIMIT: '1', round: '1',
      FLOW_PUBLICATION: JSON.stringify({file: 'operations.json'})}});
    assert.ok(output.includes(`<signal:${signal}>`), output);
    assert.equal(fs.existsSync(file), signal === 'SOURCE_GAP');
    if (signal === 'SOURCE_GAP') {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(value.outcome.reason_code, 'SOURCE_GAP');
      assert.equal(value.outcome.status, 'blocked');
      assert.deepEqual(value.operations[0].command.data, {tags: [gapTag]});
      assert.equal(value.operations[0].command.revision, f.input.claim_revision);
      assert.equal(value.operations.length, 2);
      assert.match(value.operations[1].command.text, /^GAP\. The source gives no refusal outcome/);
    }
  }
});

test('critic inputs keep Codex independent and use the selected second harness isolation', t => {
  const workflow = fileURLToPath(new URL('../../writer/workflow.yaml', import.meta.url));
  const shell = fs.readFileSync(workflow, 'utf8').match(/^    inputs:\n      shell: \|\n([\s\S]*?)^    agent:/m)[1]
    .replace(/^        /gm, '');
  for (const harness of ['claude-code', 'agy', 'codex']) {
    const seats = JSON.parse(execFileSync('bash', ['-c', shell], {encoding: 'utf8', env: {...process.env,
      CRITIC_CODEX_MODEL: 'gpt-6.2-sol', CRITIC_SECOND_HARNESS: harness,
      CRITIC_SECOND_MODEL: {agy: 'gemini-4-carbon-high', codex: 'gpt-6.1-sol', 'claude-code': 'claude-sonnet-5-5'}[harness],
      AGY_PROFILE_HOME: '/private/isolated-critic'}}));
    assert.equal(seats.length, 2);
    assert.deepEqual(seats[0], {slug: 'codex', harness: 'codex', model: 'gpt-6.2-sol',
      a1: '--ignore-user-config', a2: '-c', a3: 'mcp_servers={}'});
    const second = seats[1];
    assert.equal(second.slug, 'second');
    assert.equal(second.harness, harness);
    if (harness === 'agy') {
      assert.equal(second.model, 'gemini-4-carbon-high');
      assert.deepEqual(second.env, {BROKER_AGY_HOME: '/private/isolated-critic', BROKER_ISOLATE_MCP: '1'});
      assert.equal(second.a1, undefined);
    } else if (harness === 'codex') {
      assert.deepEqual(second, {...seats[0], slug: 'second', model: 'gpt-6.1-sol'});
      assert.match(fs.readFileSync(workflow, 'utf8').split('  critics:\n')[1], /sandbox: read-only/);
    } else {
      assert.equal(second.a1, '--strict-mcp-config');
      assert.equal(second.a4, '{"mcpServers":{}}');
      assert.match(second.a6, /Bash,Read,Glob,Grep/);
    }
  }
});

test('prepare accepts distinct Codex critics and rejects invalid seats before claim', t => {
  const f = fixture(t), workflow = fileURLToPath(new URL('../../writer/workflow.yaml', import.meta.url));
  const shell = fs.readFileSync(workflow, 'utf8').match(/^  prepare:\n    shell: \|\n([\s\S]*?)^    on_signal:/m)[1]
    .replace(/^      /gm, '');
  for (const overrides of [{CRITIC_SECOND_HARNESS: 'unknown'}, {CRITIC_SECOND_MODEL: 'author-model'},
    {CRITIC_SECOND_HARNESS: 'codex', CRITIC_SECOND_MODEL: 'gpt-6.2-sol'}, {CRITIC_CODEX_MODEL: ''},
    {CRITIC_SECOND_MODEL: ''}, {CRITIC_SECOND_HARNESS: 'agy', AGY_PROFILE_HOME: path.join(f.root, 'absent')}]) {
    assert.throws(() => execFileSync('bash', ['-c', shell], {stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env,
      CREW_FLOW_STAGES: '/must-not-run', FLOW_PUBLICATION: '{"file":"operations.json"}', TEST_KIND: 'check',
      TEST_OPERATION: 'create', SOURCE_GAP_TAG: '', REWORK_LIMIT: '1', AUTHOR_MODEL: 'author-model',
      CRITIC_CODEX_MODEL: 'gpt-6.2-sol',
      CRITIC_SECOND_HARNESS: 'claude-code', CRITIC_SECOND_MODEL: 'other-model', CRITIC_CLAUDE_MODEL: '',
      ...overrides}}), error => error.status === 2 && !String(error.stderr).includes('must-not-run'));
  }
  const artifacts = path.join(f.root, 'artifacts'), stages = path.join(f.root, 'prepare.sh');
  fs.mkdirSync(artifacts);
  fs.writeFileSync(path.join(artifacts, 'input.json'), JSON.stringify({...f.input, references: {}, schema: {types: {}}}));
  fs.writeFileSync(stages, 'printf "<signal:PREPARED>Fixture</signal:PREPARED>\\n"');
  const output = execFileSync('bash', ['-c', shell], {encoding: 'utf8', env: {...process.env,
    CREW_FLOW_STAGES: stages, PLANNING_PYTHON: 'sh', MEDULLA_RUN_DIR: f.root,
    FLOW_PUBLICATION: '{"file":"operations.json"}', TEST_KIND: 'check', TEST_OPERATION: 'create',
    SOURCE_GAP_TAG: '', REWORK_LIMIT: '1', AUTHOR_MODEL: 'author-model', CRITIC_CLAUDE_MODEL: '',
    CRITIC_CODEX_MODEL: 'gpt-6.2-sol', CRITIC_SECOND_HARNESS: 'codex', CRITIC_SECOND_MODEL: 'gpt-6.1-sol'}});
  assert.match(output, /<signal:PREPARED>/);
});

test('review_join returns missing Tests to the author and sends only AC gaps to the owner', t => {
  const f = fixture(t), artifacts = path.join(f.root, 'artifacts');
  f.run();
  fs.mkdirSync(artifacts);
  for (const name of ['draft', 'input']) fs.copyFileSync(path.join(f.root, name + '.json'), path.join(artifacts, name + '.json'));
  const digest = createHash('sha256').update(fs.readFileSync(path.join(artifacts, 'draft.json'))).digest('hex');
  const workflow = fileURLToPath(new URL('../../writer/workflow.yaml', import.meta.url));
  const shell = fs.readFileSync(workflow, 'utf8').match(/^  review_join:\n[\s\S]*?    shell: \|\n([\s\S]*?)^    on_signal:/m)[1]
    .replace(/^      /gm, '');
  for (const [kind, signal] of [[null, 'APPROVED'], [undefined, 'REVISE'], ['author', 'REVISE'], ['tests', 'REVISE'],
    ['unknown', 'REVISE'], ['ac', 'MISSING']]) {
    const report = {...f.review, draft_digest: digest};
    fs.writeFileSync(path.join(artifacts, 'critic-codex.json'), JSON.stringify(report));
    if (kind !== null) Object.assign(report, {coverage: 'incomplete', coverage_gap_kind: kind,
      missing: ['Decision preservation needs two Tests. Title: Preserve the decision.']});
    fs.writeFileSync(path.join(artifacts, 'critic-second.json'), JSON.stringify(report));
    const file = path.join(artifacts, 'operations.json');
    fs.rmSync(file, {force: true});
    const output = execFileSync('bash', ['-c', shell], {encoding: 'utf8', env: {...process.env,
      MEDULLA_RUN_DIR: f.root, MEDULLA_WORKFLOW_DIR: path.dirname(workflow), TEST_KIND: 'check',
      TEST_OPERATION: 'create', SOURCE_GAP_TAG: 'source-gap-owner', REWORK_LIMIT: '1', round: '1',
      FLOW_PUBLICATION: JSON.stringify({file: 'operations.json'})}});
    assert.ok(output.includes(`<signal:${signal}>`), output);
    assert.equal(fs.existsSync(file), signal !== 'REVISE');
    if (signal === 'REVISE') {
      assert.match(output, /Decision preservation needs two Tests/);
      assert.match(output, /<signal:var key=round>2<\/signal:var>/);
    } else {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (signal === 'MISSING') assert.equal(value.outcome.reason_code, 'COVERAGE_INCOMPLETE');
      else assert.equal(value.operations[0].command.kind, 'check');
    }
  }
});
