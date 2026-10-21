import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {execFileSync, spawn} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {confirmed, corrected, findingKey, hash, parseReport, source, validate} from '../common.mjs';
import {prepare, publish, recheck, verifySearches as verifySpecificationSearches} from '../../audit-joppa/adapter.mjs';
import {preflight, verifySearches} from '../cbm.mjs';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-audit-test-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const repo = path.join(root, 'source'); fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'package.json'), '{"type":"module"}\n');
  fs.writeFileSync(path.join(repo, 'access.js'), 'export function allowed() {\n  return true;\n}\n'
    + "export function reportRoute(path) {\n  return path === '/legacy-export' ? {body: 'report'} : null;\n}\n");
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], {encoding: 'utf8'}).trim();
  git('init', '-q'); git('add', '.');
  git('-c', 'user.name=fixture', '-c', 'user.email=fixture@invalid', 'commit', '-qm', 'source fixture');
  const schema = {types: {
    outcome: {role: 'requirement', root: true},
    measure: {role: 'ac', parents: ['outcome']},
    incoming: {role: 'document', root: true, inbox: true, question: 'What discrepancy was observed?'}
  }};
  const object = (address, data, parent = null) => ({address, kind: address.split(':')[0],
    historical: false, current_revision: 1, document: {data, parent, links: [], present: true}});
  const objects = new Map([
    ['outcome:access', object('outcome:access', {title: 'Access', body: 'Only the owner can read.', owner: 'person'})],
    ['measure:private', object('measure:private', {title: 'Owner access', description: 'A non-owner receives refusal.', owner: 'person'}, 'outcome:access')]
  ]);
  const calls = [];
  let loseReply = false, rejectBatch = false;
  const server = http.createServer(async (request, response) => {
    if (request.method === 'DELETE') { response.end(); return; }
    let body = ''; for await (const part of request) body += part;
    const rpc = JSON.parse(body);
    let result;
    if (rpc.method === 'initialize') result = {protocolVersion: '2025-03-26', capabilities: {}, serverInfo: {name: 'fixture', version: '1'}};
    else if (rpc.method === 'notifications/initialized') { response.end(); return; }
    else {
      const {name, arguments: args} = rpc.params;
      calls.push({name, args});
      let value;
      if (name === 'joppa_tree') value = {schema};
      else if (name === 'joppa_objects') {
        if (args.address) value = objects.get(args.address);
        else value = {items: [...objects.values()].filter(item => !args.kind || item.kind === args.kind)
          .map(item => ({address: item.address, kind: item.kind, parent: item.document.parent,
            present: item.document.present, revision: item.current_revision})), next_cursor: null};
      } else if (name === 'joppa_batch') {
        if (rejectBatch) {
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({jsonrpc: '2.0', id: rpc.id,
            result: {isError: true, structuredContent: {error: 'Rejected fixture publication'}}}));
          return;
        }
        value = {results: args.operations.map(({command: op}) => {
          assert.equal(op.op, 'save_object'); assert.equal(op.kind, 'incoming');
          assert.equal(op.question_checked, schema.types.incoming.question);
          assert.ok([...op.data.title].length <= (schema.types.incoming.title_preview_length ?? 64));
          assert.equal(new Set(op.links.map(link => `${link.target}:${link.relation}`)).size, op.links.length);
          const address = `${op.kind}:${op.id}`;
          objects.set(address, object(address, op.data, op.parent));
          return {command: {op: 'save_object'}, address, saved_revision: 1};
        })};
        if (loseReply) { response.destroy(); return; }
      } else throw new Error(`Unexpected mutation or tool: ${name}`);
      result = {content: [{type: 'text', text: JSON.stringify(value)}], structuredContent: value};
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({jsonrpc: '2.0', id: rpc.id, result}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const token = path.join(root, 'user-token'); fs.writeFileSync(token, 'fixture-only');
  const config = {url: `http://127.0.0.1:${server.address().port}`, token_file: token, workspace: 'fixture', project: 'fixture',
    repositories: [{id: 'backend', path: repo, cbm_project: 'backend-index'}], inbox: {kind: 'incoming', owner: 'person'}};
  const input = await prepare(config);
  input.repositories = config.repositories.map(repo => ({...repo, head: source(repo)}));
  const finding = {id: 'access', kind: 'contradiction', title: 'Non-owner reads private data',
    actual: 'Every caller is allowed.', required: 'Only the owner is allowed.', impact: 'Private data is exposed.',
    code: [{repository: 'backend', path: 'access.js', line: 2, quote: '  return true;'}],
    spec: [{address: 'outcome:access', revision: 1, quote: 'Only the owner can read.'}]};
  const report = {inspected: [{repository: 'backend', path: 'access.js'}], limitations: [], findings: [finding]};
  return {root, repo, config, input, finding, report, objects, calls, schema,
    loseReply: () => { loseReply = true; }, rejectBatch: value => { rejectBatch = value; }};
}

test('missing implementation cannot become an inbox finding', async t => {
  const f = await fixture(t);
  assert.throws(() => validate({...f.report, findings: [{...f.finding, kind: 'missing'}]}, f.input), /Only implemented/);
  const empty = validate({...f.report, findings: []}, f.input);
  assert.deepEqual(await publish(f.config, empty.findings, f.input, path.join(f.root, 'run')), {published: [], reused: []});
  assert.equal(f.calls.filter(call => call.name === 'joppa_batch').length, 0);
});

test('invented source, stale spec and unsupported finding kinds are rejected', async t => {
  const f = await fixture(t);
  for (const change of [
    {code: [{...f.finding.code[0], quote: '  return false;'}]},
    {spec: [{...f.finding.spec[0], revision: 2}]},
    {kind: 'unrequested-helper'}
  ]) assert.throws(() => validate({...f.report, findings: [{...f.finding, ...change}]}, f.input));
  assert.throws(() => validate({...f.report, inspected: [{repository: 'backend', path: '../user-token'}]}, f.input), /path|escapes/);
});

test('independent review must cover each finding and can dismiss it', async t => {
  const f = await fixture(t);
  assert.deepEqual(confirmed(f.report, {verdicts: [{id: 'access', verdict: 'dismissed', reason: 'The cited path is not reachable.'}]}), []);
  assert.throws(() => confirmed(f.report, {verdicts: []}), /every finding/);
  assert.throws(() => confirmed(f.report, {verdicts: [{id: 'another', verdict: 'confirmed', reason: 'Claim'}]}), /Invalid/);
});

test('an audit correction cannot silently lose a proposed finding', () => {
  const previous = {findings: [{id: 'first'}, {id: 'second'}]};
  const report = {findings: [{id: 'first'}], limitations: []};
  assert.throws(() => corrected(report, previous), /withdrawal of finding second/);
  assert.throws(() => corrected({...report, limitations: ['Withdrawn second: ']}, previous), /withdrawal/);
  corrected({...report, limitations: ['Withdrawn second: The quotation is absent from the current specification.']}, previous);
  corrected({findings: previous.findings, limitations: []}, previous);
  corrected(report, undefined);
});

function uncovered(f) {
  return {id: 'legacy-export', kind: 'uncovered', title: 'Public export has no requirement',
    actual: 'The legacy export route returns a public report.', impact: 'A public feature has no specification owner decision.',
    code: [{repository: 'backend', path: 'access.js', line: 5,
      quote: "  return path === '/legacy-export' ? {body: 'report'} : null;"}],
    spec: [], spec_searches: ['legacy export report'], why_uncovered: 'Current requirements describe access control and do not describe report export.',
    decision: 'Should the owner specify, change or remove this public export?'};
}

test('observable behavior without a requirement can enter the inbox as an owner decision', async t => {
  const f = await fixture(t), finding = uncovered(f);
  const {reportRoute} = await import(pathToFileURL(path.join(f.repo, 'access.js')));
  assert.equal(reportRoute('/legacy-export').body, 'report');
  validate({...f.report, findings: [finding]}, f.input);
  const result = await publish(f.config, [finding], f.input, path.join(f.root, 'run'));
  const note = f.objects.get(result.published[0]).document.data;
  assert.match(note.body, /Kind: uncovered/);
  assert.match(note.body, /Owner decision: Should/);
  assert.match(note.body, /Specification snapshot:/);
  assert.doesNotMatch(note.body, /Required: undefined/);
});

test('an incomplete specification cannot prove that a behavior has no requirement', async t => {
  const f = await fixture(t);
  f.config.roots = ['outcome:access'];
  const partial = {...await prepare(f.config), repositories: f.input.repositories};
  assert.throws(() => validate({...f.report, findings: [uncovered(f)]}, partial), /Partial specification/);
  await assert.rejects(recheck(f.config, f.input, [uncovered(f)]).then(async () => {
    f.objects.get('measure:private').annotations = {comments: [{text: 'The owner approves the export.'}]};
    await recheck(f.config, f.input, [uncovered(f)]);
  }), /owner context changed/);
});

test('both stages must actually search the full specification before declaring uncovered behavior', async t => {
  const f = await fixture(t), finding = uncovered(f);
  const call = {type: 'item.completed', item: {type: 'mcp_tool_call', server: 'joppa', tool: 'joppa_search',
    status: 'completed', arguments: {workspace: 'fixture', query: finding.spec_searches[0]}}};
  verifySpecificationSearches([call], 'codex', [finding], f.input);
  verifySpecificationSearches([{...call, item: {...call.item,
    arguments: {query: finding.spec_searches[0]}}}], 'codex', [finding], f.input);
  assert.throws(() => verifySpecificationSearches([{...call, item: {...call.item,
    arguments: {...call.item.arguments, workspace: 'another-workspace'}}}], 'codex', [finding], f.input), /whole-workspace/);
  assert.throws(() => verifySpecificationSearches([], 'codex', [finding], f.input), /whole-workspace/);
  assert.throws(() => verifySpecificationSearches([{...call, item: {...call.item,
    arguments: {...call.item.arguments, kind: 'measure'}}}], 'codex', [finding], f.input), /whole-workspace/);
  const uses = [{type: 'assistant', message: {content: [{type: 'tool_use', id: 'spec-search',
    name: 'mcp__joppa__joppa_search', input: call.item.arguments}]}},
  {type: 'user', message: {content: [{type: 'tool_result', tool_use_id: 'spec-search', content: 'No matching requirement'}]}}];
  verifySpecificationSearches(uses, 'claude-code', [finding], f.input);
});

test('only configured inbox documents are created and a repeated audit reuses them', async t => {
  const f = await fixture(t);
  validate(f.report, f.input);
  await recheck(f.config, f.input);
  const first = await publish(f.config, [f.finding], f.input, path.join(f.root, 'run'));
  assert.equal(first.published.length, 1);
  const saved = f.objects.get(first.published[0]);
  assert.equal(saved.kind, 'incoming'); assert.equal(saved.document.data.owner, 'person');
  assert.equal(saved.document.data.status, 'unprocessed');
  assert.match(saved.document.data.body, /Actual: Every caller/);
  assert.match(saved.document.data.body, /Source commits: backend=/);
  const second = await publish(f.config, [{...f.finding, title: 'Another wording'}], f.input, path.join(f.root, 'another-run'));
  assert.deepEqual(second.reused, first.published);
  assert.equal(f.calls.filter(call => call.name === 'joppa_batch').length, 1);
  await recheck(f.config, f.input);
});

test('two quotations from one specification object produce one link', async t => {
  const f = await fixture(t);
  const finding = {...f.finding, spec: [...f.finding.spec, {...f.finding.spec[0], quote: 'owner can read.'}]};
  validate({...f.report, findings: [finding]}, f.input);
  await publish(f.config, [finding], f.input, path.join(f.root, 'run'));
  assert.equal(f.calls.find(call => call.name === 'joppa_batch').args.operations[0].command.links.length, 1);
});

test('inbox schema supplies the title limit in Unicode characters', async t => {
  const f = await fixture(t);
  assert.equal(f.input.title_limit, 64);
  assert.throws(() => validate({...f.report, findings: [{...f.finding, title: 'x'.repeat(65)}]}, f.input), /character limit/);
  f.schema.types.incoming.title_preview_length = 2;
  const input = {...await prepare(f.config), repositories: f.input.repositories};
  assert.equal(input.title_limit, 2);
  validate({...f.report, findings: [{...f.finding, title: '🟢🟢'}]}, input);
  assert.throws(() => validate(f.report, input), /2 character limit/);
});

test('an archived finding is not reused or overwritten', async t => {
  const f = await fixture(t);
  const result = await publish(f.config, [f.finding], f.input, path.join(f.root, 'first'));
  f.objects.get(result.published[0]).document.present = false;
  await assert.rejects(publish(f.config, [f.finding], f.input, path.join(f.root, 'second')), /archived/);
  assert.equal(f.calls.filter(call => call.name === 'joppa_batch').length, 1);
});

test('a confirmed service refusal permits an explicit corrected retry', async t => {
  const f = await fixture(t), run = path.join(f.root, 'run');
  f.rejectBatch(true);
  await assert.rejects(publish(f.config, [f.finding], f.input, run), /Rejected fixture/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(run, 'publication.json'))).status, 'rejected');
  assert.equal(f.calls.filter(call => call.name === 'joppa_batch').length, 1);
  f.rejectBatch(false);
  const corrected = {...f.finding, title: 'Corrected title'};
  assert.equal((await publish(f.config, [corrected], f.input, run)).published.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(run, 'publication.json'))).status, 'confirmed');
});

