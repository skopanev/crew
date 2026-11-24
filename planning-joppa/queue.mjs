// Joppa planning queue reads: ready criteria and their Requirement groups.
import {api} from '../lane-launcher/joppa.mjs';
import {dependencyCheck} from '../lane-launcher/dependencies.mjs';
import {nodeAssignee, nodeFailed, validateFailedTaskStage, nodePendingDelivery, nodePages, NODE_TONES} from '../lane-launcher/joppa-nodes.mjs';
import {validateNodeFilter} from '../lane-launcher/task-filter.mjs';
import {batchSettings, batchField, batchReady, batchProjection, batchItems} from './flow-batch.mjs';
import {retryPolicy} from './retry.mjs';
import {dependencySelection} from './dependency-selection.mjs';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const kindList = value => value === undefined || [value].flat().every(item => typeof item === 'string' && item.trim());

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
  validateFailedTaskStage(config, schema);
  const kinds = role => Object.keys(schema).filter(kind => schema[kind].role === role);
  const covers = coversReference(config, schema, kinds('task'));
  const criteria = [];
  for await (const page of nodePages(read, {kind: kinds('ac'),
    fields: ['title', 'kind', 'parent', 'revision', 'status', 'data.assignee']})) {
    criteria.push(...page.items);
  }
  const requirementOf = new Map(criteria.map(row => [row.address, row.parent]));
  // A Task owns its parent and the covered criteria of the same Requirement. Archived Tasks keep raw data.
  const owners = task => [task.parent, ...coveredCriteria(covers, covers && task[`data.${covers.field}`])
    .filter(address => address !== task.parent && requirementOf.has(address) &&
      requirementOf.get(address) === requirementOf.get(task.parent))];
  for await (const page of nodePages(read, {kind: kinds('task'), status: NODE_TONES,
    fields: ['parent', 'revision', 'present', 'data.assignee', 'data.commit', 'data.stage', 'data.delivery',
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
        if (nodeAssignee(task) || nodePendingDelivery(task) || !nodeFailed(task, config.FAILED_TASK_STAGE)) active.add(owner);
        if (!nodeFailed(task, config.FAILED_TASK_STAGE) || nodeAssignee(task)) continue;
        const tasks = blocked.get(owner) || [];
        tasks.push(`${task.address}:${task.revision}`);
        blocked.set(owner, tasks);
      }
    }
  }
  for (const row of criteria) {
    if (ids && !ids.includes(row.address) || nodeAssignee(row) ||
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

// A configured flow uses native Joppa filters. Only unassigned items can enter a new claim.
export function flowSettings(config) {
  if (config.workflow === undefined) return null;
  if (config.wait_for_dependencies !== undefined && typeof config.wait_for_dependencies !== 'boolean')
    throw new Error('wait_for_dependencies must be boolean');
  if (typeof config.workflow !== 'string' || !config.workflow.trim()) throw new Error('workflow must name a Medulla workflow.yaml file');
  if (config.ac_ids !== undefined || config.covers_reference !== undefined) {
    throw new Error('ac_ids and covers_reference apply only to the planner flow without workflow');
  }
  if (config.inputs !== undefined) {
    const keys = new Set(['selection', 'order', 'exclude_tags', 'exclude_children', 'children', 'references', 'related', 'publication', 'wait_for_dependencies']);
    if (!Array.isArray(config.inputs) || !config.inputs.length || config.inputs.some(input => !object(input) ||
        !object(input.selection) || Object.keys(input).some(key => !keys.has(key)))) throw new Error('inputs needs ordered native selection profiles');
    for (const input of config.inputs) flowSettings({...config, ...input, inputs: undefined});
    return {inputs: config.inputs};
  }
  const {kind, ...selection} = object(config.selection) ? config.selection : {};
  if (!object(config.selection) || kind === undefined || !kindList(kind) || ![kind].flat().length) {
    throw new Error('selection needs a native kind and optional native filters');
  }
  validateNodeFilter(selection, 'selection');
  if (config.exclude_tags !== undefined && (!Array.isArray(config.exclude_tags) ||
      config.exclude_tags.some(tag => typeof tag !== 'string' || !tag.trim()))) {
    throw new Error('exclude_tags must be a list of nonempty tags');
  }
  const exclude = config.exclude_children;
  for (const childFilter of exclude == null ? [] : [exclude].flat()) {
    const {kind: childKind, ...filters} = object(childFilter) ? childFilter : {};
    if (!object(childFilter) || !kindList(childKind) || 'parent' in filters || 'depth' in filters) {
      throw new Error('exclude_children needs native child filters without parent or depth');
    }
    validateNodeFilter(filters, 'exclude_children');
  }
  const order = config.order ?? [];
  if (!Array.isArray(order) || order.some(item => !object(item) ||
      Object.keys(item).some(key => !['direction', 'field', 'values'].includes(key)) ||
      typeof item.field !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(item.field) ||
      !['asc', 'desc'].includes(item.direction) || item.values !== undefined &&
      (!Array.isArray(item.values) || !item.values.length || new Set(item.values).size !== item.values.length ||
        item.values.some(value => typeof value !== 'string' || !value.trim())))) {
    throw new Error('order needs field, direction asc or desc, and optional distinct nonempty text values');
  }
  batchSettings(config.batch);
  retryPolicy(config);
  return {selection: config.selection, exclude: exclude ?? null, order};
}

const compare = order => (a, b) => {
  for (const {field, direction, values} of order) {
    let left = batchField(a, field) ?? null, right = batchField(b, field) ?? null;
    if (left === right) continue;
    if (left === null || right === null) return left === null ? 1 : -1;
    if (values) {
      const rank = value => { const index = values.indexOf(value); return index < 0 ? values.length : index; };
      left = rank(left); right = rank(right);
    }
    const result = typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right));
    if (result) return direction === 'desc' ? -result : result;
  }
  return a.address.localeCompare(b.address);
};

// One pass takes the first ordered item that skip() allows and that has no excluded direct child.
export async function nextConfiguredItem(config, tokenFile, signal, skip = () => false) {
  const flow = flowSettings(config);
  if (flow.inputs) {
    let count = 0, filtered = 0;
    for (const [input, profile] of flow.inputs.entries()) {
      const result = await nextConfiguredItem({...config, ...profile, inputs: undefined}, tokenFile, signal, skip);
      count += result.count; filtered += result.filtered;
      if (result.next) return {count, filtered, next: {...result.next, input}};
    }
    return {count, filtered, next: null};
  }
  const service = {joppa: {url: config.url, mcpCommand: config.mcp_command}};
  const read = (tool, args) => api(service, {tokenFile}, tool, {workspace: config.workspace, ...args}, {signal});
  const batch = config.batch;
  const fields = [...new Set(['title', 'kind', 'parent', 'revision', ...(config.exclude_tags?.length ? ['data.tags'] : []), ...flow.order.map(item => item.field),
    ...[batch?.by, batch?.age_field, batch?.unit_field].filter(Boolean).map(batchProjection)])];
  const rows = [], seen = new Set();
  for await (const page of nodePages(read, {...flow.selection, assignee: '', fields})) {
    for (const row of page.items) {
      if (typeof row.address !== 'string' || !row.address.includes(':') || !Number.isSafeInteger(row.revision) || row.revision < 1) {
        throw new Error('Configured selection returned an item without a full address or revision');
      }
      if (seen.has(row.address)) continue;
      seen.add(row.address);
      rows.push({...row, title: row.title || row.address, attemptKey: JSON.stringify([row.address, row.revision])});
    }
  }
  rows.sort(compare(flow.order));
  const eligible = [], parents = new Map();
  const dependencies = config.wait_for_dependencies ? dependencySelection(read) : null;
  let filtered = 0;
  for (const row of rows) {
    if (await skip(row, config, read)) continue;
    const guard = config.related?.parent;
    if (guard) {
      if (!row.parent) {filtered++; continue;}
      if (!parents.has(row.parent)) parents.set(row.parent, read('joppa_objects', {address: row.parent}));
      const parent = await parents.get(row.parent), data = parent.document?.data;
      if (parent.document?.present !== true || parent.historical !== false || ![guard.kind].flat().includes(parent.kind) ||
          data?.assignee || guard.exclude_tags?.some(tag => (data?.tags || []).includes(tag))) {filtered++; continue;}
    }
    if (config.exclude_tags?.some(tag => (batchField(row, 'data.tags') || []).includes(tag))) { filtered++; continue; }
    if (dependencies && !await dependencies(row.address)) { filtered++; continue; }
    let excluded = false;
    for (const childFilter of flow.exclude == null ? [] : [flow.exclude].flat()) {
      for await (const page of nodePages(read, {...childFilter, parent: row.address, depth: 1, fields: ['parent']})) {
        if ((excluded = page.items.some(item => item.parent === row.address))) break;
      }
      if (excluded) break;
    }
    if (!excluded) {
      if (!batch || (batch.min_size ?? 1) === 1) return {count: rows.length, next: row, filtered};
      eligible.push(row);
    } else filtered++;
  }
  for (const row of eligible) {
    const group = batch.by ? eligible.filter(item => batchField(item, batch.by) === batchField(row, batch.by)) : eligible;
    const items = batchItems(batch, [row, ...group.filter(item => item !== row)]);
    if (batchReady(batch, items)) return {count: rows.length, next: items[0], filtered};
  }
  return {count: rows.length, next: null, filtered};
}
