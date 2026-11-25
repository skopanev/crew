import fs from 'node:fs';
import path from 'node:path';
import {readRun, runDirectories} from './runtime.mjs';
import {branchOutcome} from './branch-outcome.mjs';
import {avgPace} from './avg-pace.mjs';

export const dolberPaceRows = runs => runs.map(run => ({runId: run.dir || run.runFolder,
  start: run.worker?.startedAt || run.createdAt, end: run.result?.finishedAt || run.result?.recoveredAt,
  active: !run.result, paceCount: run.result?.code === 0 && !run.result.held && !run.result.blocked &&
    (run.result.status === 'exited' || branchOutcome(run)) ? 1 : 0}));

export function dolberPace(config) {
  return avgPace(dolberPaceRows(runDirectories(config.stateDir).flatMap(dir => {
    const file = path.join(dir, 'launch.json');
    return fs.existsSync(file) ? [{dir, ...readRun(file)}] : [];
  })));
}