test('parent kinds and new specification objects are checked', async t => {
  const f = await fixture(t);
  f.config.inbox.parent = 'outcome:access';
  await assert.rejects(prepare(f.config), /parent/);
  f.schema.types.incoming.parents = ['outcome'];
  await prepare(f.config);
  f.schema.types.incoming.parents = ['*'];
  const input = await prepare(f.config);
  f.config.inbox.parent = 'outcome:absent';
  await assert.rejects(prepare(f.config), /parent/);
  f.config.inbox.parent = 'outcome:access';
  const current = structuredClone(f.objects.get('measure:private'));
  current.address = 'measure:added';
  f.objects.set(current.address, current);
  await assert.rejects(recheck(f.config, input), /Specification changed/);
});

test('multiline owner comments remain exact citable text', async t => {
  const f = await fixture(t), quote = 'Owner decision:\nKeep access private.';
  f.objects.get('outcome:access').annotations = {comments: [{text: quote}]};
  const input = {...await prepare(f.config), repositories: f.input.repositories};
  validate({...f.report, findings: [{...f.finding, spec: [{...f.finding.spec[0], quote}]}]}, input);
});

test('source and specification changes invalidate the audit', async t => {
  const f = await fixture(t);
  f.objects.get('outcome:access').current_revision = 2;
  await assert.rejects(recheck(f.config, f.input), /Specification changed/);
  fs.appendFileSync(path.join(f.repo, 'access.js'), '// later edit\n');
  assert.throws(() => source(f.config.repositories[0]), /dirty/);
});

