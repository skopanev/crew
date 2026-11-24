import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {repairView} from './repair-plan.mjs';
import {retirementBinding} from './retirement-proof.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const settings = JSON.parse(fs.readFileSync(path.join(here, "config.example.json"), "utf8")).vars;
const workflow = fs.readFileSync(path.join(here, 'workflow.yaml'), 'utf8');
const prepare = workflow.split('  prepare:\n')[1].split('    shell: |\n')[1].split('    on_signal:')[0];
const updates = output => Object.fromEntries([...output.matchAll(/^<signal:var key=([A-Za-z_][A-Za-z0-9_]*)>(.*?)<\/signal:var>$/gm)]
  .map(([, key, value]) => [key, value]));
const object = (address, body) => ({address, kind: address.split(':')[0], current_revision: 4,
  document: {data: {title: address, body, stage: 'to_task'}, present: true}});

function fixture(t, role = 'ac') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tasker-context-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const artifacts = path.join(root, 'artifacts'), definition = path.join(root, 'workflow');
  fs.mkdirSync(artifacts); fs.mkdirSync(definition);
  const engine = path.join(root, 'engine');
  fs.mkdirSync(path.join(engine, 'planning-joppa'), {recursive: true});
  fs.mkdirSync(path.join(engine, 'lane-launcher'));
  const stages = path.join(engine, 'planning-joppa', 'stages.sh');
  fs.writeFileSync(stages, `#!/bin/sh
touch "$MEDULLA_RUN_DIR/shared-prepare-called"
if [ "\${PREPARE_BLOCKED:-}" = true ]; then echo '<signal:BLOCKED>No item</signal:BLOCKED>'; exit 0; fi
cp "$MEDULLA_RUN_DIR/contracts-source.json" "$MEDULLA_RUN_DIR/artifacts/contracts.json"
if [ "\${FLOW_ASSIGNMENT_INLINE:-true}" = true ]; then
  assignment="$(jq -c . "$MEDULLA_RUN_DIR/artifacts/input.json")"
  [ "$(printf '%s' "$assignment" | wc -c)" -lt 100000 ] || { echo 'assignment: context too large' >&2; exit 2; }
  case "$assignment" in *'</signal:var>'*) echo 'reserved signal delimiter in context' >&2; exit 2;; esac
  printf '<signal:var key=assignment>%s</signal:var>\\n' "$assignment"
fi
echo '<signal:var key=author_contract>Author contract</signal:var>'
echo '<signal:var key=critic_contract>Critic contract</signal:var>'
echo '<signal:PREPARED>Ready</signal:PREPARED>'
`);
  fs.writeFileSync(path.join(definition, 'trees.sh'), 'touch "$MEDULLA_RUN_DIR/trees-called"\n');
  fs.writeFileSync(path.join(definition, 'completion.mjs'), 'console.log(process.argv[2]==="preclaim"&&process.env.COMPLETION_BLOCKED==="true"?"<signal:BLOCKED>Active lane.</signal:BLOCKED>":"<signal:CONTINUE>Context fixture.</signal:CONTINUE>");');
  fs.copyFileSync(path.join(here, 'repair-context.mjs'), path.join(definition, 'repair-context.mjs'));
  for (const name of ['repair-plan.mjs', 'retirement-proof.mjs', 'host-split-replan.mjs', 'test-bindings.mjs']) {
    fs.symlinkSync(path.join(here, name), path.join(definition, name));
  }
  fs.writeFileSync(path.join(engine, 'lane-launcher', 'joppa-api.mjs'), `import fs from 'node:fs';
export async function readJoppa() {
  return JSON.parse(fs.readFileSync(process.env.MEDULLA_RUN_DIR + '/pinned.json', 'utf8'));
}
`);
  fs.writeFileSync(path.join(engine, 'planning-joppa', 'agent-reader.mjs'), `import fs from 'node:fs';import path from 'node:path';
export const agentArgs=(harness,config)=>['--strict-mcp-config','--setting-sources=','--mcp-config',config,'--tools='];
if(process.argv[2]==='prepare'){
const [mode,role,files,mcp]=process.argv.slice(2);
const a=path.join(process.env.MEDULLA_RUN_DIR,'artifacts');
fs.writeFileSync(path.join(a,role+'-files.json'),files.startsWith('@')?fs.readFileSync(files.slice(1),'utf8'):files);
fs.writeFileSync(path.join(a,role+'-config.json'),fs.readFileSync(mcp,'utf8'));
for(const [key,value]of Object.entries({[role+'_reader_config']:path.join(a,role+'-config.json'),[role+'_reader_home']:path.join(a,role+'-home')}))console.log('<signal:var key='+key+'>'+value+'</signal:var>');}`);
  const write = (name, value) => fs.writeFileSync(path.join(artifacts, name), JSON.stringify(value));
  const parent = object('ac:a', 'Required outcome'), selected = role === 'task'
    ? object('task:t', 'Criterion: ac:a@4. Required outcome\nRead only: context.ts') : parent;
  const input = {workspace: 'fixture', selected, claim_revision: 5, claim_revisions: {a: 5}, help: {unused: true},
    schema: {types: {ac: {role: 'ac'}, task: {role: 'task'}, test: {role: 'test'}, source: {}, unused: {}}},
    children: [object('test:x', 'Expected outcome')], references: {sources: [object('source:s', 'Source text')]}};
  if (role === 'task') input.context = {parent, children: input.children, references: input.references,
    incoming: [object('task:dependent', 'Dependent work')]};
  fs.writeFileSync(path.join(root, 'pinned.json'), JSON.stringify(parent));
  fs.writeFileSync(path.join(root, 'contracts-source.json'), JSON.stringify({author: {content: 'Author contract'}, critic: {content: 'Critic contract'}}));
  fs.mkdirSync(path.join(definition, 'prompts'));
  for (const name of ['author.md', 'critic.md']) fs.copyFileSync(path.join(here, 'prompts', name), path.join(definition, 'prompts', name));
  const config = path.join(root, 'config.json'); fs.writeFileSync(config, '{"url":"fixture","token_file":"unused"}');
  const trees = {repo: {path: path.join(root, 'develop'), sha: 'a'.repeat(40), unused: 'not in the view'}};
  write('input.json', input); write('trees.json', trees);
  const env = {...process.env, ...settings, PLANNING_PYTHON: 'sh', TASKER_BUN: process.execPath, CREW_FLOW_STAGES: stages, PLANNING_JOPPA_CONFIG: config,
    MEDULLA_RUN_DIR: root, MEDULLA_WORKFLOW_DIR: definition, TASKER_REPOS: '{}', TASKER_TREE_ROOT: root,
    CREW_WORKFLOW_DIR: path.join(here, '../workflow'), CBM_BIN: 'unused', CBM_CACHE_DIR: root, CBM_ALLOWED_ROOT: root,
    REWORK_LIMIT: '3', TASKER_RETURN_LIMIT: '3', PLAN_MAX_FILES: '8', PLAN_MAX_LINES: '300', DRY_RUN: 'false',
    CRITIC_SECOND_HARNESS: 'claude-code', AUTHOR_MODEL: 'author', CRITIC_CODEX_MODEL: 'first', CRITIC_SECOND_MODEL: 'second',
    FLOW_PUBLICATION: JSON.stringify({file: 'operations.json', allowed_operations: ['save_object', 'note'],
      create_kinds: role === 'task' ? [] : ['task'], update_kinds: role === 'task' ? ['ac', 'task'] : ['ac', 'test']})};
  const run = () => spawnSync('bash', ['-c', prepare], {encoding: 'utf8', env, maxBuffer: 2 * 1024 * 1024});
  return {root, artifacts, env, input, trees, write, run, stages};
}

