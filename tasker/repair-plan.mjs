import {retirementRequired, retirementProblems} from './retirement-proof.mjs';
import {bindingPlan, contractText, contractHash} from './test-bindings.mjs';
import {verifiedSplitReplan} from './host-split-replan.mjs';
// Business rules for the Task input. The shared configured-flow publisher owns claims and all writes.
const problem = message => { throw new Error(message); };
const text = value => typeof value === 'string' && Boolean(value.trim());
const gapQuestion = gap => gap && typeof gap === 'object' && !Array.isArray(gap) &&
  ['cto', 'ceo'].includes(gap.owner) && ['question', 'a', 'b'].every(key => text(gap[key]) && gap[key].length <= 1000) &&
  ['A', 'B'].includes(gap.recommended);
export const acText = contractText;
export const changedText = (current, pinned) => Boolean(pinned && JSON.stringify(acText(current)) !== JSON.stringify(acText(pinned)));

// Keep refusal routing when metadata is absent or conflicts with the captured schema.
export function repositoryData(input, node) {
  const field = input.schema?.types?.[node.kind]?.fields?.repository;
  const allowed = field?.type === 'enum' && Array.isArray(field.values) ? field.values : [];
  const data = node.document?.data || {}, existing = data.repository;
  if (typeof existing === 'string' && existing && allowed.includes(existing)) return {repository: existing};
  if (existing != null && existing !== '') return {};
  const lines = String(data.body || '').split(/\r?\n/).filter(line => line.startsWith('Repository:'));
  if (lines.length !== 1) return {};
  const value = lines[0].slice('Repository: '.length);
  return lines[0] === 'Repository: ' + value && value && allowed.includes(value) ? {repository: value} : {};
}

export function repairView(input, repair) {
  const context = input.context, task = structuredClone(input.selected);
  const body = task.document.data.body;
  if (typeof body === 'string') {
    task.document.data.body = body.replace(/^Read only:[ \t]*/gmi, 'Context: ');
    if (task.data && Object.hasOwn(task.data, 'body')) task.data.body = task.document.data.body;
  }
  const kinds = new Set([input.selected.kind, context.parent.kind, ...context.children.map(item => item.kind),
    ...Object.values(context.references).flat().map(item => item.kind)]);
  return {...input, selected: context.parent, children: context.children, references: context.references,
    schema: {...input.schema, types: Object.fromEntries(Object.entries(input.schema.types).filter(([kind]) => kinds.has(kind)))},
    help: undefined, claim_revision: undefined, claim_revisions: undefined, context: undefined,
    repair: {task, dependents: context.incoming ?? [], ac_text_changed: repair.ac_text_changed, pinned_revision: repair.pinned_revision,
      ...(repair.baseline_note ? {baseline_note: repair.baseline_note} : {}),
      ...(repair.split_replan ? {split_replan: repair.split_replan} : {})}};
}

export function checkRepair({input, repair, draft, trees, maxFiles, maxLines, forecast, checkPlan, requiredDoneCommit}) {
  const problems = [], task = input.selected, criterion = input.context.parent;
  const fail = message => problems.push(message);
  problems.push(...bindingPlan({input, draft, trees}).problems);
  if (!['READY', 'STALE', 'DECISION_REQUIRED'].includes(draft?.verdict)) {
    return {ok: false, problems: ['A Task input needs READY, STALE or DECISION_REQUIRED'], tasks: []};
  }
  if (!text(draft.reason)) fail('reason is required');
  if (repair.ac_text_changed && draft.verdict !== 'STALE') fail('The pinned AC contract changed: retire the stale Task');
  const view = repairView(input, repair);
  let checked = {ok: true, problems: [], tasks: []};
  if (draft.verdict === 'READY') {
    const proposed = draft.task;
    if (!proposed || proposed.id !== task.address.split(':')[1]) fail('READY must keep the selected Task id');
    if (proposed?.title !== task.document.data.title) fail('READY keeps the selected Task title');
    const repository = task.document.data.repository;
    if (repository != null && repository !== '' && repository !== proposed?.repository) fail('READY cannot replace a nonempty Task repository');
    if (proposed) {
      const named = new Set(proposed.tests || []);
      checked = checkPlan({input: {...view, children: view.children.filter(item => named.has(item.address))},
        trees, draft: {verdict: 'OK', reason: draft.reason, tasks: [proposed]}, maxFiles, maxLines, forecast});
    }
  } else if (draft.verdict === 'STALE') {
    if (typeof draft.needs_code !== 'boolean') fail('STALE needs needs_code true or false for the current AC');
    if (retirementRequired(repair, draft) && !verifiedSplitReplan({input, repair, draft, trees})) {
      problems.push(...retirementProblems({input, repair, draft, trees}));
    }
  } else {
    if (!gapQuestion(draft.gap)) fail('DECISION_REQUIRED needs gap owner cto/ceo, question, A/B options and recommendation');
  }
  problems.push(...checked.problems);
  return {ok: problems.length === 0, problems, tasks: checked.tasks, criterion: criterion.address,
    ac_text_changed: repair.ac_text_changed};
}

