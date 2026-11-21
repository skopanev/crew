// Dispatch the same worker through Herdr or as a detached host process.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {startDetached} from './detached-process.mjs';
import {save, quote, herdr} from './runtime.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function dispatchLane(config, run, stateFile) {
  if (config.lanes === 'headless') {
    const log = fs.openSync(path.join(path.dirname(stateFile), 'output.log'), 'a', 0o600);
    try {
      await startDetached(process.execPath, [path.join(here, 'worker.mjs'), stateFile],
        {cwd: path.dirname(here), stdio: ['ignore', 'ignore', log]});
    } catch (error) {
      save(stateFile, {...run, result: {status: 'failed', error: error.message, finishedAt: new Date().toISOString()}});
      throw new Error(`Worker could not start: ${error.message}; no ticket was claimed`);
    } finally { fs.closeSync(log); }
    // The worker now owns launch.json. The dispatcher must not overwrite its claim state.
    return;
  }
  let result;
  try {
    result = herdr(config, ['tab', 'create', '--workspace', config.herdrWorkspace,
      '--cwd', path.dirname(here), '--label', `lane:${run.ticket}`, '--no-focus']);
  } catch (error) {
    // No worker was dispatched, even if the tab response was lost.
    save(stateFile, {...run, result: {status: 'failed', error: error.message, finishedAt: new Date().toISOString()}});
    throw new Error(`Herdr could not open a tab: ${error.message}; no ticket was claimed`);
  }
  run.pane = result?.root_pane?.pane_id;
  if (!run.pane) {
    save(stateFile, {...run, result: {status: 'failed', finishedAt: new Date().toISOString()}});
    throw new Error('Herdr returned no pane; no ticket was claimed');
  }
  save(stateFile, run);
  herdr(config, ['pane', 'run', run.pane,
    `${quote(process.execPath)} ${quote(path.join(here, 'worker.mjs'))} ${quote(stateFile)}`]);
}
