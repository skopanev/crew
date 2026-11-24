#!/usr/bin/env node
// Machine checks of one tasker draft. Usage: check.mjs ARTIFACTS_DIR. Exit 0: no problem, 1: problems, 2: error.
// Reads input.json (the claimed assignment), trees.json (develop worktrees of this run) and draft.json.
// Writes check.json: {ok, problems, tasks}. The critics get check.json and confirm each fact in the source.
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {checkRepair} from './repair-plan.mjs';
import {bodyProblems} from './repair-context.mjs';
import {restrictionLine, reporterNames} from './reporter-names.mjs';
import {bindingPlan} from './test-bindings.mjs';
import {passingTests} from './completion.mjs';

// Same exemption as crew/workflow/scripts/plan-gate.mjs: migration SQL and metadata do not count for size.
const MIGRATION_SIZE_EXEMPT = /^packages\/db\/migrations\/(?:[^/]+\.sql|meta\/.+)$/;
const relative = value => typeof value === 'string' && value.length > 0 && !/[\\\r\n\0]/.test(value) &&
  !path.isAbsolute(value) && !value.split('/').some(part => ['', '.', '..', '.git'].includes(part));
const text = value => typeof value === 'string' && value.trim().length > 0;

export function inTree(tree, file) {
  try {
    execFileSync('git', ['-C', tree, 'cat-file', '-e', `HEAD:${file}`], {stdio: 'ignore'});
    return true;
  } catch {
    return false;
  }
}

function commitInTree(tree, sha) {
  try {
    execFileSync('git', ['-C', tree, 'merge-base', '--is-ancestor', `${sha}^{commit}`, 'HEAD'], {stdio: 'ignore'});
    return true;
  } catch {
    return false;
  }
}

