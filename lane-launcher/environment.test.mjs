import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {installEnvironment} from './environment.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crew-environment-')));
  const repository = path.join(root, 'source');
  fs.mkdirSync(repository);
  git(repository, 'init', '-b', 'main');
  git(repository, 'config', 'user.email', 'test@example.invalid');
  git(repository, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(repository, 'workflow.yaml'), 'version: old\n');
  fs.writeFileSync(path.join(repository, 'panel.mjs'), 'console.log("panel")\n');
  fs.mkdirSync(path.join(repository, 'role'));
  fs.writeFileSync(path.join(repository, 'role/contract.txt'), 'Role contract\n');
  fs.writeFileSync(path.join(repository, 'panel.json'), JSON.stringify({
    workflow: path.join(repository, 'workflow.yaml'), vars: {HELPER: path.join(repository, 'panel.mjs')},
    context: {roles: {author: {role: 'role'}}},
    token_file: path.join(repository, 'secrets/read-key'), runs_folder: path.join(root, 'runs')
  }));
  git(repository, 'add', '.'); git(repository, 'commit', '-m', 'Initial code');
  return {root, repository, spec: {root: path.join(root, 'environments'),
    sources: {engine: {repository, ref: 'main'}}, config: {source: 'engine', path: 'panel.json'},
    bindings: {workflow: '{engine}/workflow.yaml', 'vars.HELPER': '{engine}/panel.mjs'},
    external: ['token_file'], command: ['node', '{engine}/panel.mjs', '{config}']}};
}
function cleanup(value) {
  // Remove registered worktrees before the temporary repository.
  for (const row of git(value.repository, 'worktree', 'list', '--porcelain').split('\n')) {
    if (row.startsWith('worktree ') && row.slice(9) !== value.repository) git(value.repository, 'worktree', 'remove', '--force', row.slice(9));
  }
  fs.rmSync(value.root, {recursive: true, force: true});
}

test('pins each code version, preserves old environments, and verifies reuse', () => {
  const value = fixture();
  try {
    const first = installEnvironment(value.spec);
    const old = JSON.parse(fs.readFileSync(first.config, 'utf8'));
    assert.equal(fs.readFileSync(old.workflow, 'utf8'), 'version: old\n');
    assert.equal(old.token_file, path.join(value.repository, 'secrets/read-key'));
    assert.equal(old.context.roles.author.role, 'role');
    assert.deepEqual(installEnvironment(value.spec), first);
    const specFile = path.join(value.root, 'environment-spec.json');
    fs.writeFileSync(specFile, JSON.stringify(value.spec));
    const output = execFileSync(process.execPath, [new URL('./environment.mjs', import.meta.url).pathname,
      specFile, '--run'], {encoding: 'utf8'});
    assert.equal(output.trim(), 'panel');
    const withOutput = structuredClone(value.spec);
    withOutput.command.push('--output={environment}/out/log.txt', '--watch');
    assert.ok(installEnvironment(withOutput));
    fs.writeFileSync(path.join(value.repository, 'workflow.yaml'), 'version: new\n');
    git(value.repository, 'add', '.'); git(value.repository, 'commit', '-m', 'New code');
    const second = installEnvironment(value.spec);
    assert.notEqual(first.id, second.id);
    assert.equal(fs.readFileSync(old.workflow, 'utf8'), 'version: old\n');
    assert.equal(fs.readFileSync(JSON.parse(fs.readFileSync(second.config)).workflow, 'utf8'), 'version: new\n');
    fs.appendFileSync(second.config, ' ');
    assert.throws(() => installEnvironment(value.spec), /installed environment changed/);
    const code = path.join(first.folder, 'engine', 'panel.mjs');
    fs.writeFileSync(code, 'changed\n');
    const fixed = structuredClone(value.spec); fixed.sources.engine.ref = first.sources.engine.sha;
    assert.throws(() => installEnvironment(fixed), /snapshot has local changes/);
  } finally { cleanup(value); }
});

