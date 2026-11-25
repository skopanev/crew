import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as pause} from 'node:timers/promises';

test('Lander counts native profiles initially and periodically without overlapping polls or claiming work', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lander-status-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const runs = path.join(root, 'runs'), configFile = path.join(root, 'config.json');
  fs.mkdirSync(runs);
  const config = {workspace: 'example', runs_folder: runs, interval_seconds: .02,
    selection: {kind: 'task', parent: 'requirement:a', data: {stage: 'pending'}},
    exclude_tags: ['held'], admission_module: '/must/not/run.mjs', inputs: [{slot: 'A'}, {slot: 'B'}]};
  const script = path.join(root, 'monitor.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs';
import {setTimeout as pause} from 'node:timers/promises';
import {main} from ${JSON.stringify(new URL('../status.mjs', import.meta.url).href)};
process.stdout.isTTY = process.env.TEST_TTY === '1';
let active = 0;
await main([process.env.TEST_CONFIG, ...(process.env.TEST_ONCE === '1' ? ['--once'] : [])], {read: async args => {
  if (++active !== 1) throw new Error('overlapping count polls');
  fs.appendFileSync(process.env.TEST_CALLS, JSON.stringify(args) + '\\n');
  try {
    if (process.env.TEST_TTY === '1') await pause(80);
    return {total: 5, groups: [{tags: [], count: 3}, {tags: ['held'], count: 2}]};
  } finally { active--; }
}});
if (process.listenerCount('SIGINT') || process.listenerCount('SIGTERM')) throw new Error('signal listener leaked');
`);
  let sequence = 0;
  const start = (value, tty = false, once = false) => {
    fs.writeFileSync(configFile, JSON.stringify(value));
    const calls = path.join(root, 'calls-' + sequence++);
    const child = spawn(process.execPath, [script], {env: {...process.env, NO_COLOR: '1', TEST_CONFIG: configFile,
      TEST_CALLS: calls, TEST_TTY: tty ? '1' : '0', TEST_ONCE: once ? '1' : '0'}});
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const done = new Promise(resolve => child.once('close', code => resolve(code)));
    const rows = () => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse) : [];
    return {child, done, rows, output: () => output};
  };
  for (const once of [false, true]) {
    const run = start(config, false, once);
    assert.equal(await run.done, 0, run.output());
    assert.match(run.output(), /available: A 3 · B 3/);
    assert.deepEqual(run.rows(), [{...config.selection, workspace: 'example', assignee: '', group_by: ['tags']}]);
  }
  const active = path.join(runs, '2026-11-25_00-00-00-active', 'artifacts');
  fs.mkdirSync(active, {recursive: true});
  fs.writeFileSync(path.join(active, '../.lock'), String(process.pid));
  let run = start(config);
  assert.equal(await run.done, 0, run.output());
  assert.match(run.output(), /available \?/);
  fs.writeFileSync(path.join(active, 'claim.json'), JSON.stringify({status: 'confirmed'}));
  run = start(config);
  assert.equal(await run.done, 0, run.output());
  assert.match(run.output(), /available: A 3 · B 3/);
  run = start({...config, selection: {...config.selection, predicate: 'complex'}});
  assert.equal(await run.done, 0, run.output());
  assert.match(run.output(), /available: A \? · B \?/);
  assert.equal(run.rows().length, 0);
  run = start(config, true);
  for (let i = 0; i < 100 && run.rows().length < 3; i++) await pause(20);
  assert.ok(run.rows().length >= 3, run.output());
  run.child.kill('SIGINT');
  assert.equal(await run.done, 0, run.output());
  assert.match(run.output(), /Stopped/);
  assert.doesNotMatch(run.output(), /overlapping count polls|signal listener leaked/);
  assert.deepEqual(fs.readdirSync(active), ['claim.json'], 'The monitor creates no run artifacts');
});
