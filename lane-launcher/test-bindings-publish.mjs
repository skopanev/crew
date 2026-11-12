// Final landing evidence for lane test bindings: the bound names, their criterion nodes and their recorded results.
import {NODE_TONES, taskPages} from './joppa-nodes.mjs';
import {taskRepository} from './requirement-state.mjs';
import {testType, criterionNodes, nodeResult} from './test-nodes.mjs';
const fail = (code, message) => { throw Object.assign(new Error(`${code}: ${message}`), {code}); };

// Read the done Tasks of this Requirement and repository and their data.test_bindings.
// Each name must be in the full gate report and have a node under its exact criterion. Return [{ac, test, node}].
export async function boundNodes({run, call, report}) {
  if (!run.requirement) return [];
  const read = (tool, args) => call(tool, {workspace: run.workspace, ...args});
  const schema = (await read('joppa_tree', {}))?.schema || {};
  if (!Object.values(schema.types || {}).some(type => type.role === 'task')) return [];
  const pairs = new Map();
  for await (const page of taskPages(read, {parent: run.requirement, status: NODE_TONES}, ['data.test_bindings'])) {
    for (const item of page.items) {
      if (item.present !== false || !item['data.commit'] || !Array.isArray(item['data.test_bindings'])) continue;
      const task = await read('joppa_objects', {address: item.address});
      if (taskRepository(task, schema.types, run.repository.id) !== run.repository.id) continue;
      for (const row of task.document.data.test_bindings || []) pairs.set(JSON.stringify([row.ac, row.test]), row);
    }
  }
  if (!pairs.size) return [];
  const names = new Set(report.results.map(item => item.test)), kind = testType(schema.types), bound = [];
  const nodes = new Map();
  for (const {ac, test} of pairs.values()) {
    if (!names.has(test)) fail('BINDING_NOT_IN_REPORT', `${test} is not in the full gate report`);
    if (!nodes.has(ac)) nodes.set(ac, await criterionNodes(read, kind, ac));
    const node = nodes.get(ac).get(test);
    if (!node) fail('BINDING_NODE_MISSING', `${ac} has no test node ${test}`);
    await nodeResult(read, node, ac, test);
    bound.push({ac, test, node});
  }
  return bound;
}

// After a recorded send: each bound name must be bound by Joppa and carry a result at this commit. Return gaps.
export async function boundGaps({run, call, bound, sha}) {
  const read = (tool, args) => call(tool, {workspace: run.workspace, ...args});
  // Joppa returns unbound as a list of test names.
  const unbound = new Set(run.testResults.requests.flatMap(entry =>
    Array.isArray(entry.reply?.unbound) ? entry.reply.unbound.filter(item => typeof item === 'string') : []));
  const gaps = [];
  for (const {ac, test, node} of bound) {
    if (unbound.has(test)) gaps.push(`TEST_RESULTS_UNBOUND: Joppa did not bind ${test} for ${ac}`);
    const result = await nodeResult(read, node, ac, test);
    if (!result || result.commit !== sha) gaps.push(`TEST_RESULTS_MISSING: ${node} (${test}) has no result at ${sha}`);
  }
  return gaps;
}
