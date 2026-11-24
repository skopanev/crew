// Bind planned Test cases after the same draft receives both critic approvals.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {reporterNames, reporterFile, namedTests} from './reporter-names.mjs';

const text = value => typeof value === 'string' && value.trim().length > 0;
const role = (input, kind) => input.schema?.types?.[kind]?.role ?? kind;
const matchesOwners = ({repo, name}, owners, trees) => {
  const file = reporterFile(name);
  return Boolean(file && Object.hasOwn(trees, repo) && owners.length && owners.every(task => task.repository === repo &&
    Array.isArray(task.files) && task.files.some(entry => entry?.path === file && entry.change !== 'delete')));
};

export const contractText = node => {
  const data = node.document?.data ?? {};
  return {title: data.title ?? '', body: data.body ?? '', sources: [...(data.sources ?? [])].sort()};
};

export function contractHash(input) {
  const tests = (input.children ?? []).filter(node => role(input, node.kind) === 'test' && node.document?.present !== false)
    .map(node => ({address: node.address, title: node.document?.data?.title ?? '', body: node.document?.data?.body ?? ''}))
    .sort((a, b) => a.address.localeCompare(b.address));
  return createHash('sha256').update(JSON.stringify({...contractText(input.selected), tests})).digest('hex');
}

// Read only the captured acceptance text. Writer owns every metadata correction.
export function metadataFindings(input) {
  const tests = (input.context?.children ?? input.children ?? []).filter(node =>
    role(input, node.kind) === 'test' && node.historical !== true && node.document?.present !== false);
  const named = namedTests(input.selected.document?.data?.body);
  return tests.filter(node => !named || named.has(node.address)).flatMap(node => {
    const data = node.document?.data ?? {}, bindings = reporterNames(data.body);
    if (bindings.length && bindings.every(binding => reporterFile(binding.name)) && text(data.command)) return [];
    return [{target: node.address, quote: data.body || data.title || '', reason_code: 'INCOMPLETE_TEST_METADATA',
      problem: 'The Test needs an existing Reporter binding and a nonempty command.'}];
  });
}

