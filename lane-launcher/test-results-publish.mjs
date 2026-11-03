// Record the per-test results of the gate run that checked a landed final target SHA.
// Opt-in per repository with testReport. A failure here never changes the landed lane result.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {save} from './runtime.mjs';
import {api} from './joppa-common.mjs';
import {repositoryGit} from './publication-guard.mjs';
import {parsePublication} from './requirement-delivery.mjs';
import {resultRules, buildRequests} from './test-results.mjs';
const require = (condition, message) => { if (!condition) throw new Error(message); };
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

// Read the receipt that current.json names and check every binding to its report.
export function boundReport(artifacts, repository) {
  const gates = path.join(artifacts, 'gates');
  const pointer = JSON.parse(fs.readFileSync(path.join(gates, 'current.json'), 'utf8'));
  // The lane wrote container paths. Resolve the same receipt folder on the host.
  const folder = path.join(gates, path.basename(path.dirname(String(pointer.receipt))));
  const file = path.join(folder, 'receipt.json');
  require(sha256(file) === pointer.sha256, 'Gate receipt does not match current.json');
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
  require(receipt.passed === true, 'Gate receipt did not pass');
  require(same(receipt.commands, repository.gateCommands), 'Gate receipt is not the full gateCommands run');
  const report = receipt.test_report;
  require(report, 'Gate receipt has no test report');
  require(!report.error, `Test report refused: ${report.error}`);
  const {path: reportPath, format, identity} = repository.testReport;
  require(same([report.path, report.format, report.identity], [reportPath, format, identity]),
    'Gate receipt used another testReport config');
  require(sha256(path.join(folder, 'test-report', report.path)) === report.sha256,
    'Test report changed after the gate run');
  require(Array.isArray(report.results) && report.results.length > 0, 'Test report has no results');
  return {file, receipt, report};
}

// Return the reason when this run must not publish, or null for a final target landing.
function ineligible(run, result, artifacts) {
  if (result.completed !== true) return 'the lane result is not completed';
  const landing = path.join(artifacts || '', 'landing.txt');
  if (!artifacts || !fs.existsSync(landing)) return 'no landing evidence (verification or no push)';
  const final = run.config.delivery === 'target' ||
    run.config.delivery === 'requirement' && run.requirementDelivery?.final === true;
  if (!final) return 'delivery is not the final target';
  const {sha, target} = parsePublication(fs.readFileSync(landing, 'utf8'));
  if (target !== run.repository.targetBranch) return `landing target ${target} is not ${run.repository.targetBranch}`;
  return {sha};
}

export function testResultsInspection(run) {
  const open = run.testResults?.requests?.filter(entry => ['sending', 'uncertain'].includes(entry.state)) || [];
  return open.length ? `TEST_RESULTS_UNCERTAIN: ${open.length} joppa_record_results request(s) for ${run.testResults.commit} ` +
    'have an unknown outcome. Crew does not resend them. Inspect test nodes with joppa_objects before any manual retry.' : null;
}

async function send(run, persist, call, announce) {
  const state = run.testResults;
  for (const entry of state.requests) {
    if (entry.state !== 'pending') continue;
    entry.state = 'sending';
    // No call without a durable intent: an unsaved 'sending' state was never sent.
    try { persist(); } catch (error) { entry.state = 'pending'; throw error; }
    try {
      await call('joppa_record_results', entry.request);
      entry.state = 'recorded';
    } catch (error) {
      entry.state = error.rejected ? 'refused' : 'uncertain';
      entry.error = error.message;
      state.status = entry.state;
      persist();
      announce(`[lane] ${entry.state === 'refused' ? `TEST_RESULTS_REFUSED: ${error.message}` : testResultsInspection(run)}`);
      return;
    }
    persist();
  }
  state.status = 'recorded';
  persist();
  announce(`[lane] TEST_RESULTS recorded ${state.requests.reduce((sum, entry) => sum + entry.request.results.length, 0)} results for ${state.commit}`);
}

// Contained: no error, including a state-write failure, leaves this function.
export async function publishLandedResults(context, deps = {}) {
  try { await publish(context, deps); }
  catch (error) {
    try { context.announce(`[lane] TEST_RESULTS_NOT_RECORDED: ${error.message}`); } catch {}
  }
}

async function publish({run, stateFile, result, artifacts, announce}, deps) {
  if (!run.repository?.testReport || run.testResults) return;
  const call = deps.call || ((tool, args) => api(run.config, run.joppaWorker, tool, args));
  const git = deps.git || (args => repositoryGit(run.config, run.repository, args));
  const persist = () => (deps.save || save)(stateFile, run);
  try {
    const eligible = ineligible(run, result, artifacts);
    if (typeof eligible === 'string') {
      run.testResults = {status: 'skipped', diagnostic: eligible};
      announce(`[lane] TEST_RESULTS skipped: ${eligible}`);
      persist();
      return;
    }
    const {sha} = eligible;
    const {file, receipt, report} = boundReport(artifacts, run.repository);
    const target = run.repository.targetBranch;
    const head = (await git(['ls-remote', 'origin', `refs/heads/${target}`])).split(/\s/)[0];
    require(head, `Target ${target} is absent`);
    await git(['fetch', '--no-write-fetch-head', 'origin', head]);
    await git(['merge-base', '--is-ancestor', sha, head]).catch(() => {
      throw new Error(`Landed SHA ${sha} is not on ${target}`);
    });
    const tree = await git(['rev-parse', `${sha}^{tree}`]);
    require(tree === receipt.tree, `TEST_RESULTS_TREE_MISMATCH: ${sha} has tree ${tree}; the gate checked ${receipt.tree}`);
    const rules = resultRules(await call('joppa_tree', {workspace: run.workspace}));
    const requests = buildRequests({workspace: run.workspace, commit: sha, cases: report.results, rules});
    // Persist the exact intended requests before the first call. A failed write stops here.
    run.testResults = {status: 'pending', commit: sha, tree, receipt: file, reportSha256: report.sha256,
      requests: requests.map(request => ({state: 'pending', request}))};
    persist();
    await send(run, persist, call, announce);
  } catch (error) {
    const state = run.testResults ||= {status: 'not_recorded'};
    state.diagnostic = error.message;
    // A call whose state write failed has an unknown outcome. Unsent intent records nothing.
    if (state.requests?.some(entry => ['sending', 'uncertain'].includes(entry.state))) state.status = 'uncertain';
    else if (state.requests?.some(entry => entry.state === 'recorded')) state.status = 'partial';
    else if (state.status === 'pending') state.status = 'not_recorded';
    announce(`[lane] TEST_RESULTS_NOT_RECORDED: ${error.message}`);
    try { persist(); } catch (writeError) { announce(`[lane] TEST_RESULTS state not saved: ${writeError.message}`); }
  } finally {
    if (run.testResults) {
      result.testResults = {status: run.testResults.status,
        ...(run.testResults.diagnostic ? {diagnostic: run.testResults.diagnostic} : {})};
    }
  }
}
