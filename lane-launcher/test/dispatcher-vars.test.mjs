import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {configFrom} from '../launcher-config.mjs';
import {laneArgs, save} from '../runtime.mjs';
import {setup} from '../test-support/launcher.fixture.mjs';

test('dispatcher vars pass exact string arguments without evaluating shell text', async t => {
  const f = await setup(t, {launchLanes: false});
  const workflow = path.join(f.root, 'workflow.yaml');
  fs.writeFileSync(workflow, "vars:\n  REJECT_ROUNDS: '2'\n  CUSTOM: ''\n  EMPTY: ''\nnodes: {}\n");
  const vars = {REJECT_ROUNDS: '1', CUSTOM: 'literal = "quoted" $(touch must-not-exist)', EMPTY: ''};
  save(f.configFile, {...f.config, workflow, vars});
  const config = configFrom(f.configFile, f.env), args = laneArgs(config, 'one');
  assert.deepEqual(config.vars, vars);
  for (const [key, value] of Object.entries(vars)) {
    const index = args.indexOf(key + '=' + value);
    assert.ok(index > 0);
    assert.equal(args[index - 1], '--var');
  }
  for (const invalid of [null, [], 'value', {lower: 'x'}, {'BAD-NAME': 'x'}, {'1KEY': 'x'},
    {VALUE: 2}, {VALUE: null}, {VALUE: {}}, {VALUE: '\0'}]) {
    save(f.configFile, {...f.config, vars: invalid});
    assert.throws(() => configFrom(f.configFile, f.env), /vars must map/);
  }
});

test('dispatcher vars refuse undeclared keys and declared host-owned keys before launch', async t => {
  const f = await setup(t, {launchLanes: false});
  const workflow = path.join(f.root, 'workflow.yaml');
  const owned = ['TICKET_SOURCE', 'TARGET_BRANCH', 'CBM_PROJECT', 'LANE_MEMORY_CONFIG', 'TOOLING_ROOT',
    'LAUNCH_CLAIM_FILE', 'GIT_SSH_COMMAND', 'REVIEWERS_JSON', 'REPAIR_BASELINE_ENABLED'];
  fs.writeFileSync(workflow, 'vars:\n' + owned.map(key => `  ${key}: ''\n`).join('') + 'nodes: {}\n');
  for (const key of owned) {
    save(f.configFile, {...f.config, workflow, vars: {[key]: 'override'}});
    assert.throws(() => configFrom(f.configFile, f.env), /host-owned/);
  }
  for (const key of ['UNKNOWN', 'BASH_ENV', 'NODE_OPTIONS']) {
    save(f.configFile, {...f.config, workflow, vars: {[key]: 'override'}});
    assert.throws(() => configFrom(f.configFile, f.env), /not declared in workflow.vars/);
  }
});

test('lane assembly keeps fixed host variables after dispatcher overrides', async t => {
  const f = await setup(t, {launchLanes: false});
  const source = fs.readFileSync(fileURLToPath(new URL('../../lane/run.sh', import.meta.url)), 'utf8');
  const assembly = source.slice(source.indexOf('medulla_args=('), source.indexOf('launch_medulla "${medulla_args[@]}"'));
  const bindings = `set -eu
workflow_args=(-w lane --var TOOLING_ROOT=/fixed/crew)
coder_args=(); mounts=(--mount-ro /sources); context_vars=(); hooks_vars=(); passthrough=("$@")
RUNS_FOLDER=/run; cbm_connector=/connector; cbm_project=source; ticket=one; claim_file=/claim
target=main; repository_preflight=; requirement_reader=; joppa_reader_command=
LANE_WORKTREE=/worktree; ticket_json='{"title":"One"}'; project=workspace; project_dir=/worktree
gate_json='["check"]'; review_json='["review"]'; gate_timeout=900; LANE_REPOSITORY_JSON='{}'
test_command='["test"]'; git_ssh=ssh
`;
  const literal = 'literal = "quoted" $(touch must-not-exist)';
  const output = execFileSync('bash', ['-c', bindings + assembly + '\nprintf \'%s\\0\' "${medulla_args[@]}"',
    'fixture', '--var', 'REJECT_ROUNDS=1', '--var', 'TARGET_BRANCH=wrong', '--var', 'TOOLING_ROOT=wrong',
    '--var', 'CUSTOM=' + literal], {cwd: f.root}).toString().split('\0').filter(Boolean);
  const values = Object.fromEntries(output.flatMap((value, index) => {
    if (value !== '--var') return [];
    const assignment = output[index + 1], at = assignment.indexOf('=');
    return [[assignment.slice(0, at), assignment.slice(at + 1)]];
  }));
  assert.equal(values.REJECT_ROUNDS, '1');
  assert.equal(values.CUSTOM, literal);
  assert.equal(values.TARGET_BRANCH, 'main');
  assert.equal(values.TOOLING_ROOT, '/fixed/crew');
  assert.equal(fs.existsSync(path.join(f.root, 'must-not-exist')), false);
});
