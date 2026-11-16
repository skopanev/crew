// Read native pending branches and confirmed Lander outcomes. This command writes nothing.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {api} from '../lane-launcher/joppa-common.mjs';
import {nodePages} from '../lane-launcher/joppa-nodes.mjs';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const key = (repo, delivery) => JSON.stringify([repo, delivery.branch, delivery.head]);
export async function report(config, now = Date.now()) {
  const branches = new Map(), repositories = new Set(config.repositories.map(repo => repo.id));
  const service = {joppa: {url: config.url, mcpCommand: config.mcp_command}};
  const call = (tool, args) => api(service, {tokenFile: config.token_file}, tool, {workspace: config.workspace, ...args});
  // Pending inventory includes branches that a Lander already claimed.
  const {assignee, ...selection} = config.selection;
  for await (const page of nodePages(call, {...selection, fields: ['data.repository', 'data.delivery']})) {
    for (const row of page.items) {
      const repo = row['data.repository'], delivery = row['data.delivery'];
      if (repositories.has(repo) && delivery?.state === 'pending') branches.set(key(repo, delivery), delivery);
    }
  }
  const since = now - 3600_000, runs = [], durations = [];
  const root = config.runs_folder;
  for (const entry of fs.existsSync(root) ? fs.readdirSync(root, {withFileTypes: true}) : []) {
    if (!entry.isDirectory()) continue;
    const artifacts = path.join(root, entry.name, 'artifacts'), resultFile = path.join(artifacts, 'result.json');
    if (!fs.existsSync(resultFile)) continue;
    const at = fs.statSync(resultFile).mtimeMs;
    if (at < since || at > now) continue;
    const result = read(resultFile), inputFile = path.join(artifacts, 'input.json');
    const stateFile = path.join(artifacts, 'lander.json');
    const state = fs.existsSync(stateFile) ? read(stateFile) : null;
    const input = fs.existsSync(inputFile) ? read(inputFile) : null;
    const items = input?.items || (input?.selected ? [input.selected] : []);
    const selected = new Set(items.map(item => key(item.document.data.repository, item.document.data.delivery)));
    runs.push({run: entry.name, batch_size: selected.size, code: result.reason_code || 'UNKNOWN',
      publication_confirmed: result.claim_released === true && !result.needs_recovery});
    if (!state?.landed_at) continue;
    const landed = new Set((state.accepted || []).map(item => item.address)), measured = new Set();
    for (const item of items) {
      const data = item.document.data, identity = key(data.repository, data.delivery);
      const pushed = Date.parse(data.delivery.pushed_at), finished = Date.parse(state.landed_at);
      if (!landed.has(item.address) || measured.has(identity) || !Number.isFinite(pushed) || !Number.isFinite(finished)) continue;
      measured.add(identity);
      durations.push({branch: data.delivery.branch, seconds: Math.round((finished - pushed) / 1000)});
    }
  }
  const counts = Object.fromEntries([...new Set(['LANDED', 'PARTIAL_LANDING', 'BASELINE_RED', ...runs.map(run => run.code)])].map(code =>
    [code, runs.filter(run => run.code === code).length]));
  return {at: new Date(now).toISOString(), window_seconds: 3600, pending_branches: branches.size,
    pending_without_timestamp: [...branches.values()].filter(item => !Number.isFinite(Date.parse(item.pushed_at))).length,
    outcomes: counts, runs, push_to_landing: durations};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await report(read(process.argv[2])), null, 2)); }
  catch (error) { console.error('Lander report: ' + error.message); process.exitCode = 1; }
}
