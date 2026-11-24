import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = new URL('.', import.meta.url).pathname;
const workflow = Bun.YAML.parse(readFileSync(join(dir, 'workflow.yaml'), 'utf8'));
const role = name => readFileSync(join(dir, 'prompts', name + '.md'), 'utf8');

test('each prompt is the role line, the role file path and the AC address', () => {
  // At most 1024 characters: the role file in the run holds the steps and the answer format.
  const read = 'Read your role file with mcp__joppa__read_file and follow it.\n';
  assert.equal(workflow.nodes.finders.prompt, 'AC audit finder. ' + read + 'Role file: {{var:audit_artifacts}}/finder.md\nAC: {{var:audit_ac}}\n');
  assert.equal(workflow.nodes.judge.prompt, 'AC audit judge. ' + read + 'Role file: {{var:audit_artifacts}}/judge.md\nAC: {{var:audit_ac}}\n');
  const a = '/Users/finik/Projects/finik/.medulla/auditor-runs/2026-11-24_08-33-04-be678ae6/artifacts';
  const values = {audit_ac: 'ac:eqc8z147', audit_artifacts: a, ...Object.fromEntries(['one', 'two', 'three'].map(n => [`finder_${n}_path`, `${a}/finder-${n}.json`]))};
  const render = prompt => prompt.replace(/\{\{file:prompts\/([a-z]+\.md)\}\}/g, (_, name) => readFileSync(join(dir, 'prompts', name), 'utf8'))
    .replace(/\{\{var:([a-z_]+)\}\}/g, (_, name) => values[name] ?? '');
  for (const [node, name] of [['finders', 'finder'], ['judge', 'judge']]) {
    const prompt = render(workflow.nodes[node].prompt);
    assert.ok(prompt.includes(`Role file: ${a}/${name}.md`));
    // Medulla appends SIGNAL_PROTOCOL (586 characters, medulla v2 signals.py) to each agent prompt.
    assert.ok(prompt.length + 586 <= 1024, node + ' prompt has ' + prompt.length + ' characters before the signal protocol');
    assert.doesNotMatch(prompt, /\{\{/);
    assert.doesNotMatch(role(name), /Do not read files|All input is in this prompt|role contract below/);
    for (const text of ['mcp__joppa__read_context first', 'offset set to next_offset until next_offset is null']) assert.ok(role(name).includes(text), name + ' lacks ' + text);
  }
});

test('each finder and the judge get their own read-only reader', () => {
  const shell = workflow.nodes.prepare.shell;
  const finder = '"$(files finder.md contract-finder.md audit-assignment.json)"';
  for (const line of [`prepare auditor_finder_one ${finder}`, `prepare auditor_finder_two ${finder}`, `prepare auditor_finder_three ${finder} --agy`,
    'prepare auditor_judge "$(files judge.md contract-judge.md audit-assignment.json finder-one.json finder-two.json finder-three.json)"'])
    assert.ok(shell.includes('node "$reader" ' + line), 'prepare lacks ' + line);
  assert.match(shell, /for role in finder judge; do .*contracts\.json.*contract-\$role\.md/);
  assert.deepEqual(workflow.nodes.judge.agent.args, ['--strict-mcp-config', '--setting-sources=', '--mcp-config', '{{var:auditor_judge_reader_config}}', '--tools=']);
  assert.ok(workflow.nodes.finders.agent.args.includes('{{input.a13:-}}'));
});

test('the finder seats take the reader args of the shared helper and refuse a seat without its AGY profile', () => {
  const runtime = mkdtempSync(join(tmpdir(), 'auditor-seats-'));
  // A stand-in for the shared agent-reader.mjs: agentArgs names the config file.
  writeFileSync(join(runtime, 'agent-reader.mjs'), "export const agentArgs = (harness, file, home) => harness === 'agy' ? ['--add-dir', home, '--settings', file] : ['--ignore-user-config', '-c', 'mcp_servers=' + file];\n");
  const run = home => spawnSync('node', [join(dir, 'seats.mjs')], {encoding: 'utf8', env: {...process.env, CREW_FLOW_STAGES: join(runtime, 'flow_stages.py'),
    FINDER_ONE_MODEL: 'm1', FINDER_TWO_MODEL: 'm2', FINDER_THREE_MODEL: 'm3', auditor_finder_one_reader_config: '/r/one.json',
    auditor_finder_two_reader_config: '/r/two.json', auditor_finder_three_reader_config: '/r/three.json', auditor_finder_three_reader_home: home}});
  const ok = run('/agy/auditor_finder_three');
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout), [
    {slug: 'one', harness: 'codex', model: 'm1', a1: '--ignore-user-config', a2: '-c', a3: 'mcp_servers=/r/one.json'},
    {slug: 'two', harness: 'codex', model: 'm2', a1: '--ignore-user-config', a2: '-c', a3: 'mcp_servers=/r/two.json'},
    {slug: 'three', harness: 'agy', model: 'm3', a1: '--add-dir', a2: '/agy/auditor_finder_three', a3: '--settings', a4: '/r/three.json',
      env: {BROKER_AGY_HOME: '/agy/auditor_finder_three', BROKER_ISOLATE_MCP: '1'}}]);
  assert.notEqual(run('').status, 0);
});