for (const role of ['ac', 'task']) test(`${role} prepare keeps the complete large view in an escaped artifact`, t => {
  const f = fixture(t, role), sentinel = path.join(f.root, 'sentinel.txt');
  fs.writeFileSync(sentinel, 'HOST_FILE_MUST_NOT_APPEAR');
  const literal = `{{file:${sentinel}}} {{var:author_contract}} {{input}} {{{{ \\{{input.x}} Привет 🧪 </signal:var>`;
  f.input.selected.annotations = {comments: {note: {text: 'n'.repeat(60000) + literal}}, history: [{body: literal}]};
  f.input.references.sources[0].document.data.body = 's'.repeat(60000) + literal;
  f.write('input.json', f.input);
  const original = fs.readFileSync(path.join(f.artifacts, 'input.json'), 'utf8');
  assert.ok(Buffer.byteLength(original) > 100000);
  const result = f.run(); assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /<signal:READY_TO_WRITE>/);
  const vars = updates(result.stdout), file = vars.tasker_assignment_path;
  assert.equal(path.isAbsolute(file), true);
  assert.equal(Object.hasOwn(vars, 'author_contract'), false); assert.equal(Object.hasOwn(vars, 'critic_contract'), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.artifacts, 'contracts.json'))),
    {author: {content: 'Author contract'}, critic: {content: 'Critic contract'}});
  assert.equal(Object.hasOwn(vars, 'assignment'), false); assert.equal(Object.hasOwn(vars, 'tasker_assignment'), false);
  assert.ok(Buffer.byteLength(result.stdout) < 4000);
  assert.ok(Object.values(vars).every(value => Buffer.byteLength(value) < 2000));
  const serialized = fs.readFileSync(file, 'utf8');
  assert.ok(Buffer.byteLength(serialized) > 100000);
  assert.equal(serialized.includes('{{'), false); assert.equal(serialized.includes('HOST_FILE_MUST_NOT_APPEAR'), false);
  let expected;
  if (role === 'task') {
    const repair = JSON.parse(fs.readFileSync(path.join(f.artifacts, 'repair.json'), 'utf8'));
    expected = repairView(f.input, repair); expected.repair.retirement_binding = retirementBinding(f.input, f.trees);
  } else {
    expected = structuredClone(f.input);
    delete expected.help; delete expected.claim_revision; delete expected.claim_revisions; delete expected.schema.types.unused;
  }
  expected.develop_trees = {repo: {path: f.trees.repo.path, sha: f.trees.repo.sha}};
  assert.deepEqual(JSON.parse(serialized), JSON.parse(JSON.stringify(expected)));
  assert.equal(fs.readFileSync(path.join(f.artifacts, 'input.json'), 'utf8'), original);
  assert.equal(fs.existsSync(file + '.tmp'), false);
  assert.equal(fs.existsSync(path.join(f.artifacts, 'operations.json')), false);
});

