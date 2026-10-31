import {contractDigest, executionId} from './joppa-common.mjs';
import {taskContract} from './task-contract.mjs';
const require = (condition, message) => { if (!condition) throw new Error(message); };
const text = value => typeof value === 'string' && value.trim();

export function packageInput(run, inputs) {
  if (inputs.length === 1) return {...inputs[0].ticket, id: run.executionId};
  const tasks = inputs.map(input => input.ticket);
  return {id: run.executionId, address: run.requirement, title: `${run.requirement}: ${inputs[0].repo.id}`,
    source: 'joppa', requirement: run.requirement, repository: inputs[0].repo.id,
    module: tasks[0].module, modulePaths: [...new Set(tasks.flatMap(task => task.modulePaths))],
    tasks, executionOrder: tasks.map(task => task.address),
    body: ['Execute these Tasks in the listed order in one checkout. Keep each Task within its own contract and writable roots.',
      'Run one workflow, required gates, independent review, and landing for the complete package.',
      'Report each Task address, result, and check evidence in coder-report.txt. Review every Task before landing.',
      ...tasks.map((task, index) => `Task ${index + 1}: ${task.address}\nWritable roots: ${JSON.stringify(task.modulePaths)}\n${task.body}`)].join('\n\n'),
    acceptance: tasks.map(task => `${task.address}\n${task.acceptance}`).join('\n\n')};
}

const RECOVERY_HEADER = 'CREW_RECOVERY_CHECKPOINT';
export const formatContexts = contexts => (contexts || []).map(item => `${item.address}=${item.digest}`).join(',');

export function formatRecoveryNote({task, digest, contexts, ref, sha, tree, base, node = 'implement_code', runId}) {
  return [RECOVERY_HEADER, `Task: ${task}`, `Digest: ${digest}`, `Contexts: ${contexts}`,
    `Ref: ${ref}`, `SHA: ${sha}`, `Tree: ${tree}`, `Base: ${base}`, `Node: ${node}`, `Run: ${runId}`].join('\n');
}

export function latestRecovery(config, object, digest = contractDigest(object), contexts = object.contexts) {
  const actors = new Set((config.joppa?.workers || []).map(worker => worker.actor).filter(Boolean));
  const comments = object.annotations?.comments;
  if (!comments || typeof comments !== 'object') return null;
  if (object.document?.parent && (!Array.isArray(contexts) || !contexts.length)) return null;
  const expectedContexts = Array.isArray(contexts) ? formatContexts(contexts) : '';
  const candidates = [];
  for (const [id, comment] of Object.entries(comments)) {
    if (!comment || comment.withdrawn === true || !actors.has(comment.actor) || typeof comment.text !== 'string') continue;
    const lines = comment.text.trim().split(/\r?\n/);
    if (lines[0] !== RECOVERY_HEADER) continue;
    const fields = Object.fromEntries(lines.slice(1).flatMap(line => {
      const match = /^([A-Za-z]+):[ \t]*(\S[^\r\n]*)$/.exec(line);
      return match ? [[match[1], match[2].trim()]] : [];
    }));
    if (fields.Task !== object.address || fields.Digest !== digest || fields.Node !== 'implement_code') continue;
    if (!/^refs\/heads\/recovery\/[A-Za-z0-9._-]+$/.test(fields.Ref || '') ||
        fields.Ref.includes('..') || fields.Ref.endsWith('.lock') || fields.Ref.endsWith('/')) continue;
    if (!/^[0-9a-f]{40,64}$/.test(fields.SHA || '') || !/^[0-9a-f]{40,64}$/.test(fields.Tree || '') ||
        !/^[0-9a-f]{40,64}$/.test(fields.Base || '') || fields.SHA === fields.Base) continue;
    candidates.push({noteId: id, actor: comment.actor, at: comment.at || comment.created_at || '',
      task: fields.Task, digest: fields.Digest, ...(fields.Contexts ? {contexts: fields.Contexts} : {}),
      ref: fields.Ref, sha: fields.SHA, tree: fields.Tree, base: fields.Base,
      node: fields.Node, ...(fields.Run ? {run: fields.Run} : {})});
  }
  candidates.sort((a, b) => {
    const ta = Date.parse(a.at), tb = Date.parse(b.at);
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
    if (a.at !== b.at) return String(a.at).localeCompare(String(b.at));
    return a.noteId.localeCompare(b.noteId);
  });
  const recovery = candidates.at(-1) || null;
  require(!recovery || !expectedContexts || recovery.contexts === expectedContexts,
    'RECOVERY_CONTEXT_CHANGED: Checkpoint acceptance context changed; Task remains held');
  return recovery;
}

export function taskInput(config, object, contexts = object.contexts) {
  require(object.document?.present === true && object.historical === false, 'Joppa Task is absent or historical');
  const data = object.document.data;
  const contract = taskContract(data);
  const field = name => {
    const matches = [...contract.matchAll(new RegExp(`^${name}:[ \\t]*(\\S[^\\r\\n]*)$`, 'gm'))];
    require(matches.length === 1, `Task contract needs exactly one ${name}: line`);
    return matches[0][1].trim();
  };
  const repo = config.repositories.find(repo => repo.id === field('Repository'));
  require(repo, 'Task repository is not configured');
  const module = field('Module');
  const configuredModule = repo.modules.find(item => item.name === module);
  const modulePath = configuredModule?.path;
  require(modulePath, 'Task module is not configured');
  const modulePaths = configuredModule.paths || [modulePath];
  const recovery = latestRecovery(config, object, contractDigest(object), contexts);
  return {repo, ticket: {id: executionId(object.address), address: object.address, item_id: object.item_id, title: data.title,
    body: contract, module: modulePath, moduleId: module, modulePaths,
    repository: repo.id, revision: object.current_revision, source: 'joppa',
    parent: object.document.parent, links: object.document.links, annotations: object.annotations || {}, acceptance: contract,
    ...(object.remote_links?.length ? {remote_links: object.remote_links} : {}),
    ...(recovery ? {recovery: {...recovery,
      instruction: `Resume from checkpoint ${recovery.sha} on ${recovery.ref} (base ${recovery.base}). The checkout already contains this checkpoint. Do not reapply an older recovery patch. Check existing changes against the Task contract. Keep changes within writable roots ${JSON.stringify(modulePaths)}. Complete only the remaining work.`}} : {})}};
}
