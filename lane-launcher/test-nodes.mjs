// Criterion test nodes for lane bindings. A node binds one test name to one criterion; the title is the name.
// The shapes follow planning-joppa/test_nodes.py bind_missing and node_results.
import {nodePages} from './joppa-nodes.mjs';
import {nameProblem} from './test-results.mjs';
const fail = (code, message) => { throw Object.assign(new Error(`${code}: ${message}`), {code}); };

export function testType(types) {
  const kinds = Object.keys(types || {}).filter(kind => types[kind].role === 'test');
  if (kinds.length !== 1) fail('BINDING_INVALID', 'the workspace schema needs exactly one test type');
  return kinds[0];
}

// Read every test node directly below one criterion. A same-named node under another criterion does not count.
export async function criterionNodes(read, kind, ac) {
  const nodes = new Map();
  for await (const page of nodePages(read, {kind, parent: ac, fields: ['title', 'parent']})) {
    for (const item of page.items) {
      if (item.parent === ac && typeof item.title === 'string') nodes.set(item.title, item.address);
    }
  }
  return nodes;
}

// Read one bound node in full. Return its recorded result or null.
export async function nodeResult(read, address, ac, title) {
  const detail = await read('joppa_objects', {address});
  const parent = detail?.document?.parent ?? detail?.parent, name = detail?.document?.data?.title ?? detail?.data?.title;
  if (parent !== ac || name !== title) fail('BINDING_NODE_MISSING', `${address} is not the ${title} node of ${ac}`);
  const result = detail.result;
  return result && typeof result === 'object' && result.status ? result : null;
}

// Return save_object commands for each (AC, test) without a node. Never touch an existing node.
export async function missingTestNodes(read, schema, rows) {
  const kind = testType(schema.types), definition = schema.types[kind], rules = schema.test_results || {};
  const commands = [], byCriterion = new Map();
  for (const row of rows) byCriterion.set(row.ac, [...new Set([...(byCriterion.get(row.ac) || []), row.test])]);
  for (const [ac, names] of byCriterion) {
    const existing = await criterionNodes(read, kind, ac);
    const missing = names.filter(name => !existing.has(name));
    if (Number.isSafeInteger(rules.max_tests) && existing.size + missing.length > rules.max_tests) {
      fail('BINDING_INVALID', `${ac} supports at most ${rules.max_tests} tests`);
    }
    if (!missing.length) continue;
    const criterion = await read('joppa_objects', {address: ac});
    const owner = criterion?.document?.data?.owner;
    if (!owner && Object.hasOwn(definition.required_fields || {}, 'owner')) {
      fail('BINDING_INVALID', `${ac} needs an owner for new test nodes`);
    }
    const limit = Math.min(rules.name?.max_length ?? 400, definition.title_max_length ?? 128);
    for (const name of missing) {
      const problem = rules.name ? nameProblem(name, rules.name) : null;
      if (problem || Array.from(name).length > limit || /[\x00-\x1f\x7f-\x9f]/.test(name)) {
        fail('BINDING_INVALID', `test name ${JSON.stringify(name)} does not fit the test node rules${problem ? `: ${problem}` : ''}`);
      }
      commands.push({op: 'save_object', kind, revision: 0, parent: ac, data: {title: name, ...(owner ? {owner} : {})},
        reason: 'Bind a test that the lane verified for this criterion check.',
        ...(definition.question ? {question_checked: definition.question} : {})});
    }
  }
  return commands;
}
