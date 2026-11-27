import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {passingTests} from '../tasker/completion.mjs';
import {doneTaskStage, nodeAssignee, nodePages, saveNode} from '../lane-launcher/joppa-nodes.mjs';
import {api, batchRequest, mutateTasks, contractDigest} from '../lane-launcher/joppa-common.mjs';
import {readDetails} from '../lane-launcher/joppa-api.mjs';

const need = (ok, message) => { if (!ok) throw new Error(message); };
const data = node => node?.document?.data ?? {};
const present = node => node.historical === false && node.document?.present === true;
const tone = node => node.status?.tone ?? node.status;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = value => typeof value === 'string' && Boolean(value.trim());
const parents = (node, relation) => relation === 'parent' ? [node.document?.parent].filter(Boolean)
  : (node.relations?.[relation]?.edges ?? []).map(edge => edge.to);

export function completionPolicy(config, schema) {
  const policy = config.ac_completion;
  if (policy == null) return null;
  need(config.publication?.allowed_operations?.includes('save_object') &&
    config.publication?.update_kinds?.includes(policy.kind), 'AC completion requires its configured publication permission');
  need(text(policy.kind) && schema.types?.[policy.kind]?.role === 'ac' && text(policy.relation) &&
    (policy.relation === 'parent' || schema.relations?.[policy.relation]), 'Configure the AC kind and its Task relation');
  for (const [field, role] of [['task_kinds', 'task'], ['test_kinds', 'test']]) {
    need(Array.isArray(policy[field]) && policy[field].length && policy[field].every(kind => schema.types?.[kind]?.role === role),
      `Configure ac_completion.${field} from the native schema`);
    need(Object.entries(schema.types).filter(([, type]) => type.role === role &&
      (policy.relation !== 'parent' || type.parents?.includes(policy.kind)))
      .every(([kind]) => policy[field].includes(kind)), `ac_completion.${field} omits a native child type`);
  }
  const stage = schema.types[policy.kind].fields?.stage;
  need(text(policy.done_stage) && (stage?.from ?? 'own') === 'own' && stage?.values?.includes(policy.done_stage),
    'Configure an editable AC completion stage');
  need(text(config.DONE_TASK_STAGE), 'AC completion requires explicit DONE_TASK_STAGE');
  for (const kind of policy.task_kinds) doneTaskStage(config, schema, {kind});
  return policy;
}

async function inspect(config, policy, address, landed, read, many) {
  const ac = await read('joppa_objects', {address});
  if (!present(ac) || ac.kind !== policy.kind || nodeAssignee(ac)) return {ac, ready: false, reason: 'AC unavailable or assigned'};
  const query = policy.relation === 'parent' ? {parent: address, depth: 1}
    : {relations_of: address, direction: 'incoming', relation: policy.relation};
  const rows = [];
  for await (const page of nodePages(read, {...query, kind: [...policy.task_kinds, ...policy.test_kinds],
    fields: ['revision', 'parent']})) rows.push(...page.items);
  const listed = await many(rows.map(row => row.address));
  need(listed.length === rows.length && listed.every(node =>
    rows.some(row => row.address === node.address && row.revision === node.current_revision) &&
    parents(node, policy.relation).includes(address)), 'AC children changed while reading');
  const children = listed.filter(present);
  const tasks = children.filter(node => policy.task_kinds.includes(node.kind));
  const current = await many(landed.map(node => node.address));
  const taskDone = node => policy.task_kinds.includes(node.kind) && !nodeAssignee(node) &&
    data(node).stage === doneTaskStage(config, {types: config._completionTypes}, node);
  const ready = tone(ac) === 'green' && tasks.every(taskDone) && current.length === landed.length &&
    current.every(node => taskDone(node) && parents(node, policy.relation).includes(address) &&
      landed.some(original => original.address === node.address && data(original).commit === data(node).commit &&
        contractDigest(original) === contractDigest(node))) &&
    passingTests({schema: {types: config._completionTypes}}, children);
  return {ac, children, ready, reason: ready ? 'Current Tasks and Tests satisfy completion' : 'A Task or Test is not complete'};
}

