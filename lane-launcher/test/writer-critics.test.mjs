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
const writer = path.dirname(filter);
// The project config of the final Writer contract: AC stages, criterion letters, returns limit and stuck tag.
const contract = {READY_STAGE: 'to_task', RETURN_STAGE: 'to_decide', FINDING_CRITERIA: 'G A U M V', RETURNS_LIMIT: '3', STUCK_TAG: 'stuck'};
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-writer-coverage-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const draft = {tests: [{id: 't1', title: 'A valid input is accepted', data: {body: 'A bounded test.'}}]};
  const input = {selected: {address: 'criterion:a', kind: 'criterion', document: {data: {owner: 'owner'}}},
    claim_revision: 7, children: [{kind: 'work', address: 'work:t', current_revision: 3,
      document: {data: {stage: 'waiting'}}}],
    schema: {types: {criterion: {fields: {stage: {type: 'enum', values: ['author_tests', 'to_task', 'to_decide']},
      returns: {type: 'number'}, tags: {type: 'list'}}}}}};
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
  // The host review of the same files. It adds the AC writes that the jq verdict leaves out.
  const host = ({codex = review, second = review, gapTag = 'source-gap-owner', mode = 'create'} = {}) => {
    const artifacts = path.join(root, 'host', 'artifacts');
    fs.mkdirSync(artifacts, {recursive: true});
    for (const [name, value] of Object.entries({draft, input})) fs.writeFileSync(path.join(artifacts, name + '.json'), JSON.stringify(value));
    const digest = createHash('sha256').update(fs.readFileSync(path.join(artifacts, 'draft.json'))).digest('hex');
    for (const [name, value] of Object.entries({codex, second})) {
      fs.writeFileSync(path.join(artifacts, 'critic-' + name + '.json'), JSON.stringify({...value, draft_digest: digest}));
    }
    return JSON.parse(execFileSync('node', [path.join(writer, 'control.mjs'), 'review', artifacts], {encoding: 'utf8', env: {...process.env,
      ...contract, MEDULLA_WORKFLOW_DIR: writer, TEST_KIND: 'check', TEST_OPERATION: mode, SOURCE_GAP_TAG: gapTag}}));
  };
  return {root, review, input, run, host};
}

test('critic inputs keep Codex independent and use the selected second harness isolation', t => {
  const workflow = fileURLToPath(new URL('../../writer/workflow.yaml', import.meta.url));
  const shell = fs.readFileSync(workflow, 'utf8').match(/^    inputs:\n      shell: \|\n([\s\S]*?)^    agent:/m)[1]
    .replace(/^        /gm, '');
  for (const harness of ['claude-code', 'agy', 'codex']) {
    const seats = JSON.parse(execFileSync('bash', ['-c', shell], {encoding: 'utf8', env: {...process.env,
      MEDULLA_WORKFLOW_DIR: writer, CRITIC_CODEX_MODEL: 'gpt-6.2-sol', CRITIC_SECOND_HARNESS: harness,
      CRITIC_SECOND_MODEL: {agy: 'gemini-4-carbon-high', codex: 'gpt-6.1-sol', 'claude-code': 'claude-sonnet-5-5'}[harness],
      AGY_PROFILE_HOME: '/private/isolated-critic'}}));
    assert.equal(seats.length, 2);
    // Both tool-free seats: Codex turns off each tool feature, and Claude runs without MCP servers and tools.
    assert.deepEqual(seats[0], {slug: 'codex', harness: 'codex', model: 'gpt-6.2-sol', a1: '--ignore-user-config',
      ...Object.fromEntries(['shell_tool', 'view_image', 'apps', 'browser_use', 'multi_agent'].flatMap((name, index) =>
        [['a' + (2 * index + 2), '-c'], ['a' + (2 * index + 3), 'features.' + name + '=false']]))});
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
      assert.equal(second.a5, '--tools=');
    }
  }
});

test('prepare accepts distinct Codex critics and rejects invalid seats before claim', t => {
  const f = fixture(t), workflow = fileURLToPath(new URL('../../writer/workflow.yaml', import.meta.url));
  const config = path.join(f.root, 'config.json');
  fs.writeFileSync(config, JSON.stringify({selection: {kind: 'criterion'}, exclude_tags: ['stuck']}));
  const base = {...contract, MEDULLA_WORKFLOW_DIR: writer, PLANNING_JOPPA_CONFIG: config};
  const shell = fs.readFileSync(workflow, 'utf8').match(/^  prepare:\n    shell: \|\n([\s\S]*?)^    on_signal:/m)[1]
    .replace(/^      /gm, '');
  for (const overrides of [{CRITIC_SECOND_HARNESS: 'unknown'}, {CRITIC_SECOND_MODEL: 'author-model'},
    {CRITIC_SECOND_HARNESS: 'codex', CRITIC_SECOND_MODEL: 'gpt-6.2-sol'}, {CRITIC_CODEX_MODEL: ''},
    {CRITIC_SECOND_MODEL: ''}, {CRITIC_SECOND_HARNESS: 'agy', AGY_PROFILE_HOME: path.join(f.root, 'absent')}]) {
    assert.throws(() => execFileSync('bash', ['-c', shell], {stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, ...base,
      CREW_FLOW_STAGES: '/must-not-run', FLOW_PUBLICATION: '{"file":"operations.json"}', TEST_KIND: 'check',
      TEST_OPERATION: 'create', SOURCE_GAP_TAG: '', REWORK_LIMIT: '1', AUTHOR_MODEL: 'author-model',
      CRITIC_CODEX_MODEL: 'gpt-6.2-sol',
      CRITIC_SECOND_HARNESS: 'claude-code', CRITIC_SECOND_MODEL: 'other-model', CRITIC_CLAUDE_MODEL: '',
      ...overrides}}), error => error.status === 1 && /^writer: /m.test(String(error.stderr)) && !String(error.stderr).includes('must-not-run'));
  }
  const artifacts = path.join(f.root, 'artifacts'), stages = path.join(f.root, 'prepare.sh');
  fs.mkdirSync(artifacts);
  fs.writeFileSync(path.join(artifacts, 'input.json'), JSON.stringify({...f.input, references: {}, schema: {types: {}}}));
  fs.writeFileSync(stages, 'printf "<signal:PREPARED>Fixture</signal:PREPARED>\\n"');
  const output = execFileSync('bash', ['-c', shell], {encoding: 'utf8', env: {...process.env, ...base,
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
    const output = execFileSync('bash', ['-c', shell], {encoding: 'utf8', env: {...process.env, ...contract,
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
