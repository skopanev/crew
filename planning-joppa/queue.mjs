// Joppa planning queue reads: ready criteria and their Requirement groups.
import {api} from '../lane-launcher/joppa.mjs';
import {dependencyCheck} from '../lane-launcher/dependencies.mjs';

export function criterionIds(config) {
  const ids = config.ac_ids;
  if (ids === undefined) return null;
  if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !id.includes(':')) ||
      new Set(ids).size !== ids.length) throw new Error('ac_ids must contain distinct full criterion addresses');
  return ids;
}

export async function readyCriteria(config, tokenFile, signal) {
  const ids = criterionIds(config);
  const rows = [];
  const blocked = new Map(), active = new Set(), pending = new Map();
  const service = {joppa: {url: config.url, mcpCommand: config.mcp_command}};
  const dependencies = dependencyCheck((tool, args) => api(service, {tokenFile}, tool,
    {workspace: config.workspace, ...args}, {signal}));
  let cursor;
  do {
    const page = await api(service, {tokenFile}, 'joppa_tasks', {
      workspace: config.workspace, view: 'all', limit: 100, ...(cursor ? {cursor} : {}),
    }, {signal});
    for (const task of page.tasks) {
      if (['done', 'retired'].includes(task.status) || ids && !ids.includes(task.ac)) continue;
      if (typeof task.ac !== 'string' || typeof task.address !== 'string' || !Number.isSafeInteger(task.revision)) {
        throw new Error('Unfinished Task is missing its criterion, address or revision');
      }
      if (task.assignee || task.claim || task.claimable === true) active.add(task.ac);
      if (task.waiting_reason !== 'Task is blocked for planning' || task.assignee || task.claim) continue;
      const tasks = blocked.get(task.ac) || [];
      tasks.push(`${task.address}:${task.revision}`);
      blocked.set(task.ac, tasks);
    }
    cursor = page.next_cursor;
  } while (cursor);
  do {
    const page = await api(service, {tokenFile}, 'joppa_objects', {
      workspace: config.workspace, parent: '*', work_filter: 'unstarted', limit: 25,
      fields: ['title', 'kind', 'revision', 'contract_revision', 'work_ready', 'review_required', 'process', 'work_summary'],
      ...(cursor ? {cursor} : {}),
    }, {signal});
    for (const row of page.items) {
      const work = row.work_summary;
      if ((!ids || ids.includes(row.address)) && row.work_ready === true && !row.review_required &&
          !row.process?.planning_claim && (work?.active === 0 || blocked.has(row.address)) && !active.has(row.address) &&
          (work?.done === 0 || blocked.has(row.address))) pending.set(row.address, row);
    }
    cursor = page.next_cursor;
  } while (cursor);
  for (const ac of blocked.keys()) {
    if (pending.has(ac) || active.has(ac)) continue;
    const object = await api(service, {tokenFile}, 'joppa_objects', {
      workspace: config.workspace, address: ac,
    }, {signal});
    if (object.document?.present === true && object.historical === false &&
        object.work_ready === true && !object.review_required && !object.process?.planning_claim &&
        object.process?.assessment?.state === 'ready' && !object.process?.readiness_blocker) {
      pending.set(ac, {...object, revision: object.current_revision, title: object.document.data.title});
    }
  }
  const candidates = [...pending.values()];
  for (let offset = 0; offset < candidates.length; offset += 100) {
    const batch = candidates.slice(offset, offset + 100);
    const checks = await api(service, {tokenFile}, 'joppa_tests', {
      workspace: config.workspace, ac: batch.map(row => row.address).join(','), summary: true,
    }, {signal});
    const statuses = new Map((checks.items || [checks]).map(row => [row.address, row.status]));
    for (const row of batch) {
      if (!statuses.has(row.address)) throw new Error(`Test status missing for ${row.address}`);
      const status = statuses.get(row.address);
      if (!['green', 'red', 'grey'].includes(status)) throw new Error(`Invalid test status for ${row.address}`);
      const failures = (blocked.get(row.address) || []).sort();
      if (status !== 'green' && (await dependencies(row.address)).ready) {
        rows.push({...row, testStatus: status, failedTaskCount: failures.length,
          attemptKey: JSON.stringify([row.address, row.contract_revision ?? row.revision, failures])});
      }
    }
  }
  return rows.sort((a, b) => Number(b.failedTaskCount > 0) - Number(a.failedTaskCount > 0) ||
    Number(b.testStatus === 'red') - Number(a.testStatus === 'red') ||
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