test('assembled author and critic prompts stay within 1024 characters including the engine protocol for large AC and repair reworks', t => {
  const definition = Bun.YAML.parse(workflow);
  const payload = 'MUST_STAY_IN_FILE_' + 'я🧪'.repeat(60000) + '{{file:/no-inline-file}}';
  for (const role of ['ac', 'task']) {
    const f = fixture(t, role);
    f.input.selected.document.data.body += payload;
    f.input.references.sources[0].document.data.body = payload;
    f.write('input.json', f.input);
    const contracts = {author: {content: payload}, critic: {content: payload}};
    fs.writeFileSync(path.join(f.root, 'contracts-source.json'), JSON.stringify(contracts));
    const result = f.run(); assert.equal(result.status, 0, result.stderr);
    const vars = {...updates(result.stdout), author_contract: payload, critic_contract: payload, draft: payload,
      critique: payload, check: payload, draft_digest: 'a'.repeat(64)};
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.artifacts, 'contracts.json'))), contracts);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.artifacts, 'tasker-limits.json'))),
      {max_files: 8, max_changed_lines: 300, migration_size_exempt: true, finding_criteria: ['G', 'A', 'U', 'M', 'V', 'R']});
    const authorManifest = JSON.parse(fs.readFileSync(path.join(f.artifacts, 'tasker_author-files.json')));
    const criticManifest = JSON.parse(fs.readFileSync(path.join(f.artifacts, 'tasker_critic-files.json')));
    assert.deepEqual(authorManifest.roots, [f.trees.repo.path]);
    assert.deepEqual(criticManifest.roots, [f.trees.repo.path]);
    const authorFiles = authorManifest.files, criticFiles = criticManifest.files;
    assert.ok(authorFiles.includes(path.join(f.artifacts, 'critic-feedback.json')));
    assert.ok(!criticFiles.includes(path.join(f.artifacts, 'critic-feedback.json')));
    for (const files of [authorFiles, criticFiles]) {
      assert.ok(files.every(file => path.isAbsolute(file)));
      assert.ok(files.every(file => !/critic-(?:codex|second)\.json$/.test(file)));
    }
    assert.match(definition.nodes.author.pre, /agentArgs\("claude-code", process.env.tasker_author_reader_config\)/);
    assert.ok(definition.nodes.author.agent.args.includes('{{var:tasker_author_arg13:-}}'));
    assert.match(definition.nodes.critics.inputs.shell, /seats "\$tasker_critic_reader_config" "\$tasker_critic_reader_home"/);
    assert.ok(definition.nodes.critics.agent.args.includes('{{input.a13:-}}'));
    const cbm = JSON.parse(fs.readFileSync(path.join(f.artifacts, 'tasker-base-mcp.json'))).mcpServers['codebase-memory'];
    assert.equal(cbm.enabled_tools.length, 10);
    assert.deepEqual(cbm.disabled_tools, ['index_repository', 'delete_project', 'manage_adr', 'ingest_traces']);
    const pre = spawnSync('bash', ['-c', definition.nodes.author.pre], {encoding: 'utf8',
      env: {...f.env, tasker_author_reader_config: vars.tasker_author_reader_config}});
    assert.equal(pre.status, 0, pre.stderr);
    const args = updates(pre.stdout);
    assert.equal(args.tasker_author_arg4, vars.tasker_author_reader_config);
    assert.equal(args.tasker_author_arg5, '--tools=');
    for (const round of [1, 2, 4]) {
      if (round > 1) for (const name of ['draft.json', 'check.json', 'critic-feedback.json']) f.write(name, {body: payload});
      for (const seat of ['author', 'codex', 'second']) {
        const template = definition.nodes[seat === 'author' ? 'author' : 'critics'].prompt;
        assert.deepEqual([...template.matchAll(/\{\{var:([A-Za-z_]+)\}\}/g)].map(match => match[1]),
          seat === 'author' ? ['tasker_item_address'] : ['tasker_item_address', 'tasker_draft_path']);
        assert.doesNotMatch(template, /\{\{file:|\{\{var:(?:draft|check|critique|author_contract|critic_contract)\}\}/);
        const assembled = template.replace(/\{\{var:([A-Za-z_]+)\}\}/g, (_, key) => {
          assert.equal(typeof vars[key], 'string', key); return vars[key];
        });
        assert.ok([...assembled].length + 586 <= 1024, `${role} ${seat} round ${round}: ${[...assembled].length}`);
        assert.doesNotMatch(assembled, /\{\{|MUST_STAY_IN_FILE_|Author contract|Critic contract/);
        assert.ok(assembled.includes(f.input.selected.address));
        for (const file of ['contracts.json', 'tasker-assignment.json', 'tasker-limits.json', 'check.json', 'critic-feedback.json', 'draft-digest.txt']) {
          assert.equal(assembled.includes(file), false, file);
        }
        assert.doesNotMatch(assembled, /prompts\/(?:author|critic)\.md/);
        if (seat === 'author') assert.equal(assembled.includes(f.artifacts), false);
        else assert.ok(assembled.includes(path.join(f.artifacts, 'draft.json')));
        if (seat !== 'author') assert.doesNotMatch(assembled, /critic-(?:codex|second)\.json/);
      }
    }
    const capture = path.join(f.root, 'capture.mjs');
    fs.writeFileSync(capture, `import fs from 'node:fs';import path from 'node:path';
if(process.env.CAPTURE_FAIL==='true')process.exit(7);
const name=process.argv[3],value=JSON.parse(fs.readFileSync(path.join(process.env.MEDULLA_RUN_DIR,'contracts-source.json'),'utf8'));
fs.writeFileSync(path.join(process.env.MEDULLA_RUN_DIR,'artifacts',name+'.json'),JSON.stringify(value));
console.log('<signal:var key='+name.replaceAll('-','_')+'>'+JSON.stringify(value)+'</signal:var>');
console.log('<signal:CAPTURED>Saved.</signal:CAPTURED>');`);
    for (const seat of ['author', 'codex', 'second']) {
      const node = definition.nodes[seat === 'author' ? 'author' : 'critics'];
      const env = {...f.env, PLANNING_PYTHON: process.execPath, CREW_FLOW_STAGES: capture, MEDULLA_INPUT: JSON.stringify({slug: seat})};
      const saved = spawnSync('bash', ['-c', node.post], {env, encoding: 'utf8'});
      assert.equal(saved.status, 0, saved.stderr);
      assert.match(saved.stdout, /<signal:CAPTURED>/);
      assert.doesNotMatch(saved.stdout, /<signal:var|MUST_STAY_IN_FILE_/);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.artifacts, (seat === 'author' ? 'draft' : 'critic-' + seat) + '.json'))), contracts);
      const failed = spawnSync('bash', ['-c', node.post], {env: {...env, CAPTURE_FAIL: 'true'}, encoding: 'utf8'});
      assert.equal(failed.status, 7);
      assert.doesNotMatch(failed.stdout, /<signal:CAPTURED>/);
    }
  }
  assert.doesNotMatch(workflow, /\{\{var:tasker_assignment\}\}|key=tasker_assignment>/);
});

