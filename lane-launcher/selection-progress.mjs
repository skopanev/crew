import path from 'node:path';
import {api} from './joppa-common.mjs';
import {readRun, runDirectories} from './runtime.mjs';

export function doneRuns(config, now = Date.now()) {
  let hour = 0, day = 0;
  for (const dir of runDirectories(config.stateDir)) {
    let run;
    try { run = readRun(path.join(dir, 'launch.json')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const result = run.result;
    if (result?.completed !== true || result.code !== 0 || result.pendingDelivery) continue;
    const age = now - Date.parse(result.recoveredAt || result.finishedAt);
    if (age >= 0 && age <= 86400000) day++;
    if (age >= 0 && age <= 3600000) hour++;
  }
  return {hour, day};
}

export async function selectionProgress(config, selected, {now = Date.now(), read = (tool, args) =>
  api(config, selected.worker, tool, {workspace: config.workspace, ...args})} = {}) {
  const {hour, day} = doneRuns(config, now);
  const suffix = ` · DONE 60m: ${hour} · 24h: ${day}`;
  try {
    if (!selected.criterionKinds?.length) throw new Error('The schema has no criterion type');
    const {parent = '*', depth} = config.joppa.filter || {};
    const count = await read('joppa_objects', {kind: selected.criterionKinds, parent,
      ...(depth !== undefined ? {depth} : {}), group_by: ['stage']});
    if (!Number.isSafeInteger(count.total) || count.total < 0 || !Array.isArray(count.groups) ||
      count.groups.some(group => !Number.isSafeInteger(group.count) || group.count < 0) ||
      count.groups.reduce((sum, group) => sum + group.count, 0) !== count.total) {
      throw new Error('Joppa returned incomplete stage counts');
    }
    const done = count.groups.filter(group => group.stage === 'done').reduce((sum, group) => sum + group.count, 0);
    const percent = count.total ? Math.round(done * 100 / count.total) : 0;
    return {line: `Progress: done ${done}/${count.total} (${percent}%)${suffix}`};
  } catch (error) {
    return {line: `Progress: unavailable${suffix}`, error: `PROGRESS_UNAVAILABLE: ${error.message}`};
  }
}