test('lost publication response leaves a durable uncertain receipt', async t => {
  const f = await fixture(t), run = path.join(f.root, 'run');
  f.loseReply();
  await assert.rejects(publish(f.config, [f.finding], f.input, run), /transport/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(run, 'publication.json'))).status, 'uncertain');
  const repeated = await publish(f.config, [f.finding], f.input, path.join(f.root, 'next-run'));
  assert.equal(repeated.reused.length, 1);
  assert.equal(f.calls.filter(call => call.name === 'joppa_batch').length, 1);
});

test('owner context changes invalidate a finding even without a document revision change', async t => {
  const f = await fixture(t);
  const childFinding = {...f.finding, spec: [{address: 'measure:private', revision: 1, quote: 'A non-owner receives refusal.'}]};
  await recheck(f.config, f.input, [childFinding]);
  f.objects.get('outcome:access').annotations = {comments: [{text: 'The owner approved a different access boundary.'}]};
  await assert.rejects(recheck(f.config, f.input, [childFinding]), /owner context changed/);
  assert.equal(f.calls.filter(call => call.name === 'joppa_batch').length, 0);
});

test('finding identity ignores display wording and evidence ordering', async t => {
  const f = await fixture(t);
  assert.equal(findingKey(f.finding), findingKey({...f.finding, title: 'Another title', actual: 'Same effect'}));
});

