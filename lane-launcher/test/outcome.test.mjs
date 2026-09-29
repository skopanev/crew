import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const helper = fileURLToPath(new URL('../../lane/bin/ticket-outcome.mjs', import.meta.url));
async function fixture(t, handler, {claimed = true} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-outcome-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const artifacts = path.join(root, 'artifacts');
  fs.mkdirSync(artifacts);
  if (claimed) fs.writeFileSync(path.join(artifacts, 'claim.json'), JSON.stringify({
    id: 'T1', workspace: 'test', run_dir: root, status: 'in_progress', claimed: true,
  }));
  fs.writeFileSync(path.join(artifacts, 'failure.txt'), 'Actual failure: gates failed\n');
  fs.writeFileSync(path.join(artifacts, 'scout.txt'), 'LLM evidence: file.ts:23\n' + 'x'.repeat(3000));
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    calls.push({method: req.method, url: req.url, raw, authorization: req.headers.authorization});
    handler(req, res, raw, calls, `http://127.0.0.1:${server.address().port}`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const env = {...process.env, ticket_id: 'T1', project_name: 'test', MEDULLA_RUN_DIR: root,
    NTK_CONFIG: path.join(root, 'missing'), NTK_KEY: 'fixture-key',
    NTK_URL: `http://127.0.0.1:${server.address().port}`};
  return {root, artifacts, calls, run: mode => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helper, mode], {env});
    let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data);
    child.stderr.on('data', data => stderr += data);
    child.on('error', reject);
    child.on('close', code => resolve({code, stdout, stderr}));
  })};
}

test('no confirmed claim means failure without any NTK request', async t => {
  const f = await fixture(t, () => assert.fail('must not contact NTK'), {claimed: false});
  assert.equal((await f.run('blocked')).code, 1);
  assert.equal((await f.run('to-test')).code, 1);
  assert.equal((await f.run('findings')).code, 1);
  assert.equal(f.calls.length, 0);
});
test('a claim from another run cannot authorize ticket writes', async t => {
  const f = await fixture(t, () => assert.fail('must not contact NTK'));
  const file = path.join(f.artifacts, 'claim.json');
  const claim = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({...claim, run_dir: '/another-run'}));
  assert.equal((await f.run('blocked')).code, 1);
  assert.equal((await f.run('to-test')).code, 1);
  assert.equal((await f.run('findings')).code, 1);
  assert.equal(f.calls.length, 0);
});
for (const failures of [0, 2, 3]) {
  test(`to_test with ${failures} failures: at most 3 attempts, no force, no blocked fallback`, async t => {
    const f = await fixture(t, (req, res, raw, calls) => {
      assert.equal(req.method, 'PATCH');
      assert.equal(req.url, '/v1/tickets/T1');
      assert.deepEqual(JSON.parse(raw), {workspace: 'test', status: 'to_test'});
      res.writeHead(calls.length <= failures ? 503 : 200);
      res.end(calls.length <= failures ? '{"error":"fixture unavailable"}' : '{"updated":true}');
    });
    const result = await f.run('to-test');
    assert.equal(result.code, failures === 3 ? 1 : 0, result.stderr);
    assert.equal(f.calls.length, Math.min(failures + 1, 3));
    if (failures === 3) {
      assert.match(result.stderr, /failed after 3 attempts/);
      assert.match(fs.readFileSync(path.join(f.artifacts, 'to-test-errors.txt'), 'utf8'), /attempt 3\/3/);
    }
  });
}
test('blocked writes the status and attaches complete LLM details without replacing the body', async t => {
  const f = await fixture(t, (req, res, raw, calls, base) => {
    if (req.method === 'PATCH') {
      assert.deepEqual(JSON.parse(raw), {workspace: 'test', status: 'blocked', force: true});
      res.end('{"updated":true}');
    } else if (req.url === '/v1/tickets/T1/attachments') {
      const body = JSON.parse(raw);
      assert.equal(body.workspace, 'test');
      assert.ok(body.size_bytes > 3000);
      res.end(JSON.stringify({url: base + '/upload', object_key: 'attachments/test/T1/fixture'}));
    } else if (req.url === '/upload') {
      assert.equal(req.method, 'PUT');
      assert.equal(req.headers.authorization, undefined);
      assert.match(raw, /Actual failure: gates failed/);
      assert.match(raw, /LLM evidence: file.ts:23/);
      assert.match(raw, /compiler error fixture/);
      assert.match(raw, /"passed":false/);
      res.end();
    } else {
      assert.equal(req.url, '/v1/tickets/T1/attachments/commit');
      assert.equal(JSON.parse(raw).object_key, 'attachments/test/T1/fixture');
      res.end('{"ticket":"T1"}');
    }
  });
  const gateDir = path.join(f.artifacts, 'gates', 'failed-run');
  fs.mkdirSync(gateDir, {recursive: true});
  fs.writeFileSync(path.join(gateDir, 'receipt.json'), '{"passed":false}');
  fs.writeFileSync(path.join(gateDir, '1.log'), 'compiler error fixture\n');
  const result = await f.run('blocked');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(f.calls.length, 4);
});
test('failed report upload is an error and does not undo blocked or lose the local report', async t => {
  const f = await fixture(t, (req, res) => {
    res.writeHead(req.method === 'PATCH' ? 200 : 503);
    res.end(req.method === 'PATCH' ? '{"updated":true}' : '{"error":"storage unavailable"}');
  });
  const result = await f.run('blocked');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /failure report/);
  assert.equal(f.calls[0].method, 'PATCH');
  assert.match(fs.readFileSync(path.join(f.artifacts, 'ntk-failure-report.txt'), 'utf8'), /Actual failure/);
});

