// Read live dependency state for one queue check. Store no persistent state.
import {nodeWaiting} from './joppa-nodes.mjs';
const invalid = message => Object.assign(new Error(message), {code: 'DEPENDENCY_INVALID'});

const validWorkspaceId = value => typeof value === 'string' && Boolean(value.trim()) &&
  value === value.trim() && !/[\0-\x20\x7f]/.test(value);

const validRemoteLink = (link, ownWorkspace) => Boolean(link && typeof link === 'object' &&
  validWorkspaceId(link.workspace) && (!ownWorkspace || link.workspace !== ownWorkspace) &&
  typeof link.target === 'string' && /^[^:\s]+:[^:\s]+$/.test(link.target));

const currentPin = (pin, current, contract) => Number.isSafeInteger(pin) &&
  Number.isSafeInteger(current) && Number.isSafeInteger(contract) &&
  contract >= 1 && contract <= pin && pin <= current;

const remoteLinkReady = link => {
  const status = link.status;
  if (!status || typeof status !== 'object') return false;
  if (status.access !== true || status.present !== true || status.satisfied !== true) return false;
  if (status.review_required !== false) return false;
  // Joppa checks the target contract and exposes the result as review_required.
  return currentPin(link.revision, status.current_revision, 1);
};

export function remoteDependencyBlocker(object, ownWorkspace = object?.workspace_key) {
  if (!object || typeof object !== 'object') throw invalid('Dependency object is invalid');
  if (ownWorkspace !== undefined && ownWorkspace !== null && !validWorkspaceId(ownWorkspace)) {
    throw invalid('Dependency object workspace_key is invalid');
  }
  if (object.remote_links === undefined || object.remote_links === null) return null;
  if (!Array.isArray(object.remote_links)) throw invalid('Dependency remote_links must be an array');
  for (const link of object.remote_links) {
    if (!link || typeof link !== 'object') throw invalid('Dependency remote link is invalid');
    if (link.blocking === true && link.relation !== 'depends_on') {
      throw invalid('Blocking remote link must use depends_on');
    }
    if (link.relation !== 'depends_on' || link.blocking !== true) continue;
    if (!validRemoteLink(link, ownWorkspace)) throw invalid('Dependency remote link target is invalid');
    if (!remoteLinkReady(link)) return `@${link.workspace}/${link.target}`;
  }
  return null;
}

export function dependencyCheck(read) {
  const objects = new Map();
  let workspaceKey;
  const object = async address => {
    if (!objects.has(address)) objects.set(address, read('joppa_objects', {address}));
    const value = await objects.get(address);
    if (value?.address !== address || !value.document || value.historical !== false ||
        !Number.isSafeInteger(value.current_revision)) throw invalid('Dependency read did not return a current object');
    if (value.workspace_key != null) {
      if (!validWorkspaceId(value.workspace_key)) throw invalid('Dependency object workspace_key is invalid');
      if (workspaceKey && workspaceKey !== value.workspace_key) throw invalid('Dependency read crossed workspace boundary');
      workspaceKey = value.workspace_key;
    }
    return value;
  };
  return async address => {
    const start = await object(address);
    // Joppa computes local ordering. Do not reinterpret the target's tone or readiness.
    if (start.work_ready === false || nodeWaiting(start)) {
      return {ready: false, blocker: start.waits_for?.address || start.address};
    }
    const seen = new Set();
    let node = start;
    while (node) {
      if (node.document.present !== true || seen.has(node.address)) return {ready: false, blocker: node.address};
      seen.add(node.address);
      for (const link of node.document.links || []) {
        if (link.relation !== 'depends_on' || link.blocking !== true) continue;
        if (link.workspace !== undefined) throw invalid('Dependency workspace link must use remote_links');
        if (link.revision != null && !currentPin(link.revision, Number.MAX_SAFE_INTEGER, 1)) {
          throw invalid(`Invalid linked revision on ${node.address}: ${link.target}`);
        }
      }
      const blocker = remoteDependencyBlocker(node, workspaceKey);
      if (blocker) return {ready: false, blocker};
      node = node.document.parent ? await object(node.document.parent) : null;
    }
    return {ready: true, blocker: null};
  };
}

export const formatDependencyIssue = issue => `${issue.code} · ${issue.task || issue.consumer} → ${issue.blocker}` +
  ` · pin=${issue.pin} · contract=${issue.contractRevision ?? '?'} · current=${issue.currentRevision}`;
