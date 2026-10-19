import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {execFileSync, spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {confirmed, findingKey, source, validate} from '../common.mjs';
import {prepare, publish, recheck} from '../../audit-joppa/adapter.mjs';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-audit-test-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const repo = path.join(root, 'source'); fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'access.js'), 'export function allowed() {\n  return true;\n}\n');
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
    repositories: [{id: 'backend', path: repo}], inbox: {kind: 'incoming', owner: 'person'}};
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

test('invented source, stale spec and unsupported excess are rejected', async t => {
  const f = await fixture(t);
  for (const change of [
    {code: [{...f.finding.code[0], quote: '  return false;'}]},
    {spec: [{...f.finding.spec[0], revision: 2}]},
    {kind: 'excess', boundary: 'This helper was not requested.'}
  ]) assert.throws(() => validate({...f.report, findings: [{...f.finding, ...change}]}, f.input));
  assert.throws(() => validate({...f.report, inspected: [{repository: 'backend', path: '../user-token'}]}, f.input), /path|escapes/);
});

test('independent review must cover each finding and can dismiss it', async t => {
  const f = await fixture(t);
  assert.deepEqual(confirmed(f.report, {verdicts: [{id: 'access', verdict: 'dismissed', reason: 'The cited path is not reachable.'}]}), []);
  assert.throws(() => confirmed(f.report, {verdicts: []}), /every finding/);
  assert.throws(() => confirmed(f.report, {verdicts: [{id: 'another', verdict: 'confirmed', reason: 'Claim'}]}), /Invalid/);
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

test('real Medulla audits, reviews and publishes only confirmed findings', async t => {
  const medulla = execFileSync('which', ['medulla'], {encoding: 'utf8'}).trim();
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const found of [true, false]) {
    await t.test(found ? 'confirmed discrepancy' : 'no discrepancy', async t => {
      const f = await fixture(t), bins = path.join(f.root, 'bin');
      fs.mkdirSync(bins);
      const report = {...f.report, findings: found ? [f.finding] : []};
      fs.writeFileSync(path.join(f.root, 'report.json'), JSON.stringify(report));
      for (const name of ['codex', 'claude', 'equill']) {
        const script = path.join(bins, name);
        fs.writeFileSync(script, `#!${process.execPath}\n` + `
const fs = require('node:fs');
const name = require('node:path').basename(process.argv[1]);
if (name === 'equill') {
 const role='crew-audit-auditor';
 const records=[{name:role,actor:role},...[10,20,30].map(step=>({process:role,step}))];
 console.log(JSON.stringify({ok:true,content:records.map(x=>JSON.stringify(x)).join('\\n\\n'),
 receipt:{projection:'ready',degraded:false,empty:false},bundle_digest:'fixture',selected_record_ids:['fixture']}));
} else {
 process.stdin.resume(); process.stdin.on('end',()=>{
  fs.appendFileSync(process.env.AUDIT_TEST_EVENTS,name+'\\n');
  const report=JSON.parse(fs.readFileSync(process.env.AUDIT_TEST_REPORT));
  const result=name==='codex'?report:{verdicts:report.findings.map(x=>({id:x.id,verdict:'confirmed',reason:'Both source and specification support the discrepancy.'}))};
  console.log(JSON.stringify(name==='codex'?{type:'item.completed',item:{type:'agent_message',text:JSON.stringify(result)}}:{type:'result',is_error:false,result:JSON.stringify(result)}));
 });
}
`);
        fs.chmodSync(script, 0o755);
      }
      const configuration = {...f.config, equill_store: f.root, equill_actor: 'fixture',
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
            AUDIT_TEST_REPORT: path.join(f.root, 'report.json'), AUDIT_TEST_EVENTS: path.join(f.root, 'events')},
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
    });
  }
});
