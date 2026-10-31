// Dispatcher fixture: a real launcher config around the Joppa package server.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {save} from '../runtime.mjs';
import {scopeDirectory} from '../scope.mjs';
import {packageFixture} from './launcher-joppa.fixture.mjs';

const launcher = fileURLToPath(new URL('../launcher.mjs', import.meta.url));
const worker = fileURLToPath(new URL('../worker.mjs', import.meta.url));

// One dispatcher pass reads the available Task queue once per free worker.
const queueReads = f => f.calls.filter(call => call.name === 'joppa_tasks' && call.args.view === 'available').length;

function execute(script, args, env, {bin = process.execPath, cwd} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [script, ...args], {env, cwd});
    let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data);
    child.stderr.on('data', data => stderr += data);
    child.on('error', reject);
    child.on('close', code => resolve({code, stdout, stderr}));
  });
}
function notificationEnv(f, stateFile, sentFile, fail = false) {
  const preload = path.join(f.root, 'telegram-fixture.mjs');
  fs.writeFileSync(preload, `import fs from 'node:fs';
const original = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (!String(url).startsWith('https://api.telegram.org/')) return original(url, options);
  if (!JSON.parse(fs.readFileSync(process.env.TEST_RESULT)).result) throw new Error('completion not saved');
  fs.writeFileSync(process.env.TEST_NOTIFY, options.body);
  if (process.env.TEST_NOTIFY_FAILURE === '1') throw new Error('fixture delivery failure');
  return {ok: true, json: async () => ({ok: true})};
};
`);
  return {...f.env, TEST_RESULT: stateFile, TEST_NOTIFY: sentFile, TELEGRAM_BOT_TOKEN: 'fixture-token',
    TEST_NOTIFY_FAILURE: fail ? '1' : '0', NODE_OPTIONS: `--import=${preload}`};
}
// A claimed Joppa package whose lane process is the given shell script.
async function workerFixture(t, script, config = {}) {
  const f = await packageFixture(t);
  const bins = path.join(f.root, 'bins'), worktreeRoot = path.join(f.root, 'worktrees');
  fs.mkdirSync(bins);
  fs.mkdirSync(worktreeRoot);
  fs.writeFileSync(path.join(bins, 'bash'), `#!/bin/sh\n${script}`, {mode: 0o755});
  f.run.config.repositories[0].gateCommands = ['true'];
  Object.assign(f.run.config, {worktreeRoot, readOnlyRepos: [], gateCommands: ['true'], sshDir: f.root, ...config});
  Object.assign(f.run, {ticket: 'task:t1', pane: 'owned-pane'});
  f.persist();
  return {...f, bins, env: {...process.env, PATH: `${bins}:${process.env.PATH}`}};
}
async function setup(t, {empty = false, dockerFailure = false, launchLanes = true} = {}) {
  const joppa = await packageFixture(t);
  if (empty) joppa.queue.length = 0;
  const root = joppa.root;
  const bins = path.join(root, 'bin'), sources = path.join(root, 'sources'), repo = path.join(sources, 'app');
  for (const dir of [bins, path.join(repo, '.git'), path.join(root, 'ssh'), path.join(sources, 'locks'),
    path.join(root, 'cbm-cache'), path.join(root, 'tokens'), ...['src/a', 'src/b', 'tests/a', 'tests/b'].map(dir => path.join(repo, dir))]) {
    fs.mkdirSync(dir, {recursive: true});
  }
  fs.writeFileSync(path.join(root, 'cbm-mcp.py'), '# connector fixture\n');
  // Worker tokens stay outside every directory a lane can mount.
  const tokenFile = path.join(root, 'tokens/lane-1');
  fs.writeFileSync(tokenFile, 'fixture-token', {mode: 0o600});
  const events = path.join(root, 'events.jsonl'), panes = path.join(root, 'panes.json');
  fs.writeFileSync(panes, '[]');
  const herdr = path.join(bins, 'herdr');
  fs.writeFileSync(herdr, `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_EVENTS, JSON.stringify(args) + '\\n');
const panes = JSON.parse(fs.readFileSync(process.env.TEST_PANES));
let result = {};
if (args[0] === 'tab' && args[1] === 'create') {
  if (process.env.TEST_CREATE_FAILURE === '1') process.exit(1);
  panes.push({pane_id: 'test-pane'});
  fs.writeFileSync(process.env.TEST_PANES, JSON.stringify(panes));
  result = {root_pane: {pane_id: 'test-pane'}};
}
if (args[1] === 'list') result = {panes};
if (args[1] === 'close' && process.env.TEST_RESULT) {
  if (!JSON.parse(fs.readFileSync(process.env.TEST_RESULT)).result) process.exit(2);
}
if (args[0] === 'pane' && ['run', 'close'].includes(args[1])) process.exit(0);
console.log(JSON.stringify({result}));
`, {mode: 0o755});
  fs.writeFileSync(path.join(bins, 'docker'), '#!/bin/sh\nif [ "$TEST_DOCKER_FAILURE" = 1 ]; then exit 1; fi\ncat "$TEST_DOCKER"\n', {mode: 0o755});
  for (const bin of ['medulla', 'jq']) fs.writeFileSync(path.join(bins, bin), '#!/bin/sh\nexit 0\n', {mode: 0o755});
  const docker = path.join(root, 'docker.jsonl');
  fs.writeFileSync(docker, '');
  const config = {id: 'test-project', workspace: 'fixture', launchLanes, sourceRoot: sources,
    joppa: {url: joppa.run.config.joppa.url, project: 'project:app', workers: [{actor: 'lane-1', tokenFile}]},
    repositories: [{id: 'app', path: repo, targetBranch: 'main', cbmProject: 'app', preflight: null,
      modules: joppa.run.config.repositories[0].modules, gateCommands: ['true'], testCommand: ['true']}],
    worktreeRoot: path.join(sources, 'worktrees'),
    cbmMcpCommand: path.join(root, 'cbm-mcp.py'), cbmCacheDir: path.join(root, 'cbm-cache'), sshDir: path.join(root, 'ssh'),
    sharedLockDir: path.join(sources, 'locks'),
    stateDir: path.join(root, 'state'), herdr, herdrWorkspace: 'different-config-workspace'};
  const configFile = path.join(root, 'config.json');
  save(configFile, config);
  const env = {...process.env, PATH: `${bins}:${process.env.PATH}`,
    HERDR_WORKSPACE_ID: 'workspace',
    TEST_EVENTS: events, TEST_PANES: panes, TEST_DOCKER: docker,
    TEST_DOCKER_FAILURE: dockerFailure ? '1' : '0'};
  return {root, config, stateDir: scopeDirectory(config.stateDir, config.id), configFile, env, calls: joppa.calls,
    joppa, events, docker, bins,
    run: () => execute(launcher, ['--config', configFile, '--once'], env)};
}


export {launcher, worker, queueReads, execute, notificationEnv, setup, workerFixture};