export function repairPublication({input, draft, run, dry = false, repair = {}, trees = {}, reviews, digest, gapTags}) {
  if (draft.test_bindings != null && (!Array.isArray(draft.test_bindings) || draft.test_bindings.length)) {
    return {approved: false, critique: {host: {invalid: 'Task repair cannot update parent Test bindings. Correct the draft without inventing an owner question.'}}};
  }
  const replan = verifiedSplitReplan({input, repair, draft, trees, reviews: reviews ?? [], digest});
  if (retirementRequired(repair, draft) && !replan) {
    const failures = retirementProblems({input, repair, draft, trees, reviews: reviews ?? [], digest});
    if (failures.length) {
      const reason = ('Task deliverables are not verified. ' + failures.join(' ')).slice(0, 900);
      return {approved: false, critique: {host: {invalid: reason}}};
    }
  }
  const task = input.selected, parent = input.context.parent, incoming = input.context.incoming;
  const reason = String(draft.reason || '').slice(0, 1000), operations = [];
  const save = (node, data, revision = node.current_revision) => ({command: {op: 'save_object', kind: node.kind,
    id: node.address.split(':')[1], revision, data, reason}});
  const note = text => ({command: {op: 'note', target: task.address,
    id: ('tasker-repair-' + run).replace(/[^A-Za-z0-9_.-]/g, '_').slice(-120), text}});
  let code;
  if (draft.verdict === 'READY') {
    const repository = task.document.data.repository;
    if (repository != null && repository !== '' && repository !== draft.task.repository) problem('READY cannot replace a nonempty Task repository');
    operations.push(save(task, {body: draft.task.body, repository: draft.task.repository, stage: 'to_implement',
      ac_contract_hash: contractHash({selected: parent, children: input.context.children, schema: input.schema})}, input.claim_revision));
    code = 'READY';
  } else if (draft.verdict === 'STALE') {
    if (typeof draft.needs_code !== 'boolean') problem('STALE requires needs_code');
    // Child edits advance the parent revision. Save the frozen parent first.
    if (draft.needs_code) operations.push(save(parent, {stage: 'to_task'}));
    for (const consumer of incoming) {
      if (consumer.document.data.assignee) problem('An incoming dependent Task is held: ' + consumer.address);
      if (draft.needs_code) continue;
      const group = consumer.relations?.depends_on;
      if (!group || !Array.isArray(group.edges)) problem('Incoming dependency has no native relation group');
      const edges = group.edges.filter(edge => edge.to !== task.address);
      if (edges.length === group.edges.length) problem('Incoming dependency no longer names the selected Task');
      operations.push({command: {op: 'save_object', kind: consumer.kind, id: consumer.address.split(':')[1],
        revision: consumer.current_revision, relations: {depends_on: {...group, edges}}, reason}});
    }
    operations.push({command: {op: 'archive_object', target: task.address, revision: input.claim_revision, reason}});
    code = 'STALE';
  } else if (draft.verdict === 'DECISION_REQUIRED') {
    const gap = draft.gap;
    if (!gapQuestion(gap)) problem('DECISION_REQUIRED needs gap owner cto/ceo, question, A/B options and recommendation');
    const tag = gapTags?.[gap.owner], tags = task.document.data.tags ?? [];
    if (!text(tag) || tag.trim() !== tag) problem('Configure the owner gap tag');
    if (!Array.isArray(tags)) problem('Task tags must be an array');
    operations.push(save(task, {stage: 'to_review', ...repositoryData(input, task), tags: [...new Set([...tags, tag])]}, input.claim_revision),
      note(`OPEN QUESTION\nOwner: ${gap.owner}\nQuestion: ${gap.question}\n${gap.recommended === 'A' ? '★ ' : ''}A: ${gap.a}\n${gap.recommended === 'B' ? '★ ' : ''}B: ${gap.b}\nRecommended: ${gap.recommended}\nReason: ${reason}`));
    code = 'DECISION_REQUIRED';
  } else problem('Unknown Task repair verdict');
  if (repair.baseline_note) {
    const existing = operations.find(row => row.command.op === 'note' && row.command.target === task.address);
    if (existing) existing.command.text += '\n' + repair.baseline_note;
    else {
      const archive = operations.findIndex(row => row.command.op === 'archive_object' && row.command.target === task.address);
      operations.splice(archive < 0 ? operations.length : archive, 0, note(repair.baseline_note));
    }
  }
  const proposed = {operations, outcome: {status: draft.verdict === 'DECISION_REQUIRED' ? 'blocked' : 'published',
    reason_code: code, reason}};
  return {approved: true, would_publish: proposed, publication: dry
    ? {operations: [], outcome: {status: 'blocked', reason_code: 'DRY_RUN', reason: ('Would be ' + code + ': ' + reason).slice(0,1000)}}
    : proposed};
}
