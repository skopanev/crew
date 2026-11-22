import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, execFileSync} from 'node:child_process';
import {setup, execute, worker} from '../test-support/launcher.fixture.mjs';
import {save, read, runDirectories} from '../runtime.mjs';
import {scopeDirectory} from '../scope.mjs';
import {prepareRunSecrets} from '../run-secrets.mjs';
import {validatePreLaunch} from '../pre-launch.mjs';

async function until(check) {
  const end = Date.now() + 10000;
  while (!check()) {
    assert.ok(Date.now() < end, 'Secret fixture did not reach the expected state');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function fixture(t, exit = 1, hold = false) {
  const f = await setup(t), source = f.config.sourceRoot;
  let sha = '';
  if (exit === 0) {
    const repo = f.config.repositories[0].path;
    const git = args => execFileSync('git', ['-C', repo, ...args], {encoding: 'utf8'}).trim();
    git(['init', '-q', '-b', 'main']);
    git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@local', 'commit', '--allow-empty', '-qm', 'Landed fixture']);
    git(['remote', 'add', 'origin', repo]);
    sha = git(['rev-parse', 'HEAD']);
    f.config.delivery = 'target';
  }
  // Reproduce production: all lanes see the source tree, including dispatcher state.
  f.config.stateDir = path.join(source, '.state');
  f.stateDir = scopeDirectory(f.config.stateDir, f.config.id);
  const hook = path.join(f.root, 'hook.cjs');
  const notice = path.join(f.root, 'notice.json'), capture = path.join(f.root, 'capture.json');
  const release = path.join(f.root, 'release'), laneRelease = path.join(f.root, 'lane-release');
  fs.writeFileSync(hook, `const fs=require('node:fs'),path=require('node:path');
const dir=process.env.CREW_RUN_DIR,file=path.join(dir,'token');
fs.writeFileSync(file,'fixture-lane-secret',{mode:0o600});
fs.writeFileSync(path.join(dir,'mounts.json'),JSON.stringify([{host_path:file,container_path:'/run/secrets/cloud',mode:'0600'}]));
fs.writeFileSync(process.env.TEST_NOTICE,JSON.stringify({dir,file}));
${hold ? "const timer=setInterval(()=>{if(fs.existsSync(process.env.TEST_RELEASE)){clearInterval(timer);}},20);" : ''}
`);
  fs.writeFileSync(path.join(f.bins, 'bash'), `#!${process.execPath}
const fs=require('node:fs');
if(process.argv[2]==='-c'){const r=require('node:child_process').spawnSync('/bin/bash',process.argv.slice(2),{stdio:'inherit'});process.exit(r.status??1);}
const args=process.argv.slice(2),index=args.indexOf('--mount-file'),mount=args[index+1];
if(index<0)throw Error('Missing private file mount');
const [host,target]=mount.split(':');
if(fs.readFileSync(host,'utf8')!=='fixture-lane-secret')throw Error('Wrong lane file');
if(Object.values(process.env).some(value=>value.includes('fixture-lane-secret')))throw Error('Secret entered environment');
fs.writeFileSync(process.env.TEST_CAPTURE,JSON.stringify({host,target,mode:fs.statSync(host).mode&511}));
if(process.env.TEST_SHA){const dir=process.env.LANE_RUNS_FOLDER+'/fixture/artifacts';fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(dir+'/landing.txt','Landed SHA: '+process.env.TEST_SHA+'\\nTarget: main\\n');}
${hold ? "setInterval(()=>{if(fs.existsSync(process.env.TEST_LANE_RELEASE))process.exit(Number(process.env.TEST_EXIT));},20);" : 'process.exit(Number(process.env.TEST_EXIT));'}
`, {mode: 0o755});
  f.config.preLaunch = [process.execPath, hook];
  f.config.preLaunchSecrets = true;
  save(f.configFile, f.config);
  assert.equal((await f.run()).code, 0);
  const [dir] = runDirectories(f.stateDir), file = path.join(dir, 'launch.json');
  return {...f, dir, file, notice, capture, release, laneRelease,
    env: {...f.env, TEST_NOTICE: notice, TEST_CAPTURE: capture, TEST_RELEASE: release,
      TEST_LANE_RELEASE: laneRelease, TEST_EXIT: String(exit), TEST_SHA: sha}};
}

for (const [name, code] of [['normal exit', 0], ['lane failure', 7]]) {
  test(`private hook files are removed after ${name}`, async t => {
    const f = await fixture(t, code);
    const result = await execute(worker, [f.file], f.env);
    const notice = read(f.notice), capture = read(f.capture);
    assert.equal(capture.target, '/run/secrets/cloud');
    assert.equal(capture.mode, 0o600);
    assert.equal(fs.existsSync(notice.dir), false);
    assert.equal(read(f.file).result.code, code, result.stderr);
    if (code === 0) assert.equal(read(f.file).result.completed, true);
    assert.ok(!notice.dir.startsWith(f.config.sourceRoot + path.sep));
    for (const name of ['launch.json', 'output.log', 'pre-launch.log'])
      assert.ok(!fs.readFileSync(path.join(f.dir, name), 'utf8').includes('fixture-lane-secret'));
  });
}

test('startup and hook failures remove private files without starting a lane', async t => {
  for (const failHook of [false, true]) {
    const f = await fixture(t);
    if (failHook) {
      const hook = read(f.file).config.preLaunch[1];
      fs.appendFileSync(hook, '\nprocess.exit(9);\n');
    } else {
      const run = read(f.file);
      run.config.context.token_file = path.join(f.root, 'missing-token');
      save(f.file, run);
    }
    const result = await execute(worker, [f.file], f.env);
    assert.equal(result.code, 2, result.stderr);
    assert.equal(fs.existsSync(read(f.notice).dir), false);
    assert.equal(fs.existsSync(f.capture), false);
  }
});

test('interrupting a secret-writing hook removes its private directory', async t => {
  const f = await fixture(t, 7, true);
  const child = spawn(process.execPath, [worker, f.file], {env: f.env, stdio: 'ignore'});
  const exited = new Promise(resolve => child.once('close', resolve));
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  await until(() => fs.existsSync(f.notice));
  const {dir} = read(f.notice);
  child.kill('SIGTERM');
  assert.equal(await exited, 2);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(fs.existsSync(f.capture), false);
});

test('one lane cannot mount another lane file or escape its private directory', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-validation-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  save(path.join(root, 'launch.json'), {});
  const config = {preLaunchSecrets: true, sourceRoot: root};
  const a = prepareRunSecrets({config}, root), b = prepareRunSecrets({config}, root);
  t.after(a.cleanup); t.after(b.cleanup);
  assert.deepEqual(a.mountArgs(), [], 'No manifest adds no mounts');
  const secret = path.join(a.dir, 'token');
  fs.writeFileSync(secret, 'private', {mode: 0o600});
  const row = {host_path: secret, container_path: '/run/secrets/cloud', mode: '0600'};
  save(path.join(b.dir, 'mounts.json'), [row]);
  assert.throws(b.mountArgs, /host_path must name a secret inside CREW_RUN_DIR/);
  assert.equal(fs.readFileSync(secret, 'utf8'), 'private');
  for (const invalid of [{...row, container_path: '/workspace/token'}, {...row, mode: '0644'},
    {...row, host_path: path.join(a.dir, 'launch.json')}, {...row, host_path: root}]) {
    save(path.join(a.dir, 'mounts.json'), [invalid]);
    assert.throws(a.mountArgs, /PRE_LAUNCH_SECRETS_INVALID/);
  }
  fs.symlinkSync(secret, path.join(b.dir, 'link'));
  save(path.join(b.dir, 'mounts.json'), [{...row, host_path: path.join(b.dir, 'link')}]);
  assert.throws(b.mountArgs, /regular file/);
  save(path.join(a.dir, 'mounts.json'), [row]);
  assert.deepEqual(a.mountArgs(), ['--mount-file', `${secret}:/run/secrets/cloud`]);
  assert.equal(prepareRunSecrets({config: {}}, root), null);
  assert.throws(() => prepareRunSecrets({config: {...config, readOnlyRepos: [os.tmpdir()]}}, root), /shared mount/);
  assert.throws(() => validatePreLaunch({preLaunchSecrets: true}), /requires preLaunch/);
  assert.throws(() => validatePreLaunch({preLaunchSecrets: 'true'}), /true or false/);
});

test('a peer container cannot see the hook file during writing or lane execution', {
  skip: !process.env.CREW_SECRET_DOCKER_IMAGE,
}, async t => {
  const f = await fixture(t, 7, true), image = process.env.CREW_SECRET_DOCKER_IMAGE;
  const docker = args => execFileSync('docker', args, {encoding: 'utf8', timeout: 30000});
  const peer = docker(['run', '--rm', '-d', '--network', 'none', '--entrypoint', '/bin/sh',
    '-v', `${f.config.sourceRoot}:/shared:ro`, image, '-c', 'sleep 120']).trim();
  t.after(() => { try { docker(['rm', '-f', peer]); } catch {} });
  const child = spawn(process.execPath, [worker, f.file], {env: f.env, stdio: 'ignore'});
  const exited = new Promise(resolve => child.once('close', resolve));
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  await until(() => fs.existsSync(f.notice));
  const notice = read(f.notice);
  docker(['exec', peer, 'test', '!', '-e', notice.file]);
  docker(['exec', peer, 'test', '!', '-e', '/shared/' + path.relative(f.config.sourceRoot, path.join(f.dir, 'token'))]);
  assert.equal(fs.existsSync(path.join(f.dir, 'token')), false);
  fs.writeFileSync(f.release, '');
  await until(() => fs.existsSync(f.capture));
  const mount = read(f.capture);
  docker(['exec', peer, 'test', '!', '-e', mount.host]);
  docker(['exec', peer, 'test', '!', '-e', mount.target]);
  docker(['run', '--rm', '--network', 'none', '--user', `${process.getuid()}:${process.getgid()}`, '--entrypoint', '/bin/sh',
    '--mount', `type=bind,src=${mount.host},dst=${mount.target},readonly`, image, '-c',
    'cat /run/secrets/cloud >/dev/null && ! (printf changed > /run/secrets/cloud)']);
  fs.writeFileSync(f.laneRelease, '');
  await exited;
  assert.equal(fs.existsSync(notice.dir), false);
});