test('the shared producer guard runs before the private filter unless inline output is disabled', t => {
  const f = fixture(t), env = {...f.env, FLOW_ASSIGNMENT_INLINE: 'true'};
  f.input.selected.document.data.body = 'я'.repeat(51000); f.write('input.json', f.input);
  const oversized = spawnSync('sh', [f.stages, 'prepare'], {encoding: 'utf8', env});
  assert.equal(oversized.status, 2); assert.match(oversized.stderr, /context too large/);
  f.input.selected.document.data.body = '</signal:var>'; f.write('input.json', f.input);
  const reserved = spawnSync('sh', [f.stages, 'prepare'], {encoding: 'utf8', env});
  assert.equal(reserved.status, 2); assert.match(reserved.stderr, /reserved signal delimiter/);
  const prepared = f.run(); assert.equal(prepared.status, 0, prepared.stderr);
  assert.match(prepared.stdout, /<signal:READY_TO_WRITE>/);
});

test('an active Task keeps its existing release route without creating context or trees', t => {
  const f = fixture(t); f.input.children.push(object('task:active', 'Active work'));
  f.input.children.at(-1).document.data.stage = 'in_progress'; f.write('input.json', f.input);
  const result = f.run(); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /<signal:ACTIVE>/);
  assert.equal(Object.hasOwn(updates(result.stdout), 'tasker_assignment_path'), false);
  assert.equal(fs.existsSync(path.join(f.artifacts, 'tasker-assignment.json')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'trees-called')), false);
  const publication = JSON.parse(fs.readFileSync(path.join(f.artifacts, 'operations.json'), 'utf8'));
  assert.deepEqual(publication.operations, []); assert.equal(publication.outcome.reason_code, 'LIVE_TASK');
});