test('both harnesses need successful CBM searches in the configured project', () => {
  const repos = [{cbm_project: 'backend-index'}];
  const call = {type: 'item.completed', item: {type: 'mcp_tool_call', server: 'codebase-memory',
    tool: 'search_graph', status: 'completed', arguments: {project: 'backend-index'}, result: {isError: false}}};
  verifySearches([call], 'codex', repos);
  assert.throws(() => verifySearches([], 'codex', repos), /CBM search/);
  assert.throws(() => verifySearches([{...call, item: {...call.item, error: 'Disconnected'}}], 'codex', repos), /CBM search/);
  assert.throws(() => verifySearches([call], 'codex', [{cbm_project: 'another-index'}]), /CBM search/);
  const use = {type: 'assistant', message: {content: [{type: 'tool_use', id: 'cbm',
    name: 'mcp__codebase-memory__search_code', input: {project: 'backend-index'}}]}};
  const result = {type: 'user', message: {content: [{type: 'tool_result', tool_use_id: 'cbm', content: 'Search result'}]}};
  verifySearches([use, result], 'claude-code', repos);
  assert.throws(() => verifySearches([use], 'claude-code', repos), /CBM search/);
  assert.throws(() => verifySearches([use, {type: 'user', message: {content: [{...result.message.content[0], is_error: true}]}}],
    'claude-code', repos), /CBM search/);
});

