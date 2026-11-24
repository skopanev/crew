// Complete an AC from current native evidence before models or develop trees run.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {metadataFindings} from './test-bindings.mjs';
const require = (ok, message) => { if (!ok) throw new Error(message); };
const data = node => node.document?.data || node.data || {};
const present = node => node.document?.present ?? node.present;
const tone = node => node.status?.tone || node.status;
export function passingTests(input, children) {
  const tests = children.filter(node => input.schema.types[node.kind]?.role === "test" && present(node));
  return tests.length > 0 && tests.every(node => tone(node) === "green" && node.result?.status === "pass" &&
    /^[a-f0-9]{40}$/.test(node.result.commit || ""));
}
export function decision(input, ac, children, held, stages) {
  if (input.schema.types[ac.kind]?.role !== 'ac') return 'CONTINUE';
  if (held || children.some(node => input.schema.types[node.kind]?.role === 'task' && present(node) && stages.active.includes(data(node).stage))) return 'WAIT';
  if (data(ac).stage === stages.done) return ['blue', 'yellow', 'orange'].includes(tone(ac)) ? 'CONTINUE' : 'WAIT';
  if (![stages.ready, stages.implement].includes(data(ac).stage)) return 'WAIT';
  return passingTests(input, children) ? "DONE" : "CONTINUE";
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
  const output = path.join(dir, config.publication.file);
  const block = (reason_code, reason) => {
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({status: 'blocked', reason_code,
      reason, claim_released: false, acceptance_verified: false}));
    console.log(`<signal:BLOCKED>${reason}</signal:BLOCKED>`);
  };
  const code = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output)).outcome?.reason_code : null;
  if (mode === 'verify' && !['AC_DONE', 'TASK_TEST_METADATA'].includes(code)) return;
  const runtime = path.dirname(path.dirname(env.CREW_FLOW_STAGES));
  const api = await import(pathToFileURL(path.join(runtime, 'lane-launcher/joppa-api.mjs')).href);
  const {runHoldsTasks} = await import(pathToFileURL(path.join(runtime, 'lane-launcher/joppa.mjs')).href);
  const {runTasks} = await import(pathToFileURL(path.join(runtime, 'lane-launcher/joppa-common.mjs')).href);
  const {runDirectories, readRun} = await import(pathToFileURL(path.join(runtime, 'lane-launcher/runtime.mjs')).href);
  const {scopeDirectory} = await import(pathToFileURL(path.join(runtime, 'lane-launcher/scope.mjs')).href);
  const read = (tool, args) => api.readJoppa(config.url, config.token_file, tool, {workspace: config.workspace, ...args}, {mcpCommand: config.mcp_command});
  const metadata = async selected => {
    const parent = await read('joppa_objects', {address: selected.document.parent});
    require(parent.historical === false && present(parent), 'Current Task parent is required');
    const children = [], seen = new Set(); let cursor;
    const kinds = Object.keys(input.schema.types).filter(kind => input.schema.types[kind].role === 'test');
    do {
      const page = await read('joppa_objects', {parent: parent.address, depth: 1, kind: kinds,
        status: ['red', 'yellow', 'orange', 'blue', 'green'],
        fields: ['revision', 'parent', 'title', 'body', 'command'], limit: 25, ...(cursor ? {cursor} : {})});
      require(Array.isArray(page.items), 'Task Test inventory is unavailable');
      children.push(...page.items);
      cursor = page.next_cursor;
      require(!cursor || !seen.has(cursor), 'Test pagination did not advance'); seen.add(cursor);
    } while (cursor);
    return {parent, children};
  };
  if (input && input.schema.types[input.selected.kind]?.role === 'task') {
    const findings = metadataFindings(input);
    if (mode === 'verify') {
      const current = await metadata(input.selected);
      require(current.parent.current_revision === input.context.parent.current_revision &&
        metadataFindings({...input, context: current}).length > 0, 'Task metadata evidence changed before publication');
      return;
    }
    require(mode === 'prepare', 'Use prepare or verify for the claimed Task');
    if (!findings.length) { console.log('<signal:CONTINUE>Task repair.</signal:CONTINUE>'); return; }
    const parent = input.context.parent, stage = config.vars.TASKER_TEST_RETURN_STAGE;
    require(!data(parent).assignee, 'Task parent is held');
    require(typeof stage === 'string' && input.schema.types[parent.kind]?.fields?.stage?.values?.includes(stage),
      'The configured Test return stage is absent from the parent schema');
    const reason = 'Return incomplete Test metadata to Writer. ' + findings.map(f => f.target + ': ' + f.problem).join(' ');
    const dry = env.DRY_RUN === 'true';
    const value = {operations: dry ? [] : [
      {command: {op: 'save_object', kind: parent.kind, id: parent.address.split(':')[1],
        revision: parent.current_revision, data: {stage}, reason: reason.slice(0, 1000)}},
      {command: {op: 'note', target: input.selected.address,
        id: ('tasker-metadata-' + path.basename(env.MEDULLA_RUN_DIR)).slice(-120), text: reason + '\n' + JSON.stringify(findings)}}],
      outcome: {status: 'blocked', reason_code: dry ? 'DRY_RUN' : 'TASK_TEST_METADATA', reason: reason.slice(0, 1000)}};
    fs.writeFileSync(output + '.tmp', JSON.stringify(value)); fs.renameSync(output + '.tmp', output);
    console.log('<signal:DECISION>Return Test metadata through the guarded shared publication.</signal:DECISION>');
    return;
  }
  if (mode === 'preclaim') {
    const schema = (await read('joppa_tree', {})).schema;
    const selected = await read('joppa_objects', {address: env.PLANNING_JOPPA_ITEM});
    input = {workspace: config.workspace, schema, selected};
    if (schema.types[selected.kind]?.role === 'task') {
      const {dependencyCheck} = await import(pathToFileURL(path.join(runtime, 'lane-launcher/dependencies.mjs')).href);
      try {
        const dependencies = dependencyCheck(async (tool, args) => {
          const target = tool === 'joppa_tree' ? {schema} : args.address === selected.address ? selected : await read(tool, args);
          if (tool === 'joppa_objects' && target?.address === args.address && target.historical === false &&
              Number.isSafeInteger(target.current_revision) && schema.types[target.kind]?.role === 'task' &&
              present(target) === false && !data(target).commit) {
            throw Object.assign(new Error('Archived prerequisite has no delivered commit: ' + target.address), {code:'TASK_PREREQUISITE_ARCHIVED'});
          }
          return target;
        });
        const dependency = await dependencies(selected.address);
        if (!dependency.ready) { block('TASK_PREREQUISITE', 'Prerequisite is not ready: ' + dependency.blocker); return; }
      } catch (error) {
        if (error.code !== 'TASK_PREREQUISITE_ARCHIVED') throw error;
        block(error.code, error.message); return;
      }
      const context = await metadata(selected);
      if ([config.vars.TASKER_RETURN_STAGE, config.vars.TASKER_TEST_RETURN_STAGE].filter(Boolean).includes(data(context.parent).stage)) {
        block('AC_STAGE', 'Task parent awaits its configured correction stage: ' + data(context.parent).stage); return;
      }
      fs.mkdirSync(dir, {recursive: true});
      fs.writeFileSync(path.join(dir, 'metadata-preclaim.json'), JSON.stringify({findings: metadataFindings({...input, context})}));
      console.log('<signal:CONTINUE>Task prerequisites and metadata were read before claim.</signal:CONTINUE>'); return;
    }
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
      block(detail.reason_code, detail.reason);
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
