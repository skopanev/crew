import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {validatePersistentMounts} from '../runtime.mjs';

test('train.persistentMounts use the writable-dir overlap rule', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crew-mounts-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const dir = name => { const folder = path.join(root, name); fs.mkdirSync(folder, {recursive: true}); return folder; };
  const config = {sourceRoot: dir('sources'), sshDir: dir('ssh'), cbmCacheDir: dir('cbm'),
    readOnlyRepos: [dir('context')], readWriteDirs: [dir('rw')]};
  fs.symlinkSync(config.sourceRoot, path.join(root, 'alias'));
  const check = (...hosts) => validatePersistentMounts({...config,
    train: {persistentMounts: hosts.map((host, i) => ({host, inside: `/m${i}`}))}});
  for (const host of [config.sourceRoot, path.join(config.sourceRoot, 'repo'), root, path.join(root, 'alias'),
    path.join(config.sourceRoot, 'missing/child'), config.sshDir, path.join(config.cbmCacheDir, 'x'),
    config.readOnlyRepos[0], path.join(config.readWriteDirs[0], 'sub')]) {
    assert.throws(() => check(host), /overlaps/, host);
  }
  assert.throws(() => check(path.join(root, 'lander'), path.join(root, 'lander/b')), /overlaps/);
  assert.throws(() => check('relative'), /absolute/);
  check(path.join(root, 'lander/a'), path.join(root, 'elsewhere'));
  validatePersistentMounts(config);
});

test('the launcher config refuses a persistent mount aliasing sourceRoot', async t => {
  const {configFrom} = await import('../launcher.mjs');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crew-mounts-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const dir = name => { const folder = path.join(root, name); fs.mkdirSync(folder, {recursive: true}); return folder; };
  const cbm = path.join(root, 'cbm-server');
  fs.writeFileSync(cbm, '');
  const base = {id: 'fixture', workspace: 'w', herdrWorkspace: 'h', launchLanes: true, stateDir: dir('state'),
    gateCommands: ['true'], testCommand: ['true'], sourceRoot: dir('sources'), sshDir: dir('ssh'),
    cbmCacheDir: dir('cbm'), cbmMcpCommand: cbm, readOnlyRepos: [], readWriteDirs: []};
  const file = path.join(root, 'dolber.json');
  const load = persistentMounts => {
    fs.writeFileSync(file, JSON.stringify({...base, train: {gateCommands: ['true'], persistentMounts}}));
    return configFrom(file, {});
  };
  assert.throws(() => load([{host: path.join(base.sourceRoot, 'cache'), inside: '/c'}]), /overlaps/);
  assert.equal(load([{host: path.join(root, 'lander'), inside: '/c'}]).train.persistentMounts.length, 1);
});
