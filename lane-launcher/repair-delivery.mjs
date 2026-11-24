// A configured red pending branch keeps its Task and its reviewed scope during integration repair.
import fs from 'node:fs';
import path from 'node:path';
import {contractDigest} from './joppa-common.mjs';
import {nodePendingDelivery, nodeStage, nodeAssignee} from './joppa-nodes.mjs';
import {taskRepositoryChoice} from './task-contract.mjs';
const need = (ok, message) => { if (!ok) throw Object.assign(new Error('DELIVERY_REPAIR: ' + message), {code: 'CANDIDATE_INVALID'}); };
const text = value => typeof value === 'string' && value.trim() === value && value.length > 0;
const data = node => node.document?.data ?? node.data ?? node;
const value = (node, key) => node.document?.data?.[key] ?? node.data?.[key] ?? node['data.' + key];
const digest = (node, policy) => {
  const authored = {...node.document.data};
  for (const key of ['delivery', policy.attemptField, ...Object.keys(policy.redData)]) delete authored[key];
  return contractDigest({...node, document: {...node.document, data: authored}});
};

export function repairSettings(config) {
  const policy = config.repairDelivery;
  if (policy === undefined) return null;
  need(policy && typeof policy === 'object' && !Array.isArray(policy) &&
    ['redTag', 'runsFolder', 'parentStage', 'returnStage', 'defectTaskStage', 'attemptField', 'exhaustedTag'].every(key => text(policy[key])) &&
    Number.isSafeInteger(policy.maxAttempts) && policy.maxAttempts > 0 &&
    path.isAbsolute(policy.runsFolder) && policy.redData && typeof policy.redData === 'object' && !Array.isArray(policy.redData),
  'configure repair stages, markers, evidence folder and attempt limit');
  need(!Object.keys(policy.redData).some(key => ['stage', 'assignee', 'commit', 'delivery', 'repository', 'tags'].includes(key)),
    'redData cannot change lifecycle fields');
  need(config.delivery === 'branch', 'repair needs branch delivery');
  need(!['stage', 'assignee', 'commit', 'delivery', 'repository', 'tags', ...Object.keys(policy.redData)].includes(policy.attemptField) &&
    config.joppa.excludeTags?.includes(policy.exhaustedTag), 'the attempt field must be separate and exhaustedTag must be excluded');
  return policy;
}

export function repairCandidate(config, node) {
  const policy = repairSettings(config), tags = value(node, 'tags'), delivery = value(node, 'delivery');
  return Boolean(policy && nodePendingDelivery(node) && Array.isArray(tags) && tags.includes(policy.redTag) &&
    text(delivery?.branch) && Object.entries(policy.redData).every(([key, expected]) => value(node, key) === expected));
}

export function repairParentReady(config, node) {
  const policy = repairSettings(config);
  return !policy || nodeStage(node) === policy.parentStage;
}

export function repairEvidence(config, node) {
  const policy = repairSettings(config);
  need(repairCandidate(config, node), 'the Task no longer has its configured red pending marker');
  const delivery = data(node).delivery, repo = taskRepositoryChoice(config, data(node), {required: true});
  need(repairAttempts(config, node) < policy.maxAttempts, 'the repair attempt limit is reached for this Task');
  need(repo && delivery.target === repo.targetBranch && delivery.head === data(node).commit &&
    /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(delivery.head), 'the saved branch head, commit and target must match');
  const source = fs.realpathSync(config.sourceRoot), root = fs.realpathSync(policy.runsFolder);
  need(root.startsWith(source + path.sep), 'the evidence root must be inside the configured read-only source root');
  const matches = [];
  for (const entry of fs.readdirSync(root, {withFileTypes: true})) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const artifacts = path.join(root, entry.name, 'artifacts'), inputFile = path.join(artifacts, 'input.json'), stateFile = path.join(artifacts, 'lander.json');
    if (!fs.existsSync(inputFile) || !fs.existsSync(stateFile)) continue;
    need(fs.realpathSync(artifacts).startsWith(root + path.sep), 'the evidence folder escapes its configured root');
    if ([inputFile, stateFile].some(file => !fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())) continue;
    let input, state;
    try { input = JSON.parse(fs.readFileSync(inputFile, 'utf8')); state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
    catch { continue; }
    const original = (input.items || [input.selected]).find(item => item?.address === node.address);
    if (!original || original.document?.data?.delivery?.branch !== delivery.branch ||
        original.document.data.delivery.head !== delivery.head || state.repository !== repo.id || state.target !== delivery.target ||
        !state.failed?.[node.address] || !state.pins?.some(pin => pin.address === node.address && pin.head === delivery.head && pin.branch === delivery.branch)) continue;
    need(digest(original, policy) === digest(node, policy), 'the original Task contract changed after its branch failed');
    const relative = path.relative(source, artifacts).split(path.sep).join('/');
    matches.push({branch: delivery.branch, head: delivery.head, target: delivery.target,
      reason: state.failed[node.address], run: entry.name,
      evidence: '/workspace/' + path.basename(source) + '/' + relative,
      at: fs.statSync(stateFile).mtimeMs});
  }
  need(matches.length > 0, 'no saved Lander failure matches this exact Task and branch head');
  matches.sort((a, b) => b.at - a.at);
  const {at, ...selected} = matches[0];
  return selected;
}

export function attachDeliveryRepair(run, object) {
  if (!repairCandidate(run.config, object)) return;
  const repair = repairEvidence(run.config, object);
  run.repairDelivery = repair;
  run.deliveryBranch = repair.branch;
  run.claim.ticket = {...run.claim.ticket, integrationRepair: repair};
}

export async function validateRepairTask(config, object, read, expected) {
  if (expected) need(repairCandidate(config, object) && object.document.data.delivery.branch === expected.branch &&
    object.document.data.delivery.head === expected.head, 'the frozen repair marker or branch changed');
  if (!repairCandidate(config, object)) return;
  repairEvidence(config, object);
  const parent = await read('joppa_objects', {address: object.document.parent});
  need(parent?.address === object.document.parent && parent.historical === false &&
    parent.document?.present === true && !nodeAssignee(parent) && repairParentReady(config, parent),
  'the acceptance parent is not in its configured implementation stage or is held');
}

export function clearRepairMarkers(config, node) {
  const policy = repairSettings(config);
  if (!policy) return {};
  const delivery = data(node).delivery;
  const changes = {[policy.attemptField]: {branch: delivery.branch, head: delivery.head, count: repairAttempts(config, node) + 1}};
  if (Array.isArray(data(node).tags)) changes.tags = data(node).tags.filter(tag => tag !== policy.redTag);
  for (const [key, expected] of Object.entries(policy.redData)) if (data(node)[key] === expected) changes[key] = null;
  return changes;
}

export function repairAttempts(config, node) {
  const policy = repairSettings(config), previous = data(node)[policy.attemptField];
  if (previous == null) return 0;
  need(previous && typeof previous === 'object' && Number.isSafeInteger(previous.count) && previous.count >= 0 &&
    text(previous.branch) && text(previous.head), 'the saved repair attempt count is invalid');
  return previous.count;
}

export function failedRepairChanges(config, node) {
  const policy = repairSettings(config), delivery = data(node).delivery, count = repairAttempts(config, node) + 1;
  return {[policy.attemptField]: {branch: delivery.branch, head: delivery.head, count},
    ...(count >= policy.maxAttempts ? {tags: [...new Set([...(data(node).tags || []), policy.exhaustedTag])]} : {})};
}
