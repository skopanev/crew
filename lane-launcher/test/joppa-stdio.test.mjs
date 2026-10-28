import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync, spawnSync} from 'node:child_process';
import {callJoppa} from '../joppa-api.mjs';
import {contractDigest, taskInput} from '../joppa.mjs';
import {taskContract} from '../task-contract.mjs';

test('Python publication and Dolber preserve the full structured contract through the coder input', t => {
  const f = fixture(t);
  const folder = fileURLToPath(new URL('../../planning-joppa/tests/', import.meta.url));
  const source = `import sys,json
sys.path.insert(0,sys.argv[1])
import test_provider as fixture
value=fixture.plan()
value['tasks'][0]['steps']=['Preserve the required behavior. '+('🙂'*220)]*5
ops=fixture.publication.operations(value,fixture.assignment())
data=ops[0]['command']['data']
print(json.dumps({'data':data,'body':fixture.context.task_contract(data)}))
`;
  const {data, body} = JSON.parse(execFileSync(process.env.PLANNING_PYTHON || 'python3', ['-c', source, folder], {encoding: 'utf8'}));
  assert([...body].length > 1024);
  assert.equal(taskContract(data), body);
  const object = {address: 'work:one', historical: false, current_revision: 1,
    document: {present: true, parent: 'criterion:a', links: [], data}};
  const config = {repositories: [{id: 'service', modules: [{name: 'core', path: 'src'}]}]};
  const before = contractDigest(object), ticket = taskInput(config, object).ticket;
  assert.equal(ticket.body, body);
  assert.equal(ticket.acceptance, body);
  assert.equal(contractDigest(object), before);
  const artifacts = path.join(f.root, 'artifacts'); fs.mkdirSync(artifacts);
  fs.writeFileSync(path.join(artifacts, 'claim.json'), JSON.stringify({source: 'joppa', workspace: 'sample', ticket}));
  const helper = fileURLToPath(new URL('../../lane/bin/ticket-input.mjs', import.meta.url));
  execFileSync(process.execPath, [helper], {env: {...process.env, MEDULLA_RUN_DIR: f.root,
    ticket_id: ticket.id, project_name: 'sample'}});
  assert.equal(JSON.parse(fs.readFileSync(path.join(artifacts, 'ticket.json'), 'utf8')).body, body);
  assert.equal(taskContract({contract: body}), body);
  for (const bad of [{...data, steps: null}, {...data, repository: undefined}, {...data, checks: []}]) {
    assert.throws(() => taskContract(bad), /Structured Task/);
  }
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-mcp-check-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const script = path.join(root, 'connector.mjs'), calls = path.join(root, 'calls');
  fs.writeFileSync(script, `
import fs from 'node:fs';
import {createInterface} from 'node:readline';
let initialized=false;
console.log('');
for await(const line of createInterface({input:process.stdin})) {
 const r=JSON.parse(line);
 if(!('id' in r))continue;
 let result;
 if(r.method==='initialize'){initialized=true;result={protocolVersion:'2025-03-26',capabilities:{tools:{}}};}
 else if(!initialized){process.exit(3);}
 else if(r.method==='tools/list')result={tools:[{name:'joppa_tree',inputSchema:{type:'object',properties:{workspace:{type:'string'}}}},{name:'joppa_command',inputSchema:{type:'object'}}]};
 else {
  fs.appendFileSync(process.argv[2],JSON.stringify(r.params)+'\\n');
  if(r.params.name==='lost_write')process.exit(4);
  result=r.params.name==='refused'?{isError:true,structuredContent:{error:'Confirmed refusal'}}:
   {structuredContent:{workspace:r.params.arguments.workspace,schema:{types:{}},actor:'existing-user'}};
  if(process.argv[3]) {
   const state=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
   const value=r.params.name==='joppa_tree'?state.tree:state.objects[r.params.arguments.address];
   result=value?{structuredContent:value}:{isError:true,structuredContent:{error:'Object unavailable'}};
  }
 }
 console.log(JSON.stringify({jsonrpc:'2.0',method:'notifications/message',params:{}}));
 console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result}));
}
`);
  return {root, calls, command: [process.execPath, script, calls]};
}

test('host MCP reads need no bearer file and a lost write is never repeated', async t => {
  const f = fixture(t), options = {mcpCommand: f.command}, url = 'https://service.invalid/mcp';
  const value = await callJoppa(url, undefined, 'joppa_tree', {workspace: 'sample'}, options);
  assert.equal(value.actor, 'existing-user');
  await assert.rejects(callJoppa(url, undefined, 'refused', {}, options), error => error.rejected === true);
  await assert.rejects(callJoppa(url, undefined, 'lost_write', {}, options), error => error.rejected !== true);
  const calls = fs.readFileSync(f.calls, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(call => call.name === 'lost_write').length, 1);
});

test('normal landing rechecks native MCP dependencies before pushing', t => {
  const f = fixture(t), stateFile = path.join(f.root, 'state.json');
  const command = [...f.command, stateFile];
  const make = (address, parent) => ({address, kind: address.split(':')[0], historical: false,
    workspace_key: 'local', current_revision: 1, work_ready: true, review_required: false,
    document: {present: true, parent, links: [], data: {title: address}}, process: {}});
  const parent = make('measure:a', null), task = make('work:one', parent.address);
  task.process = {status: 'in_progress', assignee: 'worker'};
  const link = {workspace: 'remote', target: 'measure:a', relation: 'depends_on', blocking: true, revision: 2,
    status: {access: true, present: true, current_revision: 2, review_required: false, satisfied: true}};
  parent.remote_links = [link];
  parent.remote_links_revision = 1;
  const state = {tree: {workspace_key: 'local', schema: {types: {
    measure: {role: 'ac', parents: []}, work: {role: 'task', parents: ['measure']}}}},
    objects: {[task.address]: task, [parent.address]: parent}};
  const artifacts = path.join(f.root, 'run/artifacts');
  fs.mkdirSync(artifacts, {recursive: true});
  fs.writeFileSync(path.join(artifacts, 'claim.json'), JSON.stringify({source: 'joppa', workspace: 'sample',
    joppa_url: 'https://service.invalid/mcp', actor: 'worker',
    tasks: [{address: task.address, digest: contractDigest(task)}],
    contexts: [{address: parent.address, digest: contractDigest(parent)}]}));
  const env = {...process.env, MEDULLA_RUN_DIR: path.dirname(artifacts),
    JOPPA_READER_COMMAND_JSON: JSON.stringify(command), REQUIREMENT_READER_FILE: '', DELIVERY: 'target'};
  const checker = fileURLToPath(new URL('../../lane/bin/requirement-current.mjs', import.meta.url));
  const check = () => {
    fs.writeFileSync(stateFile, JSON.stringify(state));
    return spawnSync(process.execPath, [checker, '--tasks'], {env, encoding: 'utf8', timeout: 10_000});
  };
  assert.equal(check().status, 0);
  for (const status of [{satisfied: false}, {access: false}, {present: false},
    {current_revision: 3}, {review_required: true}]) {
    const before = {...link.status};
    Object.assign(link.status, status);
    const result = check();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /unmet remote dependency/);
    link.status = before;
  }
  parent.remote_links_revision++;
  assert.match(check().stderr, /context changed after claim/);
  parent.remote_links_revision--;

  const repo = path.join(f.root, 'repo'), remote = path.join(f.root, 'origin.git');
  fs.mkdirSync(repo);
  Object.assign(env, {GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1', project_dir: repo,
    project_name: 'fixture', module_name: '.', ticket_id: 'fixture', gate_commands: '["true"]'});
  const run = (executable, args) => execFileSync(executable, args,
    {cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000}).trim();
  const git = args => run('git', args);
  git(['init', '-q', '-b', 'develop']);
  git(['config', 'user.name', 'Test']); git(['config', 'user.email', 'test@example.invalid']);
  fs.writeFileSync(path.join(repo, '.ntkrc'), '{"target_branch":"develop"}\n');
  git(['add', '.']); git(['commit', '-qm', 'base']);
  git(['init', '--bare', '-q', remote]); git(['remote', 'add', 'origin', remote]);
  git(['push', '-q', 'origin', 'HEAD:develop']);
  const before = git(['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(repo, 'code'), 'candidate\n');
  git(['add', '.']); git(['commit', '-qm', 'candidate']);
  const lane = fileURLToPath(new URL('../../lane/', import.meta.url));
  run('python3', [path.join(lane, 'bin/gates.py'), 'run']);
  link.status.satisfied = false;
  fs.writeFileSync(stateFile, JSON.stringify(state));
  const refused = spawnSync('bash', [path.join(lane, 'bin/land.sh'), 'develop'],
    {cwd: repo, env, encoding: 'utf8', timeout: 10_000});
  assert.notEqual(refused.status, 0, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /unmet remote dependency/);
  assert.equal(git(['ls-remote', 'origin', 'refs/heads/develop']).split(/\s/)[0], before);
  link.status.satisfied = true;
  fs.writeFileSync(stateFile, JSON.stringify(state));
  run('bash', [path.join(lane, 'bin/land.sh'), 'develop']);
  assert.equal(git(['ls-remote', 'origin', 'refs/heads/develop']).split(/\s/)[0], git(['rev-parse', 'HEAD']));
  assert(fs.readFileSync(f.calls, 'utf8').trim().split('\n').map(JSON.parse)
    .every(call => ['joppa_tree', 'joppa_objects'].includes(call.name)));
});

test('the planner reader uses native MCP for authorized workspaces and refuses mutations', t => {
  const f = fixture(t);
  const folder = fileURLToPath(new URL('../../planning-joppa/', import.meta.url));
  const code = `import json,sys
sys.path.insert(0,sys.argv[1])
from mcp import Joppa,Reader,MCPError
api=Joppa('https://service.invalid/mcp',mcp_command=json.loads(sys.argv[2]))
reader=Reader(api,'sample',None)
assert [tool['name'] for tool in reader.tools()]==['joppa_tree']
assert reader.call('joppa_tree',{})['actor']=='existing-user'
assert reader.call('joppa_tree',{'workspace':'other'})['workspace']=='other'
for name,args in [('joppa_command',{})]:
 try: reader.call(name,args)
 except MCPError: pass
 else: raise AssertionError('Reader accepted a forbidden call')
api.stdio.close()
`;
  const result = spawnSync(process.env.PLANNING_PYTHON || 'python3', ['-c', code, folder, JSON.stringify(f.command)],
    {encoding: 'utf8', timeout: 10_000});
  assert.equal(result.status, 0, result.stderr);
  const calls = fs.readFileSync(f.calls, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map(call => [call.name, call.arguments.workspace]),
    [['joppa_tree', 'sample'], ['joppa_tree', 'other']]);
});