test('a final fenced report can follow a status sentence without accepting multiple reports', () => {
  const body = 'Review complete.\n```json\n{"verdicts":[]}\n```';
  assert.deepEqual(parseReport(body), {verdicts: []});
  assert.throws(() => parseReport(body + '\n```json\n{}\n```'), /one final JSON/);
});

test('CBM preflight rejects an unavailable shared project before agents start', async t => {
  const f = await fixture(t), binary = path.join(f.root, 'cbm');
  const config = {...f.config, cbm_command: binary, cbm_store: f.root, cbm_root: f.root};
  fs.writeFileSync(binary, `#!${process.execPath}\nconsole.log(JSON.stringify({isError:true}));\n`, {mode: 0o755});
  assert.throws(() => preflight(config), /CBM refused/);
  fs.writeFileSync(binary, `#!${process.execPath}\nconsole.log(JSON.stringify({structuredContent:{status:'ready',project:'backend-index',root_path:${JSON.stringify(f.root)}}}));\n`);
  assert.throws(() => preflight(config), /not ready/);
});

test('real Medulla audits, reviews and publishes only confirmed findings', async t => {
  const medulla = execFileSync('which', ['medulla'], {encoding: 'utf8'}).trim();
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const mode of ['contradiction', 'uncovered', 'none']) {
    const found = mode !== 'none';
    await t.test(mode, async t => {
      const f = await fixture(t), bins = path.join(f.root, 'bin');
      fs.mkdirSync(bins);
      const report = {...f.report, findings: found ? [mode === 'uncovered' ? uncovered(f) : f.finding] : []};
      fs.writeFileSync(path.join(f.root, 'report.json'), JSON.stringify(report));
      for (const name of ['codex', 'claude', 'equill', 'cbm']) {
        const script = path.join(bins, name);
        fs.writeFileSync(script, `#!${process.execPath}\n` + `
const fs = require('node:fs');
const name = require('node:path').basename(process.argv[1]);
if (name === 'cbm') {
 console.log(JSON.stringify({structuredContent:{status:'ready',project:'backend-index',root_path:require('node:path').join(process.env.CBM_ALLOWED_ROOT,'source')}}));
} else if (name === 'equill') {
 const role='crew-audit-auditor';
 const records=[{name:role,actor:role},...[10,20,30].map(step=>({process:role,step}))];
 console.log(JSON.stringify({ok:true,content:records.map(x=>JSON.stringify(x)).join('\\n\\n'),
 receipt:{projection:'ready',degraded:false,empty:false},bundle_digest:'fixture',selected_record_ids:['fixture']}));
} else {
 let prompt=''; process.stdin.on('data', part=>{prompt+=part;});
 process.stdin.resume(); process.stdin.on('end',()=>{
  fs.writeFileSync(require('node:path').join(process.env.AUDIT_TEST_PROMPTS,name),prompt);
  fs.appendFileSync(process.env.AUDIT_TEST_EVENTS,name+'\\n');
  const report=JSON.parse(fs.readFileSync(process.env.AUDIT_TEST_REPORT));
  const result=name==='codex'?report:{verdicts:report.findings.map(x=>({id:x.id,verdict:'confirmed',reason:'Both source and specification support the discrepancy.'}))};
  if(name==='codex') console.log(JSON.stringify({type:'item.completed',item:{type:'mcp_tool_call',server:'codebase-memory',tool:'search_graph',status:'completed',arguments:{project:'backend-index'},result:{isError:false}}}));
  else {
   console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id:'cbm',name:'mcp__codebase-memory__search_graph',input:{project:'backend-index'}}]}}));
   console.log(JSON.stringify({type:'user',message:{content:[{type:'tool_result',tool_use_id:'cbm',content:'Verified source result'}]}}));
  }
  for(const [index,query] of report.findings.flatMap(x=>x.spec_searches||[]).entries()) {
   if(name==='codex') console.log(JSON.stringify({type:'item.completed',item:{type:'mcp_tool_call',server:'joppa',tool:'joppa_search',status:'completed',arguments:{workspace:'fixture',query}}}));
   else {
    console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id:'spec-'+index,name:'mcp__joppa__joppa_search',input:{workspace:'fixture',query}}]}}));
    console.log(JSON.stringify({type:'user',message:{content:[{type:'tool_result',tool_use_id:'spec-'+index,content:'No matching requirement'}]}}));
   }
  }
  const fence=String.fromCharCode(96).repeat(3);
  const delivery='Review complete.\\n'+fence+'json\\n'+JSON.stringify(result)+'\\n'+fence;
  console.log(JSON.stringify(name==='codex'?{type:'item.completed',item:{type:'agent_message',text:JSON.stringify(result)}}:{type:'result',is_error:false,result:delivery}));
 });
}
`);
        fs.chmodSync(script, 0o755);
      }
      const configuration = {...f.config, equill_store: f.root, equill_actor: 'fixture',
        cbm_root: f.root, cbm_store: f.root, cbm_command: path.join(bins, 'cbm'),
        reader_toml: 'mcp_servers={}', reader_config: '{"mcpServers":{}}', reader_tools: 'Read,Grep,Glob'};
      const configFile = path.join(f.root, 'config.json'); fs.writeFileSync(configFile, JSON.stringify(configuration));
      const runs = path.join(f.root, 'runs');
      const args = ['-w', path.join(here, '..'), '--runs-folder', runs];
      const vars = {AUDIT_CONFIG: configFile, AUDIT_ADAPTER: path.join(here, '../../audit-joppa/adapter.mjs'),
        AUDIT_NO_PUBLISH: 'false', AUDIT_MODEL: 'fixture-auditor', REVIEW_MODEL: 'fixture-reviewer'};
      for (const [key, value] of Object.entries(vars)) args.push('--var', `${key}=${value}`);
      const result = await new Promise(resolve => {
        const child = spawn(medulla, args, {cwd: f.root,
          env: {...process.env, PATH: bins + path.delimiter + process.env.PATH,
            EQUILL_BIN: path.join(bins, 'equill'), MEDULLA_DOCKER: '1', MEDULLA_STREAM: '0',
            AUDIT_TEST_REPORT: path.join(f.root, 'report.json'), AUDIT_TEST_EVENTS: path.join(f.root, 'events'),
            AUDIT_TEST_PROMPTS: f.root},
          stdio: ['ignore', 'pipe', 'pipe']});
        let output = ''; child.stdout.on('data', part => { output += part; }); child.stderr.on('data', part => { output += part; });
        const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
        child.on('close', code => { clearTimeout(timer); resolve({code, output}); });
      });
      assert.equal(result.code, 0, result.output);
      const run = fs.readdirSync(runs)[0];
      const outcome = JSON.parse(fs.readFileSync(path.join(runs, run, 'artifacts/result.json')));
      assert.equal(outcome.status, 'audited'); assert.equal(outcome.acceptance_verified, false);
      assert.equal(outcome.published.length, found ? 1 : 0);
      assert.equal(f.calls.filter(call => call.name === 'joppa_batch').length, found ? 1 : 0);
      assert.deepEqual(fs.readFileSync(path.join(f.root, 'events'), 'utf8').trim().split('\n'), found ? ['codex', 'claude'] : ['codex']);
      const auditPrompt = fs.readFileSync(path.join(f.root, 'codex'), 'utf8');
      assert.match(auditPrompt, /"step":20/);
      assert.doesNotMatch(auditPrompt, /"step":30/);
      if (found) {
        const reviewPrompt = fs.readFileSync(path.join(f.root, 'claude'), 'utf8');
        assert.match(reviewPrompt, /"step":30/);
        assert.doesNotMatch(reviewPrompt, /"step":20/);
        assert.match(reviewPrompt, /Start with CBM search_graph or search_code.*backend-index/);
      }
    });
  }
});

