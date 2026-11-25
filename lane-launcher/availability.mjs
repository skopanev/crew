// Display native candidates without running Task admission or repository checks.
import path from 'node:path';
import {api} from './joppa-common.mjs';
import {readRun, runDirectories} from './runtime.mjs';
import {availableCounts, availabilityLabel} from './native-availability.mjs';

export async function dolberAvailability(config, signal, read = (tool, args) =>
  api(config, config.joppa.workers[0], tool, {workspace: config.workspace, ...args}, {signal})) {
  const started = performance.now();
  try {
    const types = (await read('joppa_tree', {}))?.schema?.types;
    const kinds = Object.keys(types || {}).filter(kind => types[kind].role === 'task');
    if (!kinds.length || config.joppa.priorities?.length) return {text: '?', ms: performance.now() - started};
    const active = runDirectories(config.stateDir).map(dir => readRun(path.join(dir, 'launch.json'))).filter(run => !run.result);
    const known = active.every(run => run.claim && !run.releaseConfirmed && !run.completionRequest && !run.blockRequest);
    const result = await availableCounts({workspace: config.workspace,
      selection: {kind: kinds, ...config.joppa.filter}, exclude_tags: config.joppa.excludeTags}, null, signal,
      known, args => read('joppa_objects', args));
    return {...result, ms: performance.now() - started};
  } catch { return {text: '?', ms: performance.now() - started}; }
}

export async function refreshAvailability(config, display, signal) {
  const result = await dolberAvailability(config, signal);
  if (display) display.available = result.text;
  return availabilityLabel({available: result.text});
}