export async function completeACs(config, input, state, result, {read, many, write, persist = () => {}}) {
  if (!config.ac_completion || !/^[a-f0-9]{40}$/.test(state.landed || '') ||
      !/^[a-f0-9]{40}$/.test(state.checked?.commit || '') ||
      result.claim_released !== true || result.needs_recovery) return [];
  const schema = (await read('joppa_tree', {})).schema, policy = completionPolicy(config, schema);
  config = {...config, _completionTypes: schema.types};
  const accepted = new Set(state.accepted.map(item => item.address));
  const items = (input.items ?? [input.selected]).filter(item => accepted.has(item.address));
  const current = await many(items.map(item => item.address)), groups = new Map();
  for (const item of current) {
    const original = items.find(node => node.address === item.address);
    if (data(item).stage !== doneTaskStage(config, schema, item) || nodeAssignee(item) ||
      data(item).commit !== data(original).commit || contractDigest(item) !== contractDigest(original) ||
      hash(parents(item, policy.relation)) !== hash(parents(original, policy.relation))) continue;
    for (const address of parents(item, policy.relation)) {
      if (!address.startsWith(policy.kind + ':')) continue;
      if (!groups.has(address)) groups.set(address, []);
      groups.get(address).push(item);
    }
  }
  const priorOutcomes = new Map((state.ac_completion ?? []).flatMap(attempt => attempt.outcomes ?? [])
    .filter(item => item.address).map(item => [item.address, item]));
  for (const [address, previous] of priorOutcomes) if (previous.request &&
    ['unresolved', 'deferred'].includes(previous.status)) groups.set(address, previous.landed ?? groups.get(address) ?? []);
  const outcomes = [];
  for (const [address, landed] of groups) {
    const latest = priorOutcomes.get(address);
    const prior = latest?.request && ['unresolved', 'deferred'].includes(latest.status) ? latest : null;
    const outcome = prior ? structuredClone(prior) : {address, status: 'deferred'};
    let revision = outcome.revision;
    const reopen = async ac => {
      need(ac.current_revision === revision && data(ac).stage === policy.done_stage,
        'AC changed after completion; preserve the current owner update');
      const rollback = batchRequest({workspace: config.workspace}, [saveNode(ac,
        {stage: outcome.previous_stage}, 'AC completion inputs changed. Restore the previous stage.')]);
      outcome.rollback = rollback; persist(outcomes);
      await write(rollback);
      outcome.status = 'reopened';
      outcome.needs_recovery = false;
    };
    outcomes.push(outcome);
    try {
      if (outcome.rollback) {
        await write(outcome.rollback);
        Object.assign(outcome, {status: 'reopened', needs_recovery: false}); continue;
      }
      const before = outcome.request ? null : await inspect(config, policy, address, landed, read, many);
      if (before && (!before.ready || data(before.ac).stage === policy.done_stage)) {
        Object.assign(outcome, {status: before.ready ? 'already_done' : 'waiting', reason: before.reason}); continue;
      }
      const reason = 'Lander confirmed landing. Every current Task is done and every current Test passes.';
      const guards = before?.children.map(node => ({op: 'save_object', kind: node.kind,
        id: node.address.slice(node.address.indexOf(':') + 1), revision: node.current_revision, reason}));
      if (!outcome.request) outcome.request = batchRequest({workspace: config.workspace},
        [...guards, saveNode(before.ac, {stage: policy.done_stage}, reason)]);
      Object.assign(outcome, {landed, previous_stage: outcome.previous_stage ?? data(before?.ac).stage,
        status: 'unresolved', needs_recovery: true}); persist(outcomes);
      const reply = await write(outcome.request);
      revision = reply.results.at(-1).object.revision;
      outcome.revision = revision; persist(outcomes);
      const after = await inspect(config, policy, address, landed, read, many);
      if (after.ac.current_revision !== revision || data(after.ac).stage !== policy.done_stage) {
        Object.assign(outcome, {status: 'owner_changed', needs_recovery: false,
          reason: 'AC changed after completion; preserve the current owner update'}); continue;
      }
      if (after.ready) { Object.assign(outcome, {status: 'done', needs_recovery: false}); continue; }
      await reopen(after.ac);
      outcome.reason = after.reason;
    } catch (error) {
      outcome.reason = error.message;
      if (revision && outcome.status !== 'reopened' && !outcome.rollback) {
        try { await reopen(await read('joppa_objects', {address})); }
        catch (rollbackError) { outcome.reason += '; ' + rollbackError.message; }
      }
    }
    finally { persist(outcomes); }
  }
  return outcomes;
}

async function main() {
  let code = process.env.MEDULLA_LAST_SIGNAL;
  need(['READY', 'BLOCKED'].includes(code), 'AC completion requires the original publication signal');
  let persist = () => {};
  try {
  const root = path.join(process.env.MEDULLA_RUN_DIR, 'artifacts');
  const load = name => JSON.parse(fs.readFileSync(path.join(root, name + '.json'), 'utf8'));
  const config = JSON.parse(fs.readFileSync(process.env.PLANNING_JOPPA_CONFIG, 'utf8'));
  const result = load('result'), state = load('lander');
  const service = {joppa: {url: config.url, mcpCommand: config.mcp_command}}, worker = {tokenFile: config.token_file};
  const read = (tool, args) => api(service, worker, tool, {workspace: config.workspace, ...args});
  const many = async addresses => {
    const rows = [];
    for (let offset = 0; offset < addresses.length; offset += 25) {
      const part = addresses.slice(offset, offset + 25);
      const batch = await readDetails(config.url, config.token_file, {workspace: config.workspace}, part, {mcpCommand: config.mcp_command});
      for (const address of part) rows.push(batch.get(address) ?? await read('joppa_objects', {address}));
    }
    return rows;
  };
  let attempt;
  persist = outcomes => {
    if (!attempt) {
      attempt = {started_at: new Date().toISOString(), outcomes: []};
      state.ac_completion ??= [];
      state.ac_completion.push(attempt);
    }
    attempt.outcomes = outcomes;
    fs.writeFileSync(path.join(root, 'lander.json'), JSON.stringify(state));
  };
    const outcomes = await completeACs(config, load('input'), state, result, {read, many,
      write: request => mutateTasks({config: service, joppaWorker: worker}, request), persist});
    for (const outcome of outcomes) console.log('AC completion: ' + outcome.address + ' ' + outcome.status + (outcome.reason ? ': ' + outcome.reason : ''));
    if (code === 'BLOCKED' && result.status === 'blocked' && result.reason_code === 'TASK_REJECTED' &&
      result.claim_released === true && !result.needs_recovery && state.pending === 'TASK_REJECTED' &&
      Array.isArray(state.accepted) && state.accepted.length === 0 && !state.landed) code = 'TASK_REJECTED';
  } catch (error) {
    console.error('AC completion deferred: ' + error.message);
    try { persist([{status: 'deferred', reason: error.message}]); }
    catch (persistError) { console.error('AC completion state unavailable: ' + persistError.message); }
  } finally { console.log(`<signal:${code}>Preserve the confirmed Task publication result.</signal:${code}>`); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 2; });
}
