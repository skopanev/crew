import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const lander = fileURLToPath(new URL('..', import.meta.url));
for (const scenario of ['published', 'unreleased', 'recovery', 'other-blocked', 'accepted', 'cleanup-failed']) {
  test(`the workflow finishes a published Task rejection safely: ${scenario}`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lander-rejection-route-'));
    t.after(() => fs.rmSync(root, {recursive:true, force:true}));
    const checkouts = path.join(root, 'checkouts'), checkout = path.join(checkouts, 'lander-fixture');
    fs.mkdirSync(checkout, {recursive:true});
    const stat = fs.lstatSync(checkout);
    const result = {status:'blocked', reason_code:scenario === 'other-blocked' ? 'PUSH_FAILED' : 'TASK_REJECTED',
      reason:'0 of 5 heads landed. TASK_REJECTED', claim_released:scenario !== 'unreleased',
      ...(scenario === 'recovery' ? {needs_recovery:true} : {})};
    const state = {repository:'fixture', checkout, dev:stat.dev,
      ino:scenario === 'cleanup-failed' ? stat.ino + 1 : stat.ino,
      accepted:scenario === 'accepted' ? [{address:'task:fixture'}] : [], pending:result.reason_code};
    const configFile = path.join(root, 'config.json');
    fs.writeFileSync(configFile, JSON.stringify({repositories:[{id:'fixture'}]}));
    const fixture = path.join(root, 'fixture.json');
    fs.writeFileSync(fixture, JSON.stringify({result, lander:state, input:{}}));
    const seed = path.join(root, 'seed.mjs');
    fs.writeFileSync(seed, `import fs from 'node:fs'; import path from 'node:path';
const artifacts=path.join(process.env.MEDULLA_RUN_DIR,'artifacts');
fs.mkdirSync(artifacts,{recursive:true});
for(const [name,value] of Object.entries(JSON.parse(fs.readFileSync(process.env.TEST_FIXTURE))))
  fs.writeFileSync(path.join(artifacts,name+'.json'),JSON.stringify(value));
console.log('<signal:BLOCKED>The Task rejection was published.</signal:BLOCKED>');
`);
    const workflow = path.join(root, 'workflow.yaml');
    fs.writeFileSync(workflow, fs.readFileSync(path.join(lander, 'workflow.yaml'), 'utf8')
      .replace('start: prepare', 'start: fixture') + `
  fixture:
    shell: '"$TEST_NODE" "$TEST_SEED"'
    on_signal:
      BLOCKED: complete_ac
      __failed__: __exit_fail__
      __default__: __exit_fail__
`);
    const runs = path.join(root, 'runs');
    const env = {...process.env, TEST_NODE:process.execPath, TEST_SEED:seed, TEST_FIXTURE:fixture,
      CREW_FLOW_WORKFLOW_DIR:lander, PLANNING_JOPPA_CONFIG:configFile};
    delete env.MEDULLA_RUN_ID;
    const run = spawnSync('medulla', ['-w',workflow,'--runs-folder',runs,'--var','WORKTREE_ROOT=' + checkouts],
      {env, encoding:'utf8', timeout:30_000});
    assert.ifError(run.error);
    const folders = fs.readdirSync(runs).filter(name => fs.existsSync(path.join(runs,name,'outcome.json')));
    assert.equal(folders.length,1,run.stdout + run.stderr);
    const runDir = path.join(runs,folders[0]);
    const outcome = JSON.parse(fs.readFileSync(path.join(runDir,'outcome.json')));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runDir,'artifacts/result.json'))),result);
    if (scenario === 'published') {
      assert.equal(run.status,0,run.stdout + run.stderr);
      assert.equal(outcome.outcome,'succeeded');
      assert.equal(outcome.error,undefined);
    } else {
      assert.notEqual(run.status,0,run.stdout + run.stderr);
      assert.equal(outcome.outcome,'failed');
      assert.equal(outcome.error.node,scenario === 'cleanup-failed' ? 'clean_success' : 'clean_failure');
    }
    assert.equal(fs.existsSync(checkout),scenario === 'cleanup-failed');
  });
}
