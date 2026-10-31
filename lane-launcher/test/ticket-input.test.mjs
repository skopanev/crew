import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const input = fileURLToPath(new URL('../../lane/bin/ticket-input.mjs', import.meta.url));
const outcome = fileURLToPath(new URL('../../lane/bin/ticket-outcome.mjs', import.meta.url));
const ticket = {id: 'T1', source: 'joppa', address: 'task:t1',
  body: 'Acceptance criteria\n' + 'full body '.repeat(1000), module: 'fixture/src'};

function fixture(t, claim) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-ticket-input-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.mkdirSync(path.join(root, 'artifacts'));
  if (claim) fs.writeFileSync(path.join(root, 'artifacts/claim.json'), JSON.stringify(claim));
  return {root, file: path.join(root, 'artifacts/ticket.json'),
    env: {...process.env, ticket_id: 'T1', project_name: 'fixture', MEDULLA_RUN_DIR: root}};
}

for (const readOnly of [false, true]) for (const scenario of ['success', 'wrong-ticket', 'wrong-workspace', 'not-joppa', 'no-claim']) {
  test(`ticket input ${scenario}, readOnly=${readOnly}: claimed Joppa Task or failure, no writes`, t => {
    const claim = scenario === 'no-claim' ? null : {id: 'T1', workspace: scenario === 'wrong-workspace' ? 'other' : 'fixture',
      claimed: true, source: scenario === 'not-joppa' ? 'other' : 'joppa',
      ticket: scenario === 'wrong-ticket' ? {...ticket, id: 'OTHER', address: 'task:other'} : ticket};
    const f = fixture(t, claim);
    if (readOnly) fs.writeFileSync(f.file, 'original ticket artifact');
    const args = readOnly ? ['--read', 'T1', '--workspace', 'fixture'] : [];
    const result = spawnSync(process.execPath, [input, ...args], {env: f.env, encoding: 'utf8'});
    if (readOnly) assert.equal(fs.readFileSync(f.file, 'utf8'), 'original ticket artifact');
    if (scenario === 'success') {
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(readOnly ? result.stdout : fs.readFileSync(f.file, 'utf8')), ticket);
    } else {
      assert.equal(result.status, 1);
      if (!readOnly) assert.ok(!fs.existsSync(f.file));
      assert.match(result.stderr, /Ticket input:/);
    }
  });
}

test('ticket outcome leaves Joppa writes to the host worker and refuses an unconfirmed claim', t => {
  const claim = {id: 'T1', workspace: 'fixture', claimed: true, status: 'in_progress', source: 'joppa', address: 'task:t1'};
  const f = fixture(t, null);
  const run = (mode, value) => {
    fs.writeFileSync(path.join(f.root, 'artifacts/claim.json'), JSON.stringify({...value, run_dir: f.root}));
    return spawnSync(process.execPath, [outcome, mode], {env: f.env, encoding: 'utf8'});
  };
  for (const mode of ['to-test', 'blocked']) {
    const result = run(mode, claim);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `Joppa ${mode}: host worker records the outcome for task:t1\n`);
  }
  assert.match(run('findings', claim).stdout, /Joppa findings remain in followups.txt/);
  assert.match(run('reopen', claim).stderr, /Expected to-test, blocked or findings/);
  for (const value of [{...claim, claimed: false}, {...claim, workspace: 'other'}, {...claim, source: 'other'}]) {
    const result = run('to-test', value);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /No confirmed claim|not a Joppa Task claim/);
  }
});