test('finish rejects stale inputs before any inbox write', async t => {
  for (const changed of ['source', 'specification']) await t.test(changed, async t => {
    const f = await fixture(t), run = path.join(f.root, 'run'), artifacts = path.join(run, 'artifacts');
    fs.mkdirSync(artifacts, {recursive: true});
    const equill = path.join(f.root, 'equill');
    const role = 'crew-audit-auditor';
    const records = [{name: role}, ...[10, 20, 30].map(step => ({process: role, step}))];
    const reply = {ok: true, content: records.map(JSON.stringify).join('\n\n'), bundle_digest: 'fixture',
      receipt: {projection: 'ready'}, selected_record_ids: ['fixture']};
    fs.writeFileSync(equill, `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(reply))});\n`, {mode: 0o755});
    const config = {...f.config, equill_store: f.root, equill_actor: 'fixture'};
    const configFile = path.join(f.root, 'config.json');
    fs.writeFileSync(configFile, JSON.stringify(config));
    for (const [name, value] of Object.entries({'input.json': f.input, 'config-digest.json': hash(config),
      'contract.json': {digest: 'fixture'}, 'findings.json': f.report,
      'review.json': {verdicts: [{id: f.finding.id, verdict: 'confirmed', reason: 'Verified'}]}})) {
      fs.writeFileSync(path.join(artifacts, name), JSON.stringify(value));
    }
    if (changed === 'source') execFileSync('git', ['-C', f.repo, '-c', 'user.name=fixture',
      '-c', 'user.email=fixture@invalid', 'commit', '--allow-empty', '-qm', 'advance source']);
    else f.objects.get('outcome:access').current_revision++;
    f.calls.length = 0;
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('../stages.mjs', import.meta.url)), 'finish'],
        {env: {...process.env, MEDULLA_RUN_DIR: run, AUDIT_CONFIG: configFile, EQUILL_BIN: equill,
          AUDIT_ADAPTER: fileURLToPath(new URL('../../audit-joppa/adapter.mjs', import.meta.url))},
        stdio: ['ignore', 'pipe', 'pipe']});
      let output = '';
      child.stdout.on('data', part => { output += part; });
      child.stderr.on('data', part => { output += part; });
      child.once('error', reject);
      child.once('close', code => resolve({code, output}));
    });
    assert.equal(result.code, 2);
    assert.match(result.output, changed === 'source' ? /Source changed during audit/ : /Specification changed during audit/);
    assert.equal(f.calls.some(call => call.name === 'joppa_batch'), false);
    assert.equal(fs.existsSync(path.join(artifacts, 'publication.json')), false);
  });
});

