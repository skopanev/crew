import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseStatus} from '../ntk-status.mjs';
import {updateStatus} from '../ntk.mjs';

const cli = fileURLToPath(new URL('../ntk-status', import.meta.url));
async function execute(server, args) {
  return new Promise(resolve => {
    const child = spawn('bash', [cli, ...args], {
      env: {...process.env, NTK_KEY: 'fixture-secret', NTK_CONFIG: '/nonexistent/fixture-config',
        NTK_URL: `http://127.0.0.1:${server.address().port}`},
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data);
    child.stderr.on('data', data => stderr += data);
    child.on('close', code => resolve({code, stdout, stderr}));
  });
}
async function fixture(t, handler) {
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    handler(body ? JSON.parse(body) : null, req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return server;
}

test('CLI accepts only status fields and a safe atomic claim', () => {
  assert.deepEqual(parseStatus(['T1', '-W', 'test', '-s', 'to_test']),
    {id: 'T1', workspace: 'test', status: 'to_test'});
  for (const args of [[], ['T1', '-s', 'done'],
    ['T1', '-W', 'test', '-s', 'done', '--body', 'changed'],
    ['T1', '-W', 'test', '-s', 'in_progress'],
    ['T1', '-W', 'test', '-s', 'done', '--claim'],
    ['T1', '-W', 'test', '-s', 'in_progress', '--claim', '--force']]) {
    assert.throws(() => parseStatus(args));
  }
});
test('HTTP library also refuses an in_progress PATCH before any request', () => {
  assert.throws(() => updateStatus({id: 'T1', workspace: 'test', status: 'in_progress'}), /claimTicket/);
});
test('status writes use PATCH and carry workspace in the JSON body', async t => {
  let calls = 0;
  const server = await fixture(t, (body, req, res) => {
    calls++;
    assert.equal(req.headers.authorization, 'Bearer fixture-secret');
    assert.equal(req.method, 'PATCH');
    assert.equal(req.url, '/v1/tickets/T1');
    assert.deepEqual(body, {workspace: 'test', status: 'blocked', force: true});
    res.end('{"id":"T1","status":"blocked"}');
  });
  const result = await execute(server, ['T1', '-W', 'test', '-s', 'blocked', '--force']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'blocked');
  assert.equal(calls, 1);
});
test('bash-compatible claim uses the atomic start endpoint, never PATCH', async t => {
  const server = await fixture(t, (body, req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/tickets/T1/start?workspace=test');
    assert.equal(body, null);
    res.end('{"id":"T1","status":"in_progress","claimed":true}');
  });
  const result = await execute(server, ['T1', '-W', 'test', '-s', 'in_progress', '--claim']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).claimed, true);
});
for (const status of [409, 500]) {
  test(`HTTP ${status} exits nonzero without retrying or leaking credentials`, async t => {
    let calls = 0;
    const server = await fixture(t, (body, req, res) => {
      calls++;
      res.writeHead(status);
      res.end('{"error":"refused fixture-secret"}');
    });
    const result = await execute(server, ['T1', '-W', 'test', '-s', 'in_progress', '--claim']);
    assert.equal(result.code, 1);
    assert.equal(calls, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, new RegExp(`HTTP ${status}`));
    assert.ok(!result.stderr.includes('fixture-secret'));
  });
}
