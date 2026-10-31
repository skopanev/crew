import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function fixture(t) {
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
   let value=r.params.name==='joppa_tree'?state.tree:
    state.responses?.[r.params.name] ?? state.objects[r.params.arguments.address];
   if(state.compact && r.params.name==='joppa_objects' && value?.document) {
    value=structuredClone(value);
    const comments=Object.entries(value.annotations?.comments || {}).map(([id,c])=>({id,...c}));
    if(value.annotations) delete value.annotations.comments;
    for(const key of ['kind','id','item_id','historical','revision_count','metadata_scope']) delete value[key];
    if(value.contract_revision===value.current_revision) delete value.contract_revision;
    if(value.process?.assignee===null) delete value.process.assignee;
    if(!Object.keys(value.process || {}).length) delete value.process;
    if(!Object.keys(value.annotations || {}).length) delete value.annotations;
    const start=Number(r.params.arguments.comments_cursor || 0);
    if(comments.length) value.comments={items:comments.slice(start,start+25),total:comments.length,
      ...(start+25<comments.length?{next_cursor:String(start+25)}:{})};
    if(start && state.commentDrift) value.position++;
    if(start && state.commentObjectDrift) value.document.data.title='Changed';
   }
   if(state.flat && r.params.name==='joppa_objects' && value?.document) {
    const doc=value.document;
    value={...value,revision:doc.revision,parent:doc.parent,data:doc.data,
      ...(doc.present===false?{present:false}:{}),
      links:doc.links.map(link=>({...link,title:'Current target title',current_revision:99}))};
    for(const key of ['address','document','current_revision','position','workspace','workspace_key']) delete value[key];
    if(value.review_required===false) delete value.review_required;
    if(value.work_ready===true) delete value.work_ready;
    if(value.remote_links_revision===0) delete value.remote_links_revision;
    if(value.annotations) delete value.annotations;
   }
   if(state.flat && r.params.name==='joppa_tests' && value) {
    value=structuredClone(value);
    if(r.params.arguments.ac && !r.params.arguments.ac.includes(',')) delete value.address;
   }
   if(state.flat && r.params.name==='joppa_tasks' && value?.tasks) {
    value={...value,items:value.tasks};delete value.tasks;
   }
   result=value?{structuredContent:value}:{isError:true,structuredContent:{error:'Object unavailable'}};
  }
 }
 console.log(JSON.stringify({jsonrpc:'2.0',method:'notifications/message',params:{}}));
 console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result}));
}
`);
  return {root, calls, command: [process.execPath, script, calls]};
}