test('refuses unbound live code and paths that escape snapshots', () => {
  const value = fixture();
  try {
    const missing = structuredClone(value.spec); delete missing.bindings['vars.HELPER'];
    assert.throws(() => installEnvironment(missing), /live source path: vars.HELPER/);
    const relative = JSON.parse(fs.readFileSync(path.join(value.repository, 'panel.json')));
    relative.vars.HELPER = './panel.mjs';
    fs.writeFileSync(path.join(value.repository, 'panel.json'), JSON.stringify(relative));
    git(value.repository, 'add', '.'); git(value.repository, 'commit', '-m', 'Relative helper');
    assert.throws(() => installEnvironment(missing), /live source path: vars.HELPER/);
    fs.symlinkSync(path.join(value.root, 'outside.mjs'), path.join(value.repository, 'escaped.mjs'));
    fs.writeFileSync(path.join(value.root, 'outside.mjs'), 'outside\n');
    git(value.repository, 'add', '.'); git(value.repository, 'commit', '-m', 'External link');
    const escaped = structuredClone(value.spec); escaped.bindings['vars.HELPER'] = '{engine}/escaped.mjs';
    assert.throws(() => installEnvironment(escaped), /escapes its snapshot/);
    const traversal = structuredClone(value.spec); traversal.config.path = '../outside.json';
    assert.throws(() => installEnvironment(traversal), /must be inside/);
    const liveCommand = structuredClone(value.spec); liveCommand.command = ['node', path.join(value.repository, 'panel.mjs')];
    assert.throws(() => installEnvironment(liveCommand), /live source path/);
    const optionEscape = structuredClone(value.spec);
    optionEscape.command = ['node', '--import={engine}/escaped.mjs', '{engine}/panel.mjs'];
    assert.throws(() => installEnvironment(optionEscape), /escapes its snapshot/);
    for (const spelling of ['{environment}/./engine/escaped.mjs', '{environment}//engine/escaped.mjs',
      '--import={environment}/./engine/escaped.mjs']) {
      const normalizedEscape = structuredClone(value.spec);
      normalizedEscape.command = ['node', spelling, '{engine}/panel.mjs'];
      assert.throws(() => installEnvironment(normalizedEscape), /escapes its snapshot/);
    }
    fs.mkdirSync(path.join(value.repository, 'tools'));
    fs.writeFileSync(path.join(value.repository, 'tools/runner.mjs'), 'console.log("runner")\n');
    git(value.repository, 'add', '.'); git(value.repository, 'commit', '-m', 'Tracked runner');
    const relativeCommand = structuredClone(value.spec); relativeCommand.command = ['node', 'tools/runner.mjs'];
    assert.throws(() => installEnvironment(relativeCommand), /live source path/);
    fs.unlinkSync(path.join(value.repository, 'tools/runner.mjs'));
    assert.throws(() => installEnvironment(relativeCommand), /live source path/);
    fs.mkdirSync(path.join(value.root, 'outside/child'), {recursive: true});
    fs.writeFileSync(path.join(value.root, 'outside/panel.sh'), 'echo OUTSIDE\n');
    fs.writeFileSync(path.join(value.repository, 'panel.sh'), 'echo INSIDE\n');
    fs.symlinkSync(path.join(value.root, 'outside/child'), path.join(value.repository, 'door'));
    git(value.repository, 'add', '.'); git(value.repository, 'commit', '-m', 'Directory link');
    const traversalCommand = structuredClone(value.spec);
    traversalCommand.command = ['bash', '{engine}/door/../panel.sh'];
    assert.throws(() => installEnvironment(traversalCommand), /Parent path segments/);
    const traversalBinding = structuredClone(value.spec);
    traversalBinding.bindings['vars.HELPER'] = '{engine}/door/../panel.sh';
    assert.throws(() => installEnvironment(traversalBinding), /Parent path segments/);
    const specFile = path.join(value.root, 'traversal.json');
    fs.writeFileSync(specFile, JSON.stringify(traversalCommand));
    const actual = spawnSync(process.execPath, [new URL('./environment.mjs', import.meta.url).pathname,
      specFile, '--run'], {encoding: 'utf8'});
    assert.equal(actual.status, 2); assert.ok(!actual.stdout.includes('OUTSIDE'));
    const parentConfig = JSON.parse(fs.readFileSync(path.join(value.repository, 'panel.json')));
    parentConfig.vars.HELPER = '../../../../live/repo/helper.mjs';
    fs.writeFileSync(path.join(value.repository, 'panel.json'), JSON.stringify(parentConfig));
    git(value.repository, 'add', '.'); git(value.repository, 'commit', '-m', 'Unbound parent path');
    assert.throws(() => installEnvironment(missing), /Parent path segments/);
    fs.symlinkSync('door/../panel.sh', path.join(value.repository, 'linked.sh'));
    git(value.repository, 'add', '.'); git(value.repository, 'commit', '-m', 'Nested directory link');
    const nested = structuredClone(value.spec); nested.command = ['bash', '{engine}/linked.sh'];
    assert.throws(() => installEnvironment(nested), /escapes its snapshot/);
    fs.writeFileSync(specFile, JSON.stringify(nested));
    const chained = spawnSync(process.execPath, [new URL('./environment.mjs', import.meta.url).pathname,
      specFile, '--run'], {encoding: 'utf8'});
    assert.equal(chained.status, 2); assert.ok(!chained.stdout.includes('OUTSIDE'));
  } finally { cleanup(value); }
});
