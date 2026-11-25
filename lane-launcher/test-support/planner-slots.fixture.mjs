import fs from 'node:fs';
import path from 'node:path';
import {plannerFixture, pause} from './config-reload.fixture.mjs';
import {detachedRuns, dispatcherId, stopDetachedRun} from '../../planning-joppa/detached-runs.mjs';
import {plannerConfig, plannerIdentity} from '../../planning-joppa/planner-config.mjs';

export async function slotsFixture(t, options = {}) {
  let cleanup = async () => {};
  t.after(() => cleanup());
  const f = await plannerFixture(t, {execution: 'detached', ...options}, 0,
    '#!/bin/sh\nexec "$TEST_NODE" "$TEST_PASS" "$3" "$5"\n');
  const workflow = path.join(f.root, 'workflow.yaml'), pass = path.join(f.root, 'pass.cjs');
  fs.writeFileSync(workflow, 'nodes: {}\n');
  const template = structuredClone(f.objects.get('ac:a1'));
  template.address = 'ac:a3'; f.objects.set(template.address, template);
  for (const [id, repository] of [['ac:a1', 'alpha'], ['ac:a2', 'beta'], ['ac:a3', 'alpha']]) {
    Object.assign(f.objects.get(id).document.data, {repository, stage: 'pending', delivery: {state: 'pending', branch: id}});
  }
  Object.assign(f.config, {workflow, selection: {kind: 'ac', data: {stage: 'pending'}},
    slots: [{label: 'A', data: {repository: 'alpha'}}, {label: 'B', data: {repository: 'beta'}}]});
  f.write(f.config);
  fs.writeFileSync(pass, `const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const config=JSON.parse(fs.readFileSync(process.argv[2])),address=process.argv[3];
const index=Number(process.env.PLANNING_JOPPA_INPUT),slot=config.slots[index].label;
const folder=path.join(config.runs_folder,'2026-11-25_12-00-00-'+randomUUID());
fs.mkdirSync(path.join(folder,'artifacts'),{recursive:true});
fs.writeFileSync(path.join(folder,'.lock'),String(process.pid));
fs.writeFileSync(path.join(folder,'artifacts/input.json'),JSON.stringify({workspace:'fixture',slot,
 selected:{address,current_revision:2,document:{data:{title:address,repository:config.slots[index].data.repository}}}}));
console.log(folder);
fs.appendFileSync(process.env.TEST_PASSES,JSON.stringify({address,slot,pid:process.pid,folder})+'\\n');
const finish=()=>{fs.writeFileSync(path.join(folder,'artifacts/result.json'),
 JSON.stringify({status:'published',selected_revision:3}));process.exit(0);};
process.on('SIGTERM',finish);
setInterval(()=>{if(fs.existsSync(path.join(process.env.TEST_RELEASE,address)))finish();},30);
`);
  const release = path.join(f.root, 'release'); fs.mkdirSync(release);
  Object.assign(f.env, {TEST_NODE: process.execPath, TEST_PASS: pass, TEST_RELEASE: release});
  const owner = dispatcherId(plannerIdentity(plannerConfig(f.configFile)));
  const runs = () => detachedRuns(f.config.runs_folder, owner);
  cleanup = async () => {
    for (const run of runs().filter(run => run.active)) {
      try { stopDetachedRun(f.config.runs_folder, owner, path.basename(run.folder)); } catch {}
    }
    for (let i = 0; i < 100 && runs().some(run => run.active); i++) await pause(30);
  };
  return {...f, owner, runs, starts: () => f.passes().map(line => JSON.parse(line)),
    release: address => fs.writeFileSync(path.join(release, address), '')};
}
