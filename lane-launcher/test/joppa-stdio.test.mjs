import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {callJoppa} from '../joppa-api.mjs';

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

test('the planner reader uses native MCP and still refuses mutations and other workspaces', t => {
  const f = fixture(t);
  const folder = fileURLToPath(new URL('../../planning-joppa/', import.meta.url));
  const code = `import json,sys
sys.path.insert(0,sys.argv[1])
from mcp import Joppa,Reader,MCPError
api=Joppa('https://service.invalid/mcp',mcp_command=json.loads(sys.argv[2]))
reader=Reader(api,'sample',None)
assert [tool['name'] for tool in reader.tools()]==['joppa_tree']
assert reader.call('joppa_tree',{})['actor']=='existing-user'
for name,args in [('joppa_command',{}),('joppa_tree',{'workspace':'other'})]:
 try: reader.call(name,args)
 except MCPError: pass
 else: raise AssertionError('Reader accepted a forbidden call')
api.stdio.close()
`;
  const result = spawnSync(process.env.PLANNING_PYTHON || 'python3', ['-c', code, folder, JSON.stringify(f.command)],
    {encoding: 'utf8', timeout: 10_000});
  assert.equal(result.status, 0, result.stderr);
  const calls = fs.readFileSync(f.calls, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map(call => call.name), ['joppa_tree']);
});
