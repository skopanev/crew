import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const helper = fileURLToPath(new URL('../../lane/bin/ticket-input.mjs', import.meta.url));
for (const readOnly of [false, true]) for (const outcome of ['success', 'unavailable', 'wrong-ticket']) {
  test(`ticket input ${outcome}, readOnly=${readOnly}: one read, full body or failure, no writes`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-ticket-input-'));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const ticket = {id: outcome === 'wrong-ticket' ? 'OTHER' : 'T1',
      body: 'Acceptance criteria\n' + 'full body '.repeat(1000), module: 'fixture/src'};
    let calls = 0;
    const server = http.createServer((req, res) => {
      calls++;
      assert.equal(req.method, 'GET');
      assert.equal(req.url, '/v1/tickets/T1?workspace=fixture');
      res.writeHead(outcome === 'unavailable' ? 503 : 200);
      res.end(JSON.stringify(outcome === 'unavailable' ? {error: 'unavailable'} : {ticket}));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const env = {...process.env, ticket_id: 'T1', project_name: 'fixture', MEDULLA_RUN_DIR: root,
      NTK_CONFIG: path.join(root, 'missing'), NTK_KEY: 'fixture-key',
      NTK_URL: `http://127.0.0.1:${server.address().port}`};
    const file = path.join(root, 'artifacts/ticket.json');
    if (readOnly) {
      fs.mkdirSync(path.dirname(file));
      fs.writeFileSync(file, 'original ticket artifact');
    }
    const result = await new Promise((resolve, reject) => {
      const args = readOnly ? ['--read', 'T1', '--workspace', 'fixture'] : [];
      const child = spawn(process.execPath, [helper, ...args], {env});
      let stderr = '', stdout = '';
      child.stdout.on('data', data => stdout += data);
      child.stderr.on('data', data => stderr += data);
      child.on('error', reject);
      child.on('close', code => resolve({code, stderr, stdout}));
    });
    assert.equal(calls, 1);
    if (readOnly) assert.equal(fs.readFileSync(file, 'utf8'), 'original ticket artifact');
    if (outcome === 'success') {
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(JSON.parse(readOnly ? result.stdout : fs.readFileSync(file, 'utf8')), ticket);
    } else {
      assert.equal(result.code, 1);
      if (!readOnly) assert.ok(!fs.existsSync(file));
      assert.match(result.stderr, /Ticket input:/);
    }
  });
}