// forecast(repository, tree, paths, size) gives the gate forecast or null. The workflow passes forecastPlanGate.
export function check({input, trees, draft, maxFiles, maxLines, forecast}) {
  const problems = [], facts = [];
  const selected = input.selected;
  const tests = (input.children ?? []).filter(item => item.kind === 'test');
  const testAddresses = new Set(tests.map(item => item.address));
  const bodyLimit = input.schema?.types?.task?.field_max_length ?? Infinity;
  const verdict = draft?.verdict === 'SPLIT' ? 'OK' : draft?.verdict;
  if (!['OK', 'DONE', 'GAP', 'CONFLICT'].includes(verdict)) return {ok: false, problems: ['verdict must be OK, SPLIT, DONE, GAP or CONFLICT'], tasks: []};
  if (!input.repair) problems.push(...bindingPlan({input, trees, draft}).problems);
  if (!text(draft.reason)) problems.push('reason is required');
  if (verdict === 'DONE') {
    if (!passingTests(input, input.children ?? [])) {
      problems.push('DONE requires a current recorded PASS for every present AC Test. Plan a verify-only Task for missing evidence.');
    }
    const sha = draft.done_commit;
    if (typeof sha !== 'string' || !/^[0-9a-f]{7,40}$/.test(sha) ||
        !Object.values(trees).some(tree => commitInTree(tree.path, sha))) {
      problems.push('DONE needs done_commit: a develop commit that is in the develop tree of this run');
    }
    return {ok: problems.length === 0, problems, tasks: []};
  }
  if (verdict === 'GAP' || verdict === 'CONFLICT') {
    const gap = draft.gap;
    const validGap = gap && typeof gap === 'object' && ['cto', 'ceo'].includes(gap.owner) && ['question', 'a', 'b'].every(key => text(gap[key])) &&
      ['A', 'B'].includes(gap.recommended);
    if (!validGap) problems.push('GAP or CONFLICT needs an owner, question, A/B options and recommendation');
    return {ok: problems.length === 0, problems, tasks: []};
  }
  const tasks = Array.isArray(draft.tasks) ? draft.tasks : [];
  if (tasks.length < 1 || tasks.length > 5) problems.push('OK needs 1 to 5 tasks');
  const plannedIds = new Set(tasks.map(task => task?.id));
  const dependencies = new Map(tasks.map(task => [task?.id,
    new Set(Array.isArray(task?.depends_on) ? task.depends_on : [])]));
  for (let pass = 0; pass < tasks.length; pass++) {
    for (const required of dependencies.values()) {
      for (const dependency of [...required]) {
        for (const ancestor of dependencies.get(dependency) ?? []) required.add(ancestor);
      }
    }
  }
  for (const task of tasks) {
    if (dependencies.get(task?.id)?.has(task?.id)) problems.push(`task ${task?.id}: depends_on has a cycle`);
  }
  const ids = new Set(), owners = new Map(), repositories = new Set();
  for (const task of tasks) {
    const label = `task ${task?.id}`;
    if (typeof task?.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(task.id) || ids.has(task.id)) {
      problems.push(`${label}: id must be unique letters, digits, hyphens or underscores`);
      continue;
    }
    ids.add(task.id);
    if (!text(task.title) || /[\r\n]/.test(task.title)) problems.push(`${label}: title must be one nonempty line`);
    const tree = trees[task.repository];
    if (!tree) {
      problems.push(`${label}: repository must be one of ${Object.keys(trees).join(', ')}`);
      continue;
    }
    repositories.add(task.repository);
    const body = typeof task.body === 'string' ? task.body : '';
    if (!text(body)) problems.push(`${label}: body must be nonempty`);
    else if (body.length > bodyLimit) problems.push(`${label}: body has ${body.length} characters, limit ${bodyLimit}. Remove at least ${body.length - bodyLimit} characters. Shorten repeated facts and Test text; keep the required behavior and checks.`);
    const restricted = restrictionLine(body);
    if (restricted) problems.push(`${label}: the Task body has a restriction line: "${restricted.trim()}"`);
    const bodyLines = body.split(/\r?\n/);
    for (let index = 0; index < bodyLines.length; index++) {
      if (/^\s*(?:[-*]\s*)?(?:reporter(?: name)?|expected|command)\s*:/i.test(bodyLines[index])) {
        problems.push(`${label}: keep Reporter names, Expected and command in Test nodes or test_bindings, not body`);
      }
      const testsLine = /^Tests(?:[ \t]*\([^)\r\n]*\))?:(.*)$/.exec(bodyLines[index]);
      if (!testsLine) continue;
      const values = [testsLine[1]];
      for (let next = index + 1; next < bodyLines.length && /^[ \t]*[-*][ \t]+/.test(bodyLines[next]); next++) {
        values.push(bodyLines[next].replace(/^[ \t]*[-*][ \t]+/, ''));
      }
      const named = values.flatMap(value => value.split(/[\s,]+/)).filter(Boolean);
      const none = named.length === 1 && named[0] === 'none' && Array.isArray(task.tests) && task.tests.length === 0;
      if (!none && named.some(value => !/^test:[A-Za-z0-9_-]+$/.test(value))) {
        problems.push(`${label}: Tests in body must contain only Test IDs`);
      }
    }
    if (!body.startsWith(`Criterion: ${selected.address}@`)) problems.push(`${label}: body must start with "Criterion: ${selected.address}@<revision>"`);
    const repositoryLines = body.split(/\r?\n/).filter(line => line.startsWith('Repository:'));
    if (repositoryLines.length !== 1 || repositoryLines[0] !== `Repository: ${task.repository}`) {
      problems.push(`${label}: body needs exactly one line "Repository: ${task.repository}" with no punctuation or extra text`);
    }
    const files = Array.isArray(task.files) ? task.files : [];
    if (!files.length) problems.push(`${label}: files must list each touched file`);
    for (const file of files) {
      if (!relative(file?.path) || !['edit', 'new', 'delete'].includes(file.change) || !Number.isSafeInteger(file.lines) || file.lines < 1) {
        problems.push(`${label}: each file needs a relative path, change edit, new or delete, and positive integer lines`);
        continue;
      }
      let exists = inTree(tree.path, file.path);
      const preceding = tasks.filter(other => other?.repository === task.repository && dependencies.get(task.id)?.has(other.id))
        .flatMap(other => (Array.isArray(other.files) ? other.files : []).filter(item => item?.path === file.path)
          .map(item => ({id: other.id, change: item.change})));
      for (const writer of preceding) {
        if (!preceding.some(next => dependencies.get(next.id)?.has(writer.id))) exists = writer.change !== 'delete';
      }
      if (file.change === 'new' && exists) problems.push(`${label}: ${file.path} is marked new, but develop ${tree.sha} has it`);
      if (file.change !== 'new' && !exists) problems.push(`${label}: ${file.path} is not in develop ${tree.sha}`);
      if (!body.includes(file.path)) problems.push(`${label}: the body does not name ${file.path}`);
      const key = `${task.repository}:${file.path}`;
      for (const owner of owners.get(key) ?? []) {
        if (owner === task.id || !dependencies.get(task.id)?.has(owner) && !dependencies.get(owner)?.has(task.id)) {
          problems.push(`${label}: ${file.path} is also in task ${owner}; overlapping Tasks need an explicit depends_on order`);
        }
      }
      owners.set(key, [...(owners.get(key) ?? []), task.id]);
    }
    const counted = files.filter(file => relative(file?.path) && !MIGRATION_SIZE_EXEMPT.test(file.path));
    const lines = counted.reduce((sum, file) => sum + (Number.isSafeInteger(file.lines) ? file.lines : 0), 0);
    if (counted.length > maxFiles || lines > maxLines) {
      problems.push(`${label}: ${counted.length} files and ${lines} lines exceed the limit of ${maxFiles} files and ${maxLines} lines`);
    }
    for (const address of Array.isArray(task.tests) ? task.tests : []) {
      if (!testAddresses.has(address)) problems.push(`${label}: ${address} is not a Test of ${selected.address}`);
    }
    if (!Array.isArray(task.depends_on ?? []) || (task.depends_on ?? []).some(value => typeof value !== 'string' ||
        !/^task:[A-Za-z0-9_-]+$/.test(value) && !plannedIds.has(value))) {
      problems.push(`${label}: depends_on must list existing Task addresses (task:<id>) or known draft Task ids`);
    }
    const gate = forecast(task.repository, tree.path, files.filter(file => relative(file?.path)).map(file => file.path), {files: counted.length, lines});
    if (gate?.split) problems.push(`${label}: ${gate.splitReason ?? 'the planned gate runs the full suite or more than 200 Test files'} (forecastPlanGate split true): ${gate.detail}`);
    facts.push({id: task.id, repository: task.repository, base: tree.sha, files: counted.length, lines, gate});
  }
  // Check the Tests that planned Tasks own. The critics verify existing coverage for the other AC Tests.
  const plannedTests = new Set(tasks.flatMap(task => Array.isArray(task.tests) ? task.tests : []));
  for (const test of tests.filter(test => plannedTests.has(test.address))) {
    for (const {repo: repository, name} of reporterNames(test.document?.data?.body)) {
      if (!repositories.has(repository)) continue;
      const file = name.split(' > ')[0];
      if (owners.has(`${repository}:${file}`) || !inTree(trees[repository].path, file)) continue;
      problems.push(`${test.address}: Reporter name file ${file} is in develop, but no Task touches it`);
    }
  }
  return {ok: problems.length === 0, problems, tasks: facts};
}