export function bindingPlan({input, draft, trees = {}}) {
  draft ??= {};
  const problems = [], operations = [], bindings = draft.test_bindings ?? [];
  if (!Array.isArray(bindings)) return {problems: ['test_bindings must be an array'], operations};
  const repair = role(input, input.selected.kind) === 'task' || Boolean(input.repair);
  if (repair || !['OK', 'SPLIT'].includes(draft.verdict)) {
    if (bindings.length) problems.push('test_bindings are permitted only for an AC implementation plan');
    if (repair && draft.verdict === 'READY') {
      const tests = new Map((input.context?.children ?? input.children ?? []).map(item => [item.address, item]));
      for (const address of draft.task?.tests ?? []) {
        const data = tests.get(address)?.document?.data ?? {};
        const existing = reporterNames(data.body);
        if (!existing.length || !existing.every(binding => matchesOwners(binding, [draft.task], trees)) || !text(data.command)) {
          problems.push(`${address}: READY needs an existing complete binding; return a supported Test finding to Writer without changing parent Tests`);
        }
      }
    }
    return {problems, operations};
  }
  const tests = new Map((input.children ?? []).filter(item => role(input, item.kind) === 'test').map(item => [item.address, item]));
  const tasks = Array.isArray(draft.tasks) ? draft.tasks : [];
  const planned = new Map(), seen = new Set();
  for (const task of tasks) for (const address of Array.isArray(task?.tests) ? task.tests : []) {
    const owners = planned.get(address) ?? [];
    owners.push(task); planned.set(address, owners);
  }
  for (const binding of bindings) {
    const address = binding?.test, node = tests.get(address), owners = planned.get(address) ?? [];
    if (!binding || typeof binding !== 'object' || Array.isArray(binding) ||
        Object.keys(binding).some(key => !['test', 'repository', 'reporter_name', 'command'].includes(key)) ||
        !node || !owners.length || seen.has(address)) {
      problems.push('Each test_binding must uniquely name a direct Test that a planned Task uses'); continue;
    }
    seen.add(address);
    const {repository, reporter_name: name, command} = binding;
    if (!text(repository) || !matchesOwners({repo: repository, name}, owners, trees)) {
      problems.push(`${address}: Reporter name must identify a test file in each Task repository and files`); continue;
    }
    if (!text(command)) { problems.push(`${address}: binding command must be nonempty`); continue; }
    const data = node.document.data, existing = reporterNames(data.body);
    if (data.assignee) { problems.push(`${address}: a held Test cannot receive binding updates`); continue; }
    if (!text(data.body)) { problems.push(`${address}: preserve a nonempty Test acceptance body`); continue; }
    if (existing.length && (existing.length !== 1 || existing[0].repo !== repository || existing[0].name !== name)) {
      problems.push(`${address}: preserve the existing Reporter binding`); continue;
    }
    if (text(data.command) && data.command !== command) {
      problems.push(`${address}: preserve the existing command`); continue;
    }
    if (existing.length && text(data.command)) {
      continue;
    }
    const body = typeof data.body === 'string' ? data.body : '';
    const line = `Repository: ${repository}. Reporter name: ${name}`;
    if (reporterNames(line).length !== 1) { problems.push(`${address}: repository does not fit the Reporter binding format`); continue; }
    const nextBody = existing.length ? body : body + (body.endsWith('\n') || !body ? '' : '\n') + line;
    const limit = input.schema?.types?.[node.kind]?.field_max_length ?? Infinity;
    if (['body', 'command'].some(field => (input.schema?.types?.[node.kind]?.fields?.[field]?.from ?? 'own') !== 'own')) {
      problems.push(`${address}: binding fields must belong to the Test schema`); continue;
    }
    if (nextBody.length > limit || command.length > limit) {
      problems.push(`${address}: binding exceeds the Test schema limit ${limit}; preserve the acceptance text`); continue;
    }
    if (!Number.isSafeInteger(node.current_revision) || node.current_revision < 1) {
      problems.push(`${address}: binding needs the frozen Test revision`); continue;
    }
    operations.push({command: {op: 'save_object', kind: node.kind, id: address.slice(address.indexOf(':') + 1),
      revision: node.current_revision, data: {...(nextBody !== body ? {body: nextBody} : {}), command},
      reason: 'Save the Test binding from the Task plan that both critics approved.'}});
  }
  for (const [address, owners] of planned) {
    const node = tests.get(address);
    if (!node) continue;
    const data = node.document.data;
    if (seen.has(address)) continue;
    const existing = reporterNames(data.body);
    if (existing.length && !existing.every(binding => matchesOwners(binding, owners, trees))) {
      problems.push(`${address}: the existing Reporter binding does not match each Task repository and files`);
    } else if (!existing.length || !text(data.command)) {
      problems.push(data.assignee ? `${address}: the Test is held; complete its binding before planning this AC` :
        `${address}: supply typed test_bindings for the planned Test`);
    }
  }
  if (1 + operations.length + tasks.length > 100) problems.push('Test updates and Tasks exceed the native batch limit of 100 operations');
  return {problems, operations};
}

export function bindingPublication({input, draft, trees, review, dry = false}) {
  if (!review.approved) return review;
  const {problems, operations} = bindingPlan({input, draft, trees});
  if (problems.length) return {approved: false, critique: {bindings: {verdict: 'REWORK',
    findings: problems.map(problem => ({problem, advice: 'Correct test_bindings without changing the acceptance text.'})), summary: problems.join('; ')}}};
  const [stage, ...tasks] = review.would_publish.operations;
  const proposed = {...review.would_publish, operations: operations.length ? [stage, ...operations, ...tasks] : [...review.would_publish.operations]};
  if (role(input, input.selected.kind) === 'ac' && ['OK', 'SPLIT'].includes(draft.verdict)) {
    const updated = new Map(operations.map(({command}) => [command.kind + ':' + command.id, command.data]));
    const hash = contractHash({...input, children: (input.children ?? []).map(node => updated.has(node.address)
      ? {...node, document: {...node.document, data: {...node.document.data, ...updated.get(node.address)}}} : node)});
    proposed.operations = proposed.operations.map(row => row.command.op === 'save_object' && row.command.revision === 0 &&
      row.command.parent === input.selected.address && role(input, row.command.kind) === 'task'
      ? {...row, command: {...row.command, data: {...row.command.data, ac_contract_hash: hash}}} : row);
  }
  return {...review, would_publish: proposed, publication: dry ? review.publication : proposed};
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const dir = process.argv[2], read = name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    const review = JSON.parse(fs.readFileSync(0, 'utf8'));
    console.log(JSON.stringify(bindingPublication({input: read('input.json'), draft: read('draft.json'), trees: read('trees.json'),
      review, dry: process.env.DRY_RUN === 'true'})));
  } catch (error) { console.error('tasker-bindings: ' + error.message); process.exitCode = 2; }
}