test('a blocked shared prepare keeps its signal without creating an assignment', t => {
  const f = fixture(t); f.env.PREPARE_BLOCKED = 'true';
  const result = f.run(); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /<signal:BLOCKED>/);
  assert.doesNotMatch(result.stdout, /<signal:READY_TO_WRITE>/);
  assert.equal(fs.existsSync(path.join(f.artifacts, 'tasker-assignment.json')), false);
});

test('a failed repair leaves the prior assignment intact and emits no assignment path', t => {
  const f = fixture(t, 'task'), file = path.join(f.artifacts, 'tasker-assignment.json');
  fs.writeFileSync(file, '{"prior":true}'); fs.writeFileSync(path.join(f.root, 'pinned.json'), '{"address":"ac:other"}');
  const result = f.run(); assert.equal(result.status, 2);
  assert.match(result.stderr, /pinned AC read returned another address/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"prior":true}');
  assert.equal(Object.hasOwn(updates(result.stdout), 'tasker_assignment_path'), false);
});


test('active work stops before the shared AC claim, without trees or models', t => {
  const f = fixture(t); f.env.COMPLETION_BLOCKED='true';
  const before=fs.readFileSync(path.join(f.artifacts,'input.json'),'utf8');
  const result=f.run();assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/<signal:BLOCKED>/);
  assert.equal(fs.existsSync(path.join(f.root,'shared-prepare-called')),false);
  assert.equal(fs.existsSync(path.join(f.root,'trees-called')),false);
  assert.equal(fs.readFileSync(path.join(f.artifacts,'input.json'),'utf8'),before);
});

test('crew m_49e4475b: a machine-check return uses its own bounded counter and keeps the critic round', t => {
  const shell = Bun.YAML.parse(workflow).nodes.draft_check.shell;
  assert.equal(Bun.YAML.parse(workflow).vars.check_round, '1');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tasker-check-round-')); t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const artifacts = path.join(root, 'artifacts'); fs.mkdirSync(artifacts);
  fs.writeFileSync(path.join(root, 'check.mjs'), "import fs from 'node:fs';fs.writeFileSync(process.argv[2]+'/check.json',JSON.stringify({problems:['too large']}));process.exit(1);");
  const run = vars => spawnSync('bash', ['-c', shell], {encoding: 'utf8',
    env: {...process.env, MEDULLA_RUN_DIR: root, MEDULLA_WORKFLOW_DIR: root, REWORK_LIMIT: '3', ...vars}});
  for (const [vars, signal, next] of [[{round: '9', check_round: '1'}, 'REVISE', '2'], [{round: '1', check_round: '3'}, 'REVISE', '4'],
    [{round: '1', check_round: '4'}, 'REJECTED', null], [{round: '1'}, 'REVISE', '2']]) {
    const result = run(vars); assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp('<signal:' + signal + '>'));
    assert.doesNotMatch(result.stdout, /key=round>/);
    if (next) assert.match(result.stdout, new RegExp('<signal:var key=check_round>' + next + '</signal:var>'));
  }
  assert.match(fs.readFileSync(path.join(artifacts, 'failure.txt'), 'utf8'), /too large/);
});