async function main() {
  const dir = process.argv[2];
  const read = name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  // gate/scripts/backend-test-local.sh runs the Dolber query in the Dolber lane image: the host has no box runtime.
  const env = {...process.env, MEDULLA_WORKFLOW_DIR: path.join(path.dirname(fileURLToPath(import.meta.url)), 'gate'),
    DOLBER_CONFIG: process.env.DOLBER_CONFIG || path.join(process.env.CREW_WORKFLOW_DIR, '..', 'dolber.json')};
  const forecastRepositories = JSON.parse(process.env.TASKER_GATE_REPOSITORIES || '[]');
  if (!Array.isArray(forecastRepositories) || forecastRepositories.some(item => typeof item !== 'string')) throw new Error('TASKER_GATE_REPOSITORIES must be a string array');
  const forecastPlanGate = forecastRepositories.length ? (await import(pathToFileURL(path.join(process.env.CREW_WORKFLOW_DIR, 'scripts/plan-gate.mjs')).href)).forecastPlanGate : null;
  const warned = new Set();
  const forecast = (repository, tree, paths, size) => {
    if (forecastRepositories.includes(repository)) return forecastPlanGate({...env, LANE_WORKTREE: tree}, paths, size);
    if (!warned.has(repository)) console.error(`tasker-check: no gate forecast configured for ${repository}; configure TASKER_GATE_REPOSITORIES and its adapter`);
    warned.add(repository);
    return null;
  };
  const input = read('input.json'), draft = read('draft.json');
  const options = {input, trees: read('trees.json'), draft,
    maxFiles: Number(process.env.PLAN_MAX_FILES), maxLines: Number(process.env.PLAN_MAX_LINES), forecast};
  const repair = input.schema.types[input.selected.kind]?.role === 'task';
  const result = repair ? checkRepair({...options, repair: read('repair.json'), checkPlan: check}) : check(options);
  if (result.ok && (draft.verdict === 'OK' || draft.verdict === 'READY')) {
    const checker = fileURLToPath(new URL('./reporter-names.mjs', import.meta.url));
    result.problems.push(...(repair ? [draft.task] : draft.tasks).flatMap(task => bodyProblems(task.body, checker)));
    result.ok = result.problems.length === 0;
  }
  const temp = path.join(dir, `check.json.${process.pid}.tmp`);
  fs.writeFileSync(temp, JSON.stringify(result, null, 2) + '\n');
  fs.renameSync(temp, path.join(dir, 'check.json'));
  for (const problem of result.problems) console.error(`tasker-check: ${problem}`);
  process.exitCode = result.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => { console.error(`tasker-check: ${error.message}`); process.exitCode = 2; });
}
