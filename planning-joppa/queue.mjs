// Joppa planning queue reads: ready criteria and their Requirement groups.
import {api} from '../lane-launcher/joppa.mjs';
import {dependencyCheck} from '../lane-launcher/dependencies.mjs';
import {nodeAssignee, nodeWaiting, nodePages, NODE_TONES} from '../lane-launcher/joppa-nodes.mjs';

export function criterionIds(config) {
  const ids = config.ac_ids;
  if (ids === undefined) return null;
  if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !id.includes(':')) ||
      new Set(ids).size !== ids.length) throw new Error('ac_ids must contain distinct full criterion addresses');
  return ids;
}

// config.covers_reference names the Task reference that lists covered criteria. Without it the feature is off.
export function coversReference(config, schema, taskKinds) {
  const field = config.covers_reference;
  if (field === undefined || field === null) return null;
  if (typeof field !== 'string' || !field.trim() ||
      ['acceptance', 'acceptance_checks', 'test_bindings', 'projects', 'assignee', 'commit'].includes(field)) {
    throw new Error('covers_reference must name one Task reference field other than a reserved data field');
  }
  let target;
  for (const kind of taskKinds) {
    const reference = schema[kind]?.references?.[field];
    if (!reference || reference.multiple !== true || schema[reference.target]?.role !== 'ac' ||
        (target && target !== reference.target)) {
      throw new Error(`Task reference ${field} must list several criteria of one criterion type`);
    }
    target = reference.target;
  }
  return {field, target};
}

// Full criterion addresses in one Task covers value. A bare ID reads as the target type address.
export function coveredCriteria(spec, value) {
  if (!spec || value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new Error(`Task reference ${spec.field} must be a list of criterion addresses`);
  }
  return [...new Set(value.map(item => item.includes(':') ? item : `${spec.target}:${item}`))];
}

export async function readyCriteria(config, tokenFile, signal) {
  const ids = criterionIds(config);
  const rows = [];
  const blocked = new Map(), active = new Set(), completed = new Set();
  const service = {joppa: {url: config.url, mcpCommand: config.mcp_command}};
  const read = (tool, args) => api(service, {tokenFile}, tool, {workspace: config.workspace, ...args}, {signal});
  const dependencies = dependencyCheck(read);
  const schema = (await read('joppa_tree', {})).schema.types;
  const kinds = role => Object.keys(schema).filter(kind => schema[kind].role === role);
  const covers = coversReference(config, schema, kinds('task'));
  const criteria = [];
  for await (const page of nodePages(read, {kind: kinds('ac'),
    fields: ['title', 'kind', 'parent', 'revision', 'status', 'data.assignee', 'data.hold']})) {
    criteria.push(...page.items);
  }
  const requirementOf = new Map(criteria.map(row => [row.address, row.parent]));
  // A Task owns its parent and the covered criteria of the same Requirement. Archived Tasks keep raw data.
  const owners = task => [task.parent, ...coveredCriteria(covers, covers && task[`data.${covers.field}`])
    .filter(address => address !== task.parent && requirementOf.has(address) &&
      requirementOf.get(address) === requirementOf.get(task.parent))];
  for await (const page of nodePages(read, {kind: kinds('task'), status: NODE_TONES,
    fields: ['parent', 'revision', 'present', 'data.assignee', 'data.commit', 'data.hold',
      ...(covers ? [`data.${covers.field}`] : [])]})) {
    for (const task of page.items) {
      if (typeof task.parent !== 'string' || typeof task.address !== 'string' || !Number.isSafeInteger(task.revision)) {
        throw new Error('Task is missing its criterion, address or revision');
      }
      for (const owner of owners(task)) {
        if (ids && !ids.includes(owner)) continue;
        if (task.present === false) {
          if (task['data.commit']) completed.add(owner);
          continue;
        }
        if (nodeAssignee(task) || !nodeWaiting(task)) active.add(owner);
        if (!nodeWaiting(task) || nodeAssignee(task)) continue;
        const tasks = blocked.get(owner) || [];
        tasks.push(`${task.address}:${task.revision}`);
        blocked.set(owner, tasks);
      }
    }
  }
  for (const row of criteria) {
    if (ids && !ids.includes(row.address) || nodeAssignee(row) || nodeWaiting(row) ||
        active.has(row.address)) continue;
    if (typeof row.status !== 'string' || !row.status) throw new Error(`Criterion status missing for ${row.address}`);
    const failures = (blocked.get(row.address) || []).sort();
    if (completed.has(row.address) && !failures.length) continue;
    if (row.status === 'green' || row.status === 'purple' || !(await dependencies(row.address)).ready) continue;
    rows.push({...row, failedTaskCount: failures.length,
      attemptKey: JSON.stringify([row.address, row.revision, failures])});
  }
  return rows.sort((a, b) => Number(b.failedTaskCount > 0) - Number(a.failedTaskCount > 0) ||
    Number(b.status === 'red') - Number(a.status === 'red') ||
    (ids ? ids.indexOf(a.address) - ids.indexOf(b.address) : 0));
}

export async function groupRequirements(candidates, read) {
  const schema = (await read('joppa_tree', {})).schema.types;
  const objects = new Map(), groups = new Map();
  const object = async address => {
    if (!objects.has(address)) objects.set(address, read('joppa_objects', {address}));
    const result = await objects.get(address);
    if (result.address !== address || result.document?.present !== true || result.historical !== false ||
        !Number.isSafeInteger(result.current_revision)) throw new Error('Requirement selection needs current full object reads');
    return result;
  };
  for (const candidate of candidates) {
    let current = await object(candidate.address);
    const seen = new Set();
    while (schema[current.kind]?.role !== 'requirement') {
      if (seen.has(current.address)) throw new Error('Requirement parent chain contains a cycle');
      seen.add(current.address);
      if (!current.document.parent) throw new Error('Criterion has no schema Requirement ancestor');
      current = await object(current.document.parent);
    }
    const group = groups.get(current.address) || {address: current.address, revision: current.current_revision,
      title: current.document.data.title || current.address, members: []};
    group.members.push(candidate.attemptKey);
    groups.set(current.address, group);
  }
  return [...groups.values()].map(({members, ...item}) => ({...item,
    attemptKey: JSON.stringify([item.address, item.revision, members.sort()])}));
}

export async function readyRequirements(config, tokenFile, signal) {
  const candidates = await readyCriteria(config, tokenFile, signal);
  if (!candidates.length) return [];
  return groupRequirements(candidates, (tool, args) => api({joppa: {url: config.url, mcpCommand: config.mcp_command}}, {tokenFile}, tool,
    {workspace: config.workspace, ...args}, {signal}));
}
