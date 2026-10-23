#!/usr/bin/env node
// Recheck the live unit before requirement publication or under the target lock. A read failure must prevent a push.
import fs from 'node:fs';
import path from 'node:path';
import {callJoppa} from '../../lane-launcher/joppa-api.mjs';
import {contractDigest} from '../../lane-launcher/joppa.mjs';
import {dependencyCheck, remoteDependencyBlocker} from '../../lane-launcher/dependencies.mjs';
import {assertRequirementHead, requirementPlan} from '../../lane-launcher/requirement-delivery.mjs';

const require = (condition, message) => {
  if (!condition) throw new Error(message);
};
const text = value => typeof value === 'string' && Boolean(value.trim());

try {
  const args = process.argv.slice(2);
  require(args.length === 0 || (args.length === 1 && ['--publish', '--tasks'].includes(args[0])),
    `Invalid requirement-current arguments: ${args.join(' ')}`);
  const publishMode = args[0] === '--publish';
  const tasksMode = args[0] === '--tasks';

  const claim = JSON.parse(fs.readFileSync(path.join(process.env.MEDULLA_RUN_DIR, 'artifacts/claim.json'), 'utf8'));
  const {plan} = claim.delivery || {};
  const input = claim.delivery?.input || {workspace: claim.workspace,
    config: {joppa: {url: claim.joppa_url}}};
  const mcpCommand = process.env.JOPPA_READER_COMMAND_JSON ? JSON.parse(process.env.JOPPA_READER_COMMAND_JSON) : undefined;
  require(input?.workspace && input.config?.joppa?.url &&
    (mcpCommand || process.env.REQUIREMENT_READER_FILE) &&
    (tasksMode ? claim.source === 'joppa' : plan?.fingerprint && (publishMode || plan.final)),
    'Publication needs the captured Joppa claim and a live reader');
  const finalizeOnly = input.finalizeOnly === true || claim.source === 'joppa-finalization';
  require(!(publishMode && finalizeOnly), 'Finalize-only lane cannot run in --publish mode');

  const objectCache = new Map();
  const read = (tool, toolArgs) => {
    if (tool === 'joppa_objects' && text(toolArgs?.address) && !toolArgs.parent) {
      const key = JSON.stringify([toolArgs.workspace || input.workspace, toolArgs.address]);
      if (!objectCache.has(key)) {
        objectCache.set(key, callJoppa(input.config.joppa.url,
          process.env.REQUIREMENT_READER_FILE, tool, {workspace: input.workspace, ...toolArgs}, {mcpCommand}));
      }
      return objectCache.get(key);
    }
    return callJoppa(input.config.joppa.url,
      process.env.REQUIREMENT_READER_FILE, tool, {workspace: input.workspace, ...toolArgs}, {mcpCommand});
  };

  if (!finalizeOnly) {
    const actor = text(claim.actor) ? claim.actor.trim() : '';
    require(Boolean(actor), 'Captured Task claim is missing actor');
    const tasks = Array.isArray(claim.tasks) && claim.tasks.length
      ? claim.tasks
      : (text(claim.address) && text(claim.digest)
          ? [{address: claim.address, revision: claim.revision, digest: claim.digest, parent: claim.parent}]
          : []);
    require(tasks.length > 0, 'Captured Task claim is missing tasks');
    for (const task of tasks) {
      require(task && text(task.address) && text(task.digest), 'Captured Task claim entry is invalid');
      const current = await read('joppa_objects', {address: task.address});
      require(!remoteDependencyBlocker(current), `Claimed Task has an unmet remote dependency: ${task.address}`);
      require(current && current.address === task.address && current.historical === false &&
        current.document?.present === true && current.document.data?.archived !== true,
        `Claimed Task is absent or historical: ${task.address}`);
      require(current.process?.status === 'in_progress' && current.process?.assignee === actor &&
        !current.process?.retired && !current.process?.done && !current.process?.blocked,
        `Task holder changed: ${task.address}`);
      require(current.work_ready === true && current.review_required === false && current.process?.review_required !== true,
        `Claimed Task needs review or is not work_ready: ${task.address}`);
      require(contractDigest(current) === task.digest, `Task contract changed after claim: ${task.address}`);
      if (task.parent) {
        require(text(task.parent.address) && text(task.parent.digest), `Captured Task parent context is invalid: ${task.address}`);
        const parent = await read('joppa_objects', {address: task.parent.address});
        require(!remoteDependencyBlocker(parent), `Task parent has an unmet remote dependency: ${task.parent.address}`);
        require(parent && parent.address === task.parent.address && parent.historical === false &&
          parent.document?.present === true && parent.document.data?.archived !== true &&
          Number.isSafeInteger(parent.current_revision) && parent.current_revision > 0 &&
          parent.work_ready === true && parent.review_required === false && parent.process?.review_required !== true &&
          !parent.process?.planning_claim && !parent.planning_claim,
          `Task parent context needs review or has active planning: ${task.parent.address}`);
        require(contractDigest(parent) === task.parent.digest, `Task parent context changed after claim: ${task.parent.address}`);
      }
    }
    require(Array.isArray(claim.contexts) && claim.contexts.length > 0, 'Captured Task claim is missing contexts');
    for (const context of claim.contexts) {
      require(context && text(context.address) && text(context.digest), 'Captured claim context entry is invalid');
      const parent = await read('joppa_objects', {address: context.address});
      require(!remoteDependencyBlocker(parent), `Acceptance context has an unmet remote dependency: ${context.address}`);
      require(parent && parent.address === context.address && parent.historical === false &&
        parent.document?.present === true && parent.document.data?.archived !== true &&
        parent.review_required === false && parent.process?.review_required !== true &&
        !parent.process?.planning_claim && !parent.planning_claim,
        `Acceptance context is invalid, needs review, or has active planning: ${context.address}`);
      require(contractDigest(parent) === context.digest, `Acceptance context changed after claim: ${context.address}`);
    }
    if (tasksMode) {
      const ready = dependencyCheck(read);
      for (const task of tasks) {
        const dependency = await ready(task.address);
        require(dependency.ready, `Task dependency changed: ${dependency.blocker}`);
      }
    }
  }

  if (!tasksMode) {
    const fresh = await requirementPlan(input, read);
    require(!fresh.planningHeld && fresh.branch === plan.branch &&
      fresh.requirement === plan.requirement && fresh.repository === plan.repository,
      'Requirement planning is active or unit identity changed');
    assertRequirementHead(fresh, process.env.REQUIREMENT_HEAD || plan.head || '');
    if (!publishMode) {
      require(fresh.final && fresh.fingerprint === plan.fingerprint,
        'Requirement composition or planning ownership changed after claim');
    }
    console.log('Requirement composition is current; no planner holds the unit.');
  } else {
    console.log('Task contracts and dependencies are current.');
  }
} catch (error) {
  console.error(`REQUIREMENT_CHANGED: ${error.message}`);
  process.exitCode = 1;
}
