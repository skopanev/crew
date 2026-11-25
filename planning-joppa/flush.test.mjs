import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {pendingFlush, requestFlush} from './flush.mjs';
import {normalizeSlots} from './slots.mjs';
import {slotsFixture} from '../lane-launcher/test-support/planner-slots.fixture.mjs';
import {pause} from '../lane-launcher/test-support/config-reload.fixture.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
for (const execution of ['detached', 'inline']) {
  test(`one ${execution} flush starts below the minimum, preserves its snapshot and never repeats after restart`, async t => {
    const f = await slotsFixture(t, {execution});
    f.write({...f.config, batch: {size: 5, min_size: 5, by: 'data.repository'},
      publication: {file: 'operations.json', allowed_operations: ['save_object'], update_kinds: ['ac']}});
    const original = fs.readFileSync(f.configFile, 'utf8');
    const cli = spawnSync('sh', [path.join(root, 'lane-launcher/lander.sh'), 'flush', f.configFile, 'A'], {encoding: 'utf8'});
    assert.equal(cli.status, 0, cli.stderr);
    const [request] = pendingFlush(JSON.parse(original), f.config.runs_folder);
    let run = f.start();
    try {
      await run.until(() => f.starts().length === 1 && !fs.existsSync(request.file));
      assert.match(run.output(), /flush requested: A/);
      assert.equal(f.starts()[0].slot, 'A');
      const [record] = f.runs();
      assert.equal(record.flush_request.id, request.id);
      const snapshot = path.join(record.folder, 'config.json'), snapshotBytes = fs.readFileSync(snapshot, 'utf8');
      const captured = normalizeSlots(JSON.parse(snapshotBytes));
      assert.equal(captured.inputs[0].batch.min_size, 1);
      assert.equal(captured.inputs[1].batch?.min_size ?? captured.batch.min_size, 5);
      const verify = `import sys
sys.path[:0] = [${JSON.stringify(path.join(root, 'planning-joppa'))}, ${JSON.stringify(path.join(root, 'planning'))}]
from flow_launch import configuration
from flow_batch import ready
a = configuration(${JSON.stringify(snapshot)}, input_index=0)
b = configuration(${JSON.stringify(snapshot)}, input_index=1)
assert a['batch']['min_size'] == 1 and ready(a['batch'], [{'address':'ac:one'}])
assert b['batch']['min_size'] == 5 and not ready(b['batch'], [{'address':'ac:one'}])`;
      const python = spawnSync('python3', ['-c', verify], {encoding: 'utf8'});
      assert.equal(python.status, 0, python.stderr);
      await pause(1100);
      assert.equal(f.starts().length, 1);
      assert.equal(await run.stop(), 130);
      // Recreate the original request to exercise a restart between dispatch and consumption.
      fs.writeFileSync(request.file, JSON.stringify(request));
      run = f.start();
      await run.until(() => !fs.existsSync(request.file));
      await pause(1100);
      assert.equal(f.starts().length, 1);
      assert.equal(fs.readFileSync(f.configFile, 'utf8'), original);
      assert.equal(fs.readFileSync(snapshot, 'utf8'), snapshotBytes);
    } finally { await run.stop(); }
  });
}

test('an empty requested slot consumes its request without starting a batch', async t => {
  const f = await slotsFixture(t);
  f.objects.delete('ac:a2');
  f.write({...f.config, batch: {size: 5, min_size: 5, by: 'data.repository'}});
  const [request] = requestFlush(f.configFile, 'B');
  const run = f.start();
  try {
    await run.until(output => output.includes('nothing to flush: B'));
    assert.equal(fs.existsSync(request.file), false);
    await pause(1100);
    assert.equal(f.starts().length, 0);
  } finally { await run.stop(); }
});

test('flush all preserves capacity and the pending request of an occupied dispatcher', async t => {
  const f = await slotsFixture(t, {concurrency: 1});
  f.write({...f.config, batch: {size: 5, min_size: 5, by: 'data.repository'}});
  requestFlush(f.configFile);
  const run = f.start();
  try {
    await run.until(() => f.starts().length === 1);
    await pause(1100);
    assert.equal(f.starts().length, 1);
    assert.deepEqual(pendingFlush(f.config, f.config.runs_folder).map(request => request.slot), ['B']);
    assert.match(run.output(), /flush requested: B/);
    f.release(f.starts()[0].address);
    await run.until(() => f.starts().length === 2);
    await run.until(() => pendingFlush(f.config, f.config.runs_folder).length === 0);
    assert.deepEqual(f.starts().map(run => run.slot), ['A', 'B']);
  } finally { await run.stop(); }
});