test('empty findings create no ticket', async t => {
  const f = await fixture(t, () => assert.fail('must not contact NTK'));
  fs.writeFileSync(path.join(f.artifacts, 'followups.txt'), '\n');
  assert.equal((await f.run('findings')).code, 0);
});

for (const failUpload of [false, true]) {
  test(`findings are blocked dependents with full attachment; retry reuses ticket (upload failure: ${failUpload})`, async t => {
    let creates = 0, uploads = 0;
    const f = await fixture(t, (req, res, raw, calls, base) => {
      if (req.method === 'GET') {
        assert.equal(req.url, '/v1/tickets/T1?workspace=test');
        res.end(JSON.stringify({ticket: {id: 'T1', title: 'Source title', status: 'to_test',
          project: 'app', module: 'app/core', tags: ['agent-ready']}}));
      } else if (req.url === '/v1/tickets') {
        creates++;
        const body = JSON.parse(raw);
        assert.equal(body.title, 'Findings');
        assert.equal(body.workspace, 'test');
        assert.equal(body.project, 'app');
        assert.equal(body.module, 'app/core');
        assert.equal(body.status, 'blocked');
        assert.deepEqual(body.deps, ['T1']);
        assert.equal(body.tags, undefined);
        assert.equal(body.skip_search, undefined);
        assert.ok(body.body.length < 2000);
        assert.ok(!body.body.includes('x'.repeat(2000)));
        res.end('{"id":"app-finding","status":"blocked"}');
      } else if (req.url === '/v1/tickets/app-finding/attachments') {
        assert.ok(JSON.parse(raw).size_bytes > 5000);
        res.end(JSON.stringify({url: base + '/upload', object_key: 'findings/report'}));
      } else if (req.url === '/upload') {
        uploads++;
        assert.equal(req.headers.authorization, undefined);
        assert.match(raw, /MED - reuse/);
        assert.match(raw, /LOW - naming/);
        assert.match(raw, /Landed SHA: deadbeef/);
        assert.ok(raw.includes('x'.repeat(5000)));
        res.writeHead(failUpload && uploads === 1 ? 503 : 200);
        res.end();
      } else {
        assert.equal(req.url, '/v1/tickets/app-finding/attachments/commit');
        res.end('{"ticket":"app-finding"}');
      }
    });
    fs.writeFileSync(path.join(f.artifacts, 'followups.txt'), '- MED - reuse - file.ts:2 - impact - FIX: reuse\n');
    fs.writeFileSync(path.join(f.artifacts, 'architecture.md'), '- LOW - naming\n' + 'x'.repeat(5000));
    fs.writeFileSync(path.join(f.artifacts, 'landing.txt'), 'Landed SHA: deadbeef\n');
    const first = await f.run('findings');
    assert.equal(first.code, failUpload ? 1 : 0, first.stderr);
    const retry = await f.run('findings');
    assert.equal(retry.code, 0, retry.stderr);
    assert.equal(creates, 1);
    assert.equal(uploads, failUpload ? 2 : 1);
    assert.equal(f.calls.filter(c => c.method === 'PATCH').length, 0);
    assert.match(retry.stdout, /app-finding/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.artifacts, 'finding-ticket.json'))).attached, true);
  });
}

test('uncertain creation is retained and never blindly repeated', async t => {
  const f = await fixture(t, (req, res) => {
    if (req.method === 'GET') {
      res.end('{"ticket":{"id":"T1","status":"to_test","title":"Source","project":"app"}}');
    } else {
      assert.equal(req.url, '/v1/tickets');
      res.destroy();
    }
  });
  fs.writeFileSync(path.join(f.artifacts, 'followups.txt'), '- MED - finding\n');
  assert.equal((await f.run('findings')).code, 1);
  const retry = await f.run('findings');
  assert.equal(retry.code, 1);
  assert.match(retry.stderr, /creation is unconfirmed/);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  assert.match(fs.readFileSync(path.join(f.artifacts, 'finding-report.txt'), 'utf8'), /MED - finding/);
});
