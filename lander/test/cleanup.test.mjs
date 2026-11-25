import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {cleanup} from '../git.mjs';

test('permission failure uses the configured cleanup with the validated checkout path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lander-cleanup-'));
  const checkout = fs.mkdtempSync(path.join(root, 'lander-fixture-'));
  const {dev, ino} = fs.lstatSync(checkout), remove = fs.rmSync;
  fs.writeFileSync(path.join(checkout, 'file'), 'fixture');
  try {
    fs.rmSync = () => { throw Object.assign(new Error('Docker-owned files'), {code: 'EACCES'}); };
    cleanup({checkout, dev, ino}, root,
      'node -e \'require("fs").rmSync(process.env.LANDER_CHECKOUT,{recursive:true})\'');
    assert.equal(fs.existsSync(checkout), false);
  } finally { fs.rmSync = remove; remove(root, {recursive: true, force: true}); }
});

test('retained, foreign and unsuccessful cleanups preserve the checkout', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lander-cleanup-'));
  const checkout = fs.mkdtempSync(path.join(root, 'lander-fixture-'));
  const {dev, ino} = fs.lstatSync(checkout), remove = fs.rmSync;
  try {
    cleanup({checkout, dev, ino, checked: {retainCheckout: true}}, root, 'exit 99');
    assert.throws(() => cleanup({checkout, dev, ino: ino + 1}, root, 'exit 0'), /identity changed/);
    fs.rmSync = () => { throw Object.assign(new Error('Docker-owned files'), {code: 'EPERM'}); };
    assert.throws(() => cleanup({checkout, dev, ino}, root, 'exit 1'), /cleanup failed/);
    assert.equal(fs.existsSync(checkout), true);
  } finally { fs.rmSync = remove; remove(root, {recursive: true, force: true}); }
});
