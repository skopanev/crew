// Complete an AC from current native evidence before models or develop trees run.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const require = (ok, message) => { if (!ok) throw new Error(message); };
const data = node => node.document?.data || node.data || {};
const present = node => node.document?.present ?? node.present;
const tone = node => node.status?.tone || node.status;
export function decision(input, ac, children, held, stages) {
  if (input.schema.types[ac.kind]?.role !== 'ac') return 'CONTINUE';
  if (held || children.some(node => input.schema.types[node.kind]?.role === 'task' && present(node) && stages.active.includes(data(node).stage))) return 'WAIT';
  if (data(ac).stage === stages.done) return ['blue', 'yellow', 'orange'].includes(tone(ac)) ? 'CONTINUE' : 'WAIT';
  if (![stages.ready, stages.implement].includes(data(ac).stage)) return 'WAIT';
  if (data(ac).stage !== stages.implement) return 'CONTINUE';
  const tests = children.filter(node => input.schema.types[node.kind]?.role === 'test' && present(node));
  return tests.length && tests.every(node => tone(node) === 'green' && node.result?.status === 'pass' &&
    /^[a-f0-9]{40}$/.test(node.result.commit || '')) ? 'DONE' : 'CONTINUE';
}
export async function inspect(input, read, runs, stages, holds, tasks, detail = {}) {
  const ac = await read('joppa_objects', {address: input.selected.address});
  require(ac.address === input.selected.address && ac.historical === false && present(ac), 'Current AC evidence is required');
  const kinds = Object.keys(input.schema.types).filter(kind => ['test', 'task'].includes(input.schema.types[kind].role));
  const children = [], seen = new Set(); let cursor;
  do {
    const page = await read('joppa_objects', {parent: ac.address, depth: 1, kind: kinds,
      status: ['red', 'yellow', 'orange', 'blue', 'green'], fields: ['revision', 'parent'], limit: 25, ...(cursor ? {cursor} : {})});
    require(Array.isArray(page.items), 'Child inventory is unavailable');
    for (const row of page.items) {
      const node = await read('joppa_objects', {address: row.address});
      require((node.document?.parent ?? node.parent) === ac.address && node.historical === false, 'Child context changed');
      children.push(node);
    }
    cursor = page.next_cursor;
    require(!cursor || !seen.has(cursor), 'Child pagination did not advance'); seen.add(cursor);
  } while (cursor);
  let held = false;
  for (const run of runs.filter(holds)) {
    if (run.workspace && run.workspace !== input.workspace) continue;
    const currentTasks = [];
    for (const task of tasks(run)) {
      require(task.address, 'Held lane lacks a Task address');
      const current = await read('joppa_objects', {address: task.address});
      require(current.address === task.address && current.historical === false, 'Current lane Task evidence is required');
      currentTasks.push(current);
    }
    if (!holds(run, currentTasks)) continue;
    if (currentTasks.some(current => present(current) && (current.document?.parent ?? current.parent) === ac.address)) {
      held = true;
      detail.reason_code = 'HELD_RUN';
      detail.reason = `held by run ${run.runId || run.executionId || run.task}: ${currentTasks.map(node => node.address).join(', ')}`;
    }
  }
  const live = children.find(node => input.schema.types[node.kind]?.role === 'task' && present(node) && stages.active.includes(data(node).stage));
  if (live && !held) { detail.reason_code = 'LIVE_TASK'; detail.reason = `live task ${live.address}`; }
  if (!held && !live) { detail.reason_code = 'AC_STAGE'; detail.reason = `AC stage ${data(ac).stage}, status ${tone(ac)}`; }
  return decision(input, ac, children, held, stages);
}
async function main() {
  const [mode] = process.argv.slice(2), env = process.env;
  const dir = path.join(env.MEDULLA_RUN_DIR, 'artifacts'), load = name => JSON.parse(fs.readFileSync(path.join(dir, name + '.json')));
  const config = JSON.parse(fs.readFileSync(env.PLANNING_JOPPA_CONFIG));
  let input = mode === 'preclaim' ? null : load('input');
  if (input && input.schema.types[input.selected.kind]?.role !== 'ac') { if (mode === 'prepare') console.log('<signal:CONTINUE>Task repair.</signal:CONTINUE>'); return; }
  const output = path.join(dir, config.publication.file);
  if (mode === 'verify' && (!fs.existsSync(output) || JSON.parse(fs.readFileSync(output)).outcome?.reason_code !== 'AC_DONE')) return;
  const runtime = path.dirname(path.dirname(env.CREW_FLOW_STAGES));
  const api = await import(pathToFileURL(path.join(runtime, 'lane-launcher/joppa-api.mjs')).href);
  const {runHoldsTasks} = await import(pathToFileURL(path.join(runtime, 'lane-launcher/joppa.mjs')).href);
  const {runTasks} = await import(pathToFileURL(path.join(runtime, 'lane-launcher/joppa-common.mjs')).href);
  const {runDirectories, readRun} = await import(pathToFileURL(path.join(runtime, 'lane-launcher/runtime.mjs')).href);
  const {scopeDirectory} = await import(pathToFileURL(path.join(runtime, 'lane-launcher/scope.mjs')).href);
  const read = (tool, args) => api.readJoppa(config.url, config.token_file, tool, {workspace: config.workspace, ...args}, {mcpCommand: config.mcp_command});
  if (mode === 'preclaim') {
    const schema = (await read('joppa_tree', {})).schema;
    const selected = await read('joppa_objects', {address: env.PLANNING_JOPPA_ITEM});
    input = {workspace: config.workspace, schema, selected};
    if (schema.types[selected.kind]?.role !== 'ac') { console.log('<signal:CONTINUE>Task repair.</signal:CONTINUE>'); return; }
  }
  const lane = JSON.parse(fs.readFileSync(config.vars.TASKER_LANE_CONFIG));
  require(lane.workspace === config.workspace && lane.joppa?.url === config.url, 'Lane inventory belongs to another tracker workspace');
  const runs = runDirectories(scopeDirectory(lane.stateDir, lane.id)).map(folder => ({...readRun(path.join(folder, 'launch.json')), runId: path.basename(folder)}));
  const stages = {ready: config.vars.TASKER_READY_STAGE, implement: config.vars.TASKER_IMPLEMENT_STAGE, done: config.vars.TASKER_DONE_STAGE,
    active: [config.vars.TASK_STAGE, config.vars.TASKER_TASK_REVIEW_STAGE]};
  require(Object.values(stages).flat().every(value => typeof value === 'string' && value), 'Configure Tasker stages');
  const detail = {};
  const result = await inspect(input, read, runs, stages, runHoldsTasks, runTasks, detail);
  if (mode === 'verify') { require(result === 'DONE', 'AC completion evidence changed before publication'); return; }
  if (mode === 'preclaim') {
    if (result === 'WAIT') {
      fs.mkdirSync(dir, {recursive: true});
      fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({status: 'blocked', reason_code: detail.reason_code,
        reason: detail.reason, claim_released: false, acceptance_verified: false}));
      console.log(`<signal:BLOCKED>${detail.reason}</signal:BLOCKED>`);
    } else console.log('<signal:CONTINUE>The AC can be claimed.</signal:CONTINUE>');
    return;
  }

  require(mode === 'prepare', 'Use prepare or verify');
  if (result === 'CONTINUE') { console.log('<signal:CONTINUE>Normal Tasker path.</signal:CONTINUE>'); return; }
  const done = result === 'DONE' && env.DRY_RUN !== 'true';
  const value = {operations: done ? [{command: {op: 'save_object', kind: input.selected.kind, id: input.selected.address.split(':')[1],
    revision: input.claim_revision, data: {stage: stages.done, returns: 0}, reason: 'Every current Test has a recorded passing result and no Task or lane remains.'}}] : [],
    outcome: {status: done ? 'published' : 'blocked', reason_code: done ? 'AC_DONE' : result === 'WAIT' ? detail.reason_code : 'AC_WAIT', reason: done ? 'The AC is verified.' : detail.reason}};
  fs.writeFileSync(output + '.tmp', JSON.stringify(value)); fs.renameSync(output + '.tmp', output);
  console.log('<signal:DECISION>Publish the guarded host decision.</signal:DECISION>');
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch(error => { console.error('tasker-completion: ' + error.message); process.exitCode = 1; });
