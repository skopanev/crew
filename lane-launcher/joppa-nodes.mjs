// Generic Joppa node reads and revision-checked document saves.
const require = (condition, message) => { if (!condition) throw new Error(message); };
// Joppa renamed grey to blue. grey stays a read alias.
export const NODE_TONES = ['red', 'yellow', 'orange', 'blue', 'grey', 'green', 'purple'];

export const nodeAssignee = node => node.document?.data?.assignee ?? node.data?.assignee ?? node['data.assignee'] ?? null;
export const nodeStage = node => node.computed?.stage ?? node.stage ?? node.document?.data?.stage ?? node.data?.stage ?? node['data.stage'] ?? null;
export function excludedNodeTag(node, tags = []) {
  require(Array.isArray(tags) && tags.every(tag => typeof tag === 'string' && tag.trim() === tag && tag.length > 0),
    'joppa.excludeTags must contain nonempty tag names');
  if (!tags.length) return undefined;
  const current = node.document?.data?.tags ?? node.data?.tags ?? node['data.tags'] ?? [];
  require(Array.isArray(current), 'Node tags must be an array');
  return tags.find(tag => current.includes(tag));
}
export const nodeFailed = (node, stage) => typeof stage === 'string' && stage.length > 0 && nodeStage(node) === stage;
export function validateFailedTaskStage(config, types) {
  const stage = config.FAILED_TASK_STAGE;
  require(typeof stage === 'string' && stage.trim() === stage && stage.length > 0 && stage !== 'done',
    'FAILED_TASK_STAGE must name a nonterminal Task stage');
  const tasks = Object.values(types || {}).filter(type => type.role === 'task');
  require(tasks.length > 0 && tasks.every(type => (type.fields?.stage?.from ?? 'own') === 'own' &&
    type.fields?.stage?.values?.includes(stage)), 'FAILED_TASK_STAGE is absent from the native Task stage values');
}
export const nodeStageDone = node => nodeStage(node) === 'done';
export function doneTaskStage(config, schema, object) {
  const stage = config.DONE_TASK_STAGE ?? 'done';
  const type = schema.types?.[object.kind], field = type?.fields?.stage;
  require(typeof stage === 'string' && stage.trim() === stage && stage.length > 0 &&
    type?.role === 'task' && (field?.from ?? 'own') === 'own' && field?.values?.includes(stage),
  'DONE_TASK_STAGE must name an editable stage in the native Task type');
  require(stage !== config.FAILED_TASK_STAGE, 'DONE_TASK_STAGE must differ from FAILED_TASK_STAGE');
  return stage;
}
export const nodePendingDelivery = node =>
  (node.document?.data?.delivery ?? node.data?.delivery ?? node['data.delivery'])?.state === 'pending';

// A partial save: Joppa merges data, keeps the parent and keeps every relation that is not sent.
// An undefined change removes the field.
export function saveNode(node, changes, reason) {
  require(node.historical === false && node.document?.present === true &&
    Number.isSafeInteger(node.current_revision) && node.current_revision > 0,
  'A node save requires a current, present document');
  const separator = node.address?.indexOf(':');
  require(separator > 0, 'A node save requires its full address');
  const data = Object.fromEntries(Object.entries(changes).map(([key, value]) => [key, value === undefined ? null : value]));
  return {op: 'save_object', kind: node.address.slice(0, separator), id: node.address.slice(separator + 1),
    revision: node.current_revision, data, reason};
}

export async function roleKinds(read, role) {
  const types = (await read('joppa_tree', {}))?.schema?.types;
  require(types && typeof types === 'object', 'Joppa tree schema is missing');
  const kinds = Object.keys(types).filter(kind => types[kind].role === role);
  require(kinds.length > 0, `Joppa tree has no ${role} type`);
  return kinds;
}

export async function* nodePages(read, filters) {
  let cursor;
  const seen = new Set();
  do {
    const page = await read('joppa_objects', {parent: '*', ...filters, limit: 25, ...(cursor ? {cursor} : {})});
    require(Array.isArray(page?.items), 'Joppa node page is incomplete');
    yield page;
    cursor = page.next_cursor;
    if (cursor) {
      require(typeof cursor === 'string' && !seen.has(cursor), 'Joppa node pagination did not advance');
      seen.add(cursor);
    }
  } while (cursor);
}

// extraFields adds raw data paths, such as the configured covers reference or data.test_bindings.
export async function* taskPages(read, filters = {}, extraFields = []) {
  yield* nodePages(read, {kind: await roleKinds(read, 'task'),
    fields: ['title', 'revision', 'parent', 'present', 'data.assignee', 'data.commit', 'data.priority',
      'data.stage', 'data.delivery', ...extraFields],
    ...filters});
}

export const coversFields = config => config?.joppa?.coversReference ? [`data.${config.joppa.coversReference}`] : [];
