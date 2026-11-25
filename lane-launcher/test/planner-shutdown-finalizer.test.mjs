import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {main} from '../../planning-joppa/dashboard.mjs';
import {PlannerRuns} from '../../planning-joppa/planner-runs.mjs';

test('a rejected stop cleans the real dashboard and retains its unconfirmed lock', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-finalizer-'));
  const config = path.join(root, 'config.json');
  fs.writeFileSync(config, JSON.stringify({workspace: 'fixture', runs_folder: root,
    mcp_command: ['unused-fixture'], concurrency: 1, interval_seconds: 60}));
  const failure = Object.assign(new Error('kill EPERM'), {code: 'EPERM'});
  const size = Object.getOwnPropertyDescriptor(PlannerRuns.prototype, 'size');
  const stop = PlannerRuns.prototype.stop;
  const set = globalThis.setInterval, clear = globalThis.clearInterval;
  const originalExit = process.exitCode;
  const originalHandlers = Object.fromEntries(['SIGINT', 'SIGTERM'].map(signal => [signal, process.listeners(signal)]));
  const intervals = new Set();
  let occupied = true;
  // A full pool keeps selection idle. The stop then fails after its last entry ends.
  Object.defineProperty(PlannerRuns.prototype, 'size', {configurable: true,
    get() { return occupied ? 1 : this.active.size; }});
  PlannerRuns.prototype.stop = function () { occupied = false; return Promise.reject(failure); };
  globalThis.setInterval = (...args) => {
    const timer = set(...args);
    intervals.add(timer);
    queueMicrotask(() => process.listeners('SIGINT').find(handler => !originalHandlers.SIGINT.includes(handler))());
    return timer;
  };
  globalThis.clearInterval = timer => { intervals.delete(timer); return clear(timer); };
  try {
    await assert.rejects(main([config]), error => error === failure);
    assert.equal(intervals.size, 0, 'The dashboard ticker must stop even when termination rejects');
    for (const signal of ['SIGINT', 'SIGTERM']) assert.deepEqual(process.listeners(signal), originalHandlers[signal]);
    assert.equal(fs.readFileSync(path.join(root, 'dispatch.lock'), 'utf8'), String(process.pid));
  } finally {
    for (const timer of intervals) clear(timer);
    globalThis.setInterval = set;
    globalThis.clearInterval = clear;
    Object.defineProperty(PlannerRuns.prototype, 'size', size);
    PlannerRuns.prototype.stop = stop;
    for (const signal of ['SIGINT', 'SIGTERM']) {
      for (const handler of process.listeners(signal)) {
        if (!originalHandlers[signal].includes(handler)) process.off(signal, handler);
      }
    }
    process.exitCode = originalExit ?? 0;
    fs.rmSync(root, {recursive: true, force: true});
  }
});