test('runner retries once on pre-publication finish freshness refusal only', async t => {
  const f = await fixture(t), here = path.dirname(fileURLToPath(import.meta.url));
  const runner = path.join(here, '../../audit-joppa/run.mjs');
  const python = path.join(f.root, 'python-ok'), medulla = path.join(f.root, 'medulla-stub');
  const runs = path.join(f.root, 'runs'), stateFile = path.join(f.root, 'state.json');
  fs.mkdirSync(runs);
  fs.writeFileSync(python, `#!${process.execPath}\nprocess.exit(0);\n`, {mode: 0o755});
  fs.writeFileSync(medulla, `#!${process.execPath}\n` + `
const fs = require('node:fs');
const path = require('node:path');
const stateFile = process.env.AUDIT_TEST_STATE;
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const attempt = state.calls.length + 1;
const plan = state.plans[attempt - 1];
state.calls.push(process.argv.slice(2));
fs.writeFileSync(stateFile, JSON.stringify(state));
const runsIndex = process.argv.indexOf('--runs-folder');
const runsFolder = process.argv[runsIndex + 1];
const runDir = path.join(runsFolder, 'run-' + attempt);
fs.rmSync(runDir, {recursive: true, force: true});
const artifacts = path.join(runDir, 'artifacts');
const stepDir = path.join(runDir, 'steps/004-finish');
fs.mkdirSync(artifacts, {recursive: true});
fs.mkdirSync(stepDir, {recursive: true});
if (plan.findings !== false) fs.writeFileSync(path.join(artifacts, 'findings.json'), '{"findings":[]}');
if (plan.publication) fs.writeFileSync(path.join(artifacts, 'publication.json'), '{"status":"uncertain"}');
if (plan.result) fs.writeFileSync(path.join(artifacts, 'result.json'), '{"status":"audited"}');
if (plan.ConcurrentDir) {
  const other = path.join(runsFolder, 'run-zz-concurrent');
  fs.mkdirSync(path.join(other, 'artifacts'), {recursive: true});
  fs.writeFileSync(path.join(other, 'artifacts/publication.json'), '{"status":"uncertain"}');
}
if (!plan.missingLog) fs.writeFileSync(path.join(stepDir, 'attempt-1-shell.txt'), '[err] ' + (plan.stderr || '') + '\\n');
fs.writeFileSync(path.join(runDir, 'journal.jsonl'), JSON.stringify({
  step: 4, node: plan.node || 'finish', kind: 'decision',
  signal: plan.signal || '__failed__', next: plan.next || '__exit_fail__',
  log_dir: 'steps/004-finish', message: 'body died: rc=2, 1 attempt(s); stderr: ' + (plan.stderr || '')
}) + '\\n');
process.stdout.write(runDir + '\\n');
process.stderr.write((plan.stderr || 'ok') + '\\n');
process.exit(plan.exitCode);
`, {mode: 0o755});
  const configFile = path.join(f.root, 'runner-config.json');
  fs.writeFileSync(configFile, JSON.stringify({...f.config, equill_store: f.root, equill_actor: 'fixture',
    runs_folder: runs, cbm_root: f.root, cbm_store: f.root}));
  const invoke = plans => {
    fs.writeFileSync(stateFile, JSON.stringify({calls: [], plans}));
    const out = execFileSync(process.execPath, [runner, configFile], {
      env: {...process.env, PLANNING_PYTHON: python, MEDULLA_BIN: medulla, AUDIT_TEST_STATE: stateFile},
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    });
    return {out, calls: JSON.parse(fs.readFileSync(stateFile, 'utf8')).calls};
  };
  const retried = invoke([
    {exitCode: 2, stderr: 'audit: Source changed during audit; rerun it', ConcurrentDir: true},
    {exitCode: 0, signal: 'AUDITED', next: '__exit_ok__', result: true, stderr: 'AUDITED'}
  ]);
  assert.equal(retried.calls.length, 2);
  assert.match(retried.out, /run-1\n.*run-2/s);

  for (const blocked of [
    [{exitCode: 2, stderr: 'audit: Source changed during audit; rerun it', publication: true},
      {exitCode: 0, signal: 'AUDITED', next: '__exit_ok__', result: true}],
    [{exitCode: 2, stderr: 'audit: Joppa schema changed during audit'},
      {exitCode: 0, signal: 'AUDITED', next: '__exit_ok__', result: true}],
    [{exitCode: 2, stderr: 'audit: Source changed during audit; rerun it', missingLog: true},
      {exitCode: 0, signal: 'AUDITED', next: '__exit_ok__', result: true}],
    [{exitCode: 2, stderr: 'audit: Specification changed during audit; rerun it'},
      {exitCode: 2, stderr: 'audit: Specification changed during audit; rerun it'},
      {exitCode: 0, signal: 'AUDITED', next: '__exit_ok__', result: true}]
  ]) {
    assert.throws(() => invoke(blocked));
    assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).calls.length, blocked.length === 3 ? 2 : 1);
  }
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).calls.length, 2);
});
