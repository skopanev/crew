import path from 'node:path';
import {callJoppa} from '../lane-launcher/joppa-api.mjs';
import {findingKey, hash, read, require, text, write} from '../audit/common.mjs';

const api = (config, tool, args) => callJoppa(config.url, config.token_file, tool, {workspace: config.workspace, ...args});
async function inventory(config, kind) {
  const items = [];
  let cursor;
  do {
    const page = await api(config, 'joppa_objects', {parent: '*', limit: 100, ...(kind ? {kind} : {}), ...(cursor ? {cursor} : {})});
    items.push(...page.items);
    require(!page.next_cursor || page.next_cursor !== cursor, 'Joppa pagination did not advance');
    cursor = page.next_cursor;
  } while (cursor);
  return items;
}
const document = object => ({address: object.address, revision: object.current_revision,
  kind: object.kind, text: JSON.stringify({data: object.document.data, annotations: object.annotations || {}}, null, 2)
    + '\n' + Object.values(object.document.data).filter(value => typeof value === 'string').join('\n'),
  document: object.document, annotations: object.annotations || {}, files: object.files || [], references: object.references || []});
export async function prepare(config) {
  const tree = await api(config, 'joppa_tree', {});
  const schema = tree.schema.types;
  const inbox = schema[config.inbox.kind];
  require(inbox?.inbox === true && (config.inbox.parent || inbox.root === true), 'Configured type is not an inbox at this parent');
  const rows = (await inventory(config)).filter(item => item.present !== false);
  const selected = new Set(config.roots || []);
  if (selected.size) {
    require([...selected].every(address => rows.some(item => item.address === address)), 'An audit root is absent');
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) if (selected.has(row.parent) && !selected.has(row.address)) {
        selected.add(row.address); changed = true;
      }
    }
    for (const row of rows.filter(item => selected.has(item.address))) {
      let parent = row.parent;
      while (parent && !selected.has(parent)) {
        selected.add(parent); parent = rows.find(item => item.address === parent)?.parent;
      }
    }
  }
  const candidates = rows.filter(item => (!selected.size || selected.has(item.address))
    && schema[item.kind]?.role !== 'task' && schema[item.kind]?.inbox !== true);
  require(candidates.length, 'Audit specification is empty');
  const specification = [];
  // Limit simultaneous API reads without starting more model sessions.
  for (let offset = 0; offset < candidates.length; offset += 4) {
    const objects = await Promise.all(candidates.slice(offset, offset + 4).map(item => api(config, 'joppa_objects', {address: item.address})));
    for (const object of objects) {
      require(object.document?.present === true && object.historical === false, 'Current specification object required');
      specification.push(document(object));
    }
  }
  require(hash((await api(config, 'joppa_tree', {})).schema) === hash(tree.schema), 'Schema changed while preparing audit');
  return {workspace: config.workspace, project: config.project, specification, schema: tree.schema,
    scope: config.roots || [], inbox: config.inbox};
}
export async function recheck(config, input, findings = []) {
  const tree = await api(config, 'joppa_tree', {});
  require(hash(tree.schema) === hash(input.schema), 'Joppa schema changed during audit');
  const rows = await inventory(config);
  const revisions = new Map(rows.filter(item => item.present !== false).map(item => [item.address, item.revision]));
  require(input.specification.every(item => revisions.get(item.address) === item.revision), 'Specification changed during audit; rerun it');
  const documents = new Map(input.specification.map(item => [item.address, item]));
  const cited = new Set(findings.flatMap(finding => finding.spec.map(item => item.address)));
  for (const address of cited) {
    const parent = documents.get(address)?.document.parent;
    if (parent) cited.add(parent);
  }
  for (const address of cited) {
    const previous = documents.get(address);
    require(previous && hash(document(await api(config, 'joppa_objects', {address}))) === hash(previous),
      'Cited specification or owner context changed during audit; rerun it');
  }
}
export async function publish(config, findings, input, artifacts) {
  if (!findings.length) return {published: [], reused: []};
  const existing = new Map((await inventory(config, config.inbox.kind)).map(item => [item.address, item]));
  const operations = [], published = [], reused = [];
  const keys = new Set();
  for (const finding of findings) {
    const key = findingKey(finding), id = `audit-${key.slice(0, 32)}`;
    if (keys.has(key)) continue;
    keys.add(key);
    const address = `${config.inbox.kind}:${id}`;
    if (existing.has(address)) {
      const current = await api(config, 'joppa_objects', {address});
      require(current.document?.data.audit_key === key, 'Audit inbox ID collision');
      reused.push(address); continue;
    }
    const body = [`Actual: ${finding.actual}`, `Required: ${finding.required}`, `Impact: ${finding.impact}`,
      ...finding.code.map(item => `Code: ${item.repository}:${item.path}:${item.line}\n${item.quote}`),
      ...finding.spec.map(item => `Spec: ${item.address} revision ${item.revision}\n${item.quote}`),
      `Source commits: ${input.repositories.map(repo => `${repo.id}=${repo.head}`).join(', ')}`].join('\n\n');
    operations.push({command: {op: 'save_object', kind: config.inbox.kind, id, revision: 0,
      parent: config.inbox.parent || null,
      data: {...config.inbox.fields, title: finding.title, owner: config.inbox.owner,
        [config.inbox.body_field || 'body']: body, status: 'unprocessed', audit_key: key},
      links: finding.spec.map(item => ({target: item.address, revision: item.revision, relation: 'related', blocking: false})),
      reason: 'Record an independently verified code and specification discrepancy.',
      ...(input.schema.types[config.inbox.kind].question ? {question_checked: input.schema.types[config.inbox.kind].question} : {})}});
    published.push(address);
  }
  if (!operations.length) return {published, reused};
  const file = path.join(artifacts, 'publication.json');
  const request = {workspace: config.workspace, request_id: `crew-audit-${hash(operations)}`, operations};
  let saved;
  try { saved = read(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  require(!saved || saved.status === 'confirmed', 'Earlier inbox publication is uncertain; inspect it before retry');
  if (saved) return saved.result;
  write(file, {status: 'pending', request});
  try {
    const response = await api(config, 'joppa_batch', request);
    require(Array.isArray(response.results) && response.results.length === operations.length, 'Inbox publication response is incomplete');
    const result = {published, reused};
    write(file, {status: 'confirmed', request, result});
    return result;
  } catch (error) {
    write(file, {status: 'uncertain', request, error: error.message});
    throw error;
  }
}
