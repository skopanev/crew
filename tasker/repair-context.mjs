// Capture the immutable AC pin of an existing Task and build its reviewed native operations.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {contractHash} from './test-bindings.mjs';
import {retirementBinding} from './retirement-proof.mjs';
import {hostSplitReceipt} from './host-split-replan.mjs';
import {pathToFileURL} from 'node:url';
import {changedText, repairView, repairPublication, repositoryData} from './repair-plan.mjs';

export function bodyProblems(body, checker) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tasker-body-'));
  try {
    const file = path.join(root, 'ticket.json');
    fs.writeFileSync(file, JSON.stringify({address:'draft', body}));
    return ['tests-line','restriction-line'].flatMap(mode => {
      const output = execFileSync(process.execPath, [checker, mode, file], {encoding:'utf8'}).trim();
      return output ? [output] : [];
    });
  } finally { fs.rmSync(root, {recursive:true, force:true}); }
}

export async function captureRepair(input, read) {
  const task = input.selected, parent = input.context.parent;
  const pin = /^Criterion: ([^\s@]+)@([1-9]\d*)[.\s]/m.exec(task.document.data.body || '');
  if (pin && pin[1] !== parent.address) throw new Error('The Task Criterion names another parent');
  const revision = pin ? Number(pin[2]) : null;
  const hash = task.document.data.ac_contract_hash;
  if (hash != null && (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))) throw new Error('The Task contract hash is invalid');
  const pinned = pin && hash == null ? await read(parent.address, revision) : null;
  if (pinned && pinned.address !== parent.address) throw new Error('The pinned AC read returned another address');
  const dependencies = [];
  for (const link of task.document.links ?? []) {
    if (link.relation !== 'depends_on' || link.blocking !== true || link.workspace !== undefined) continue;
    const target = await read(link.target);
    if (target?.address !== link.target || target.historical === true || typeof target.document?.present !== 'boolean') {
      throw new Error('The dependency read returned absent or historical context: ' + link.target);
    }
    dependencies.push(target);
  }
  const current = contractHash({selected: parent, children: input.context.children, schema: input.schema});
  return {pinned_revision:revision, pinned, dependencies, ac_text_changed: hash == null ? changedText(parent,pinned) : current !== hash,
    ...(hash == null ? {baseline_note: 'Legacy Task: ' + (pinned ? 'compared the historical AC title, body and Source references.' : 'no historical AC pin is available.') + ' Historical Test texts are unavailable and were not compared.'} : {})};
}

async function main() {
  const [mode, dir] = process.argv.slice(2), read = name => JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'));
  const input = read('input.json');
  const readCurrent = async (address, revision) => {
    const config = JSON.parse(fs.readFileSync(process.env.PLANNING_JOPPA_CONFIG,'utf8'));
    const engine = path.dirname(path.dirname(process.env.CREW_FLOW_STAGES));
    const {readJoppa} = await import(pathToFileURL(path.join(engine,'lane-launcher/joppa-api.mjs')).href);
    return readJoppa(config.url,config.token_file,'joppa_objects',
      {workspace:input.workspace,address,...(revision ? {revision} : {})},{mcpCommand:config.mcp_command});
  };
  if (mode === 'repository') {
    const task = input.schema?.types?.[input.selected.kind]?.role === 'task';
    console.log(JSON.stringify(task && process.env.DRY_RUN !== 'true' ? repositoryData(input, input.selected) : {}));
    return;
  }
  if (mode === 'publication') {
    const draft = read('draft.json'), digest = createHash('sha256').update(fs.readFileSync(path.join(dir,'draft.json'))).digest('hex');
    const repair = read('repair.json');
    if (draft.verdict === 'READY') for (const dependency of repair.dependencies ?? []) {
      const current = await readCurrent(dependency.address);
      if (current?.address !== dependency.address || current.historical === true || current.current_revision !== dependency.current_revision) {
        console.log(JSON.stringify({approved:false,critique:{host:{invalid:'The dependency changed during repair: ' + dependency.address}}}));
        return;
      }
    }
    console.log(JSON.stringify(repairPublication({input, draft, repair, trees:read('trees.json'),
      reviews:[read('critic-codex.json'), read('critic-second.json')], digest,
      gapTags:JSON.parse(process.env.TASKER_GAP_TAGS || '{}'),
      run:path.basename(path.dirname(dir)), dry:process.env.DRY_RUN==='true'})));
    return;
  }
  if (mode !== 'prepare') throw new Error('repair-context needs prepare, publication or repository');
  const repair = await captureRepair(input,readCurrent);
  const trees = read('trees.json');
  const split = hostSplitReceipt({input, repair, trees});
  if (split) repair.split_replan = split;
  fs.writeFileSync(path.join(dir,'repair.json'),JSON.stringify(repair,null,2)+'\n');
  const view = repairView(input,repair);
  view.repair.retirement_binding = retirementBinding(input, trees);
  console.log(JSON.stringify({...view,develop_trees:Object.fromEntries(Object.entries(trees).map(([id,tree])=>[id,{path:tree.path,sha:tree.sha}]))}));
}
if (import.meta.url===pathToFileURL(process.argv[1]||'').href) {
  main().catch(error=>{console.error('tasker-repair: '+error.message);process.exitCode=2;});
}
