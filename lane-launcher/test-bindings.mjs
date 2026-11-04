// Host checks of the lane test bindings: one verified test name for each Task acceptance check.
// Each failure is an evidence gap with a code. Nothing here makes a criterion green.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {testAcceptance} from './joppa-input.mjs';
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const fail = (code, message) => { throw Object.assign(new Error(`${code}: ${message}`), {code}); };
const text = value => typeof value === 'string' && value.trim();
const key = (...parts) => JSON.stringify(parts);
export const MAX_BATCH = 100;
// A failure writes release, assess and note per Task. A completion writes save and archive per Task and one save per node.
export const FAILURE_OPERATIONS = 3, COMPLETION_OPERATIONS = 2;
export const RECORD = 'test-bindings-receipt.json', BINDINGS = 'test-bindings.json';

// Refuse a package whose failure or completion batch cannot fit. Before test names exist, count one node per
// distinct (AC, check) of data.acceptance. This is the minimum the lane needs when no node exists yet.
export function packageBudget(tasks, nodes) {
  const failure = tasks * FAILURE_OPERATIONS, completion = tasks * COMPLETION_OPERATIONS + nodes;
  if (Math.max(failure, completion) > MAX_BATCH) {
    fail('PACKAGE_BUDGET', `${tasks} Tasks and ${nodes} test node saves need max(${failure}, ${completion}) operations; ` +
      `one Joppa batch holds ${MAX_BATCH}; no write was sent`);
  }
  return MAX_BATCH - tasks * COMPLETION_OPERATIONS;
}

export const estimatedNodes = objects => new Set(objects.flatMap(object =>
  (testAcceptance(object) || []).map(row => key(row.ac, row.check)))).size;

// Required evidence must be possible before a coder runs: a review command must write $CREW_TEST_REPORT_DIR.
export function reportProblem(repository, reviewCommands) {
  if (!repository?.testReport) return null;
  return (reviewCommands || []).some(command => String(command).includes('CREW_TEST_REPORT_DIR')) ? null :
    `repository ${repository.id} has testReport, but no review command writes $CREW_TEST_REPORT_DIR`;
}

export function requiredRows(objects) {
  return objects.flatMap(object => (testAcceptance(object) || [])
    .map(row => ({task: object.address, ac: row.ac, check: row.check})));
}

// Parse the coder file: [{task, ac, check, test}]. Remove identical rows.
export function parseBindings(value) {
  if (!Array.isArray(value) || !value.length) fail('BINDING_INVALID', 'test-bindings.json needs a nonempty list');
  const rows = [], seen = new Set();
  for (const row of value) {
    if (!row || typeof row !== 'object' || Object.keys(row).sort().join() !== 'ac,check,task,test' ||
        !['task', 'ac', 'check', 'test'].every(name => text(row[name]))) {
      fail('BINDING_INVALID', 'each binding needs exactly task, ac, check and test');
    }
    const id = key(row.task, row.ac, row.check, row.test);
    if (!seen.has(id)) rows.push({task: row.task, ac: row.ac, check: row.check, test: row.test});
    seen.add(id);
  }
  return rows;
}

// Each (task, AC, check) needs at least one test. The bound pairs equal the package data.acceptance union.
export function checkBindings(rows, required, report) {
  const expected = new Set(required.map(row => key(row.task, row.ac, row.check)));
  const actual = new Set(rows.map(row => key(row.task, row.ac, row.check)));
  const missing = [...expected].filter(item => !actual.has(item)), extra = [...actual].filter(item => !expected.has(item));
  if (missing.length || extra.length) {
    fail('BINDING_INVALID', `bindings differ from data.acceptance: missing ${missing.join(', ') || 'none'}; ` +
      `extra ${extra.join(', ') || 'none'}`);
  }
  if (!report || report.error || !Array.isArray(report.results)) {
    fail('BINDING_NO_REPORT', `the reviewed gate receipt has no usable test report${report?.error ? `: ${report.error}` : ''}`);
  }
  const outcomes = new Map(report.results.map(item => [item.test, item.outcome]));
  for (const row of rows) {
    if (!outcomes.has(row.test)) fail('BINDING_NOT_IN_REPORT', `${row.test} is not in the reviewed test report`);
    if (outcomes.get(row.test) !== 'pass') fail('BINDING_NOT_PASSED', `${row.test} has outcome ${outcomes.get(row.test)}`);
  }
}

// Recompute the frozen lane evidence. Return {status, rows, gaps}. A required mismatch refuses completion.
export function frozenBindings(run, artifacts, objects) {
  const gaps = objects.filter(object => !testAcceptance(object))
    .map(object => `BINDING_MISSING: ${object.address} has no data.acceptance; no test can be bound`);
  const required = requiredRows(objects);
  if (!required.length) return {status: 'legacy', rows: [], gaps};
  if (!run.repository?.testReport) {
    return {status: 'no_report', rows: [], gaps: [...gaps,
      `BINDING_NO_REPORT: repository ${run.repository?.id} has no testReport; no test acceptance is recorded`]};
  }
  const recordFile = path.join(artifacts || '', RECORD);
  if (!artifacts || !fs.existsSync(recordFile)) fail('BINDING_MISSING', `${RECORD} is missing; the lane bound no tests`);
  const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  // The lane wrote container paths. Resolve the same receipt folder on the host.
  const receiptFile = path.join(artifacts, 'gates', path.basename(path.dirname(String(record.receipt))), 'receipt.json');
  if (!fs.existsSync(receiptFile) || sha256(receiptFile) !== record.receipt_sha256) {
    fail('BINDING_FROZEN_MISMATCH', 'the reviewed gate receipt changed after binding');
  }
  const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  if (receipt.passed !== true || receipt.tree !== record.tree || receipt.candidate_sha !== record.candidate_sha) {
    fail('BINDING_FROZEN_MISMATCH', 'bindings do not name the passing reviewed tree');
  }
  if (record.status === 'verify_only') {
    return {status: 'verify_only', rows: [], gaps: [...gaps, 'BINDING_MISSING: verification run had no coder bindings']};
  }
  if (record.status !== 'bound') fail('BINDING_FROZEN_MISMATCH', `binding record status is ${record.status}`);
  const file = path.join(artifacts, BINDINGS);
  if (!fs.existsSync(file)) fail('BINDING_MISSING', `${BINDINGS} is missing`);
  if (sha256(file) !== record.bindings_sha256) fail('BINDING_FROZEN_MISMATCH', `${BINDINGS} changed after review`);
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { fail('BINDING_INVALID', error.message); }
  const rows = parseBindings(parsed);
  const ids = list => JSON.stringify((Array.isArray(list) ? list : []).map(row => key(row?.task, row?.ac, row?.check, row?.test)));
  if (ids(rows) !== ids(record.rows)) fail('BINDING_FROZEN_MISMATCH', 'binding rows differ from the record');
  checkBindings(rows, required, receipt.test_report);
  return {status: 'bound', rows, gaps};
}
