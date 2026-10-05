// Internal planning adapter. Agents do not receive NTK write tools.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {request, attachReport} from '../lane-launcher/ntk.mjs';

const route = id => `/v1/tickets/${encodeURIComponent(id)}`;
const require = (ok, message) => { if (!ok) throw new Error(message); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function save(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  fs.writeFileSync(file + '.tmp', JSON.stringify(value) + '\n', {mode: 0o600});
  fs.renameSync(file + '.tmp', file);
}
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));

async function ticket(id, workspace) {
  const value = await request('GET', route(id), {workspace});
  require(value?.ticket?.id && Number.isSafeInteger(value.revision_count), 'NTK returned no ticket revision');
  return value;
}

async function attachments(id, workspace) {
  const response = await request('GET', `${route(id)}/attachments`, {workspace});
  const result = [];
  for (const item of response.attachments || []) {
    if (item.filename.startsWith('planning-ntk-')) continue;
    const {url, ...metadata} = item;
    if (item.size_bytes > 2_000_000 || !/text|json|markdown|\.txt$|\.md$|\.json$/.test(`${item.content_type} ${item.filename}`)) {
      result.push({...metadata, content: null});
      continue;
    }
    const address = new URL(url);
    require(address.protocol === 'https:' || (address.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(address.hostname)), 'Attachment requires HTTPS');
    const downloaded = await fetch(address, {redirect: 'error', signal: AbortSignal.timeout(30_000)});
    require(downloaded.ok, 'Cannot read NTK attachment');
    result.push({...metadata, content: await downloaded.text()});
  }
  return result;
}

async function snapshot({id, workspace}) {
  const [source, meta, deps, reports] = await Promise.all([
    ticket(id, workspace), request('GET', '/v1/meta', {workspace}),
    request('GET', `${route(id)}/deps`, {workspace}), attachments(id, workspace),
  ]);
  const prerequisites = await Promise.all((deps.up || []).map(item => ticket(item.id, workspace)));
  const parents = await Promise.all((deps.down || []).filter(item => !item.removed &&
    item.title.startsWith('[CLOSE AT NO DEPS] ')).map(async item => ({
      source: await ticket(item.id, workspace), attachments: await attachments(item.id, workspace),
  })));
  return {source, meta, deps, attachments: reports, prerequisites, parents};
}

async function unchanged(input) {
  const {source, prerequisites, deps} = input.snapshot;
  for (const item of prerequisites) {
    const now = await ticket(item.ticket.id, input.workspace);
    require(now.revision_count === item.revision_count, `Prerequisite changed: ${item.ticket.id}`);
  }
  for (const parent of input.snapshot.parents || []) {
    const now = await ticket(parent.source.ticket.id, input.workspace);
    require(now.revision_count === parent.source.revision_count, 'Coordinator context changed during planning');
  }
  const graph = await request('GET', `${route(source.ticket.id)}/deps`, {workspace: input.workspace});
  require(hash(graph) === hash(deps), 'Dependency graph changed during planning');
  const current = await ticket(source.ticket.id, input.workspace);
  require(['open', 'blocked'].includes(current.ticket.status), 'Source ticket is active, complete, or awaiting review; unchanged');
  require(current.revision_count === source.revision_count, 'Source ticket changed during planning; unchanged');
  return current.ticket;
}

function sameFields(actual, wanted) {
  return Object.entries(wanted).every(([key, value]) => key === 'deps' || key === 'tags'
    ? hash([...(actual[key] || [])].sort()) === hash([...value].sort()) : actual[key] === value);
}

async function activate(input, receipt, file, source) {
  const {workspace, plan} = input;
  const decomposing = plan.disposition === 'decompose';
  const states = decomposing ? ['blocked'] : ['open', 'in_progress', 'to_test', 'done'];
  const parent = await ticket(source.id, workspace);
  require(parent.revision_count === receipt.parentRevision && sameFields(parent.ticket, receipt.parent),
    'Coordinator changed during publication; leave children unchanged');
  for (const task of plan.tasks) {
    const child = receipt.children[task.id];
    const current = await ticket(child.id, workspace);
    const {tags: originalTags, ...content} = child.fields;
    require(sameFields(current.ticket, content), 'Child content changed during publication; unchanged');
    const readyTags = [...new Set([...child.fields.tags, ...input.dispatchTags,
      ...(decomposing ? source.tags || [] : [])])];
    if (current.ticket.status === 'blocked' && sameFields(current.ticket, {tags: originalTags})) {
      require(current.revision_count === child.revision && sameFields(current.ticket, {tags: originalTags}), 'Blocked child changed; unchanged');
      await request('PATCH', route(child.id), {}, {workspace, status: decomposing ? 'blocked' : 'open',
        tag_edits: readyTags.map(tag => `+${tag}`)});
    } else {
      require(states.includes(current.ticket.status) &&
        readyTags.every(tag => current.ticket.tags.includes(tag)), 'Child state differs from publication; unchanged');
    }
    const confirmed = await ticket(child.id, workspace);
    require(sameFields(confirmed.ticket, {...child.fields, tags: readyTags}) &&
      states.includes(confirmed.ticket.status), 'Child publication was not confirmed');
    save(file, receipt);
  }
  receipt.complete = true;
  save(file, receipt);
  return {verdict: decomposing ? 'DECOMPOSED' : 'READY', id: source.id,
    children: plan.tasks.map(t => receipt.children[t.id].id), parentStatus: 'to_review'};
}

async function publish(input) {
  const {workspace, plan, stateDir, dispatchTag} = input;
  const receiptFile = path.join(stateDir, 'publication.json');
  let receipt = fs.existsSync(receiptFile) ? read(receiptFile) : {plan: hash(plan), children: {}};
  require(receipt.plan === hash(plan), 'A different plan already has publication receipts; inspect them before another plan');
  const original = input.snapshot.source.ticket;
  if (receipt.parentRevision) return activate(input, receipt, receiptFile, original);
  const source = await unchanged(input);
  const title = source.title.replace(/^\[HUMAN\] /, '');
  const report = JSON.stringify({source: source.id, plan, reviews: input.reviews}, null, 2);
  const update = (id, fields) => request('PATCH', route(id), {}, {workspace, ...fields});
  const tags = [...new Set([...(source.tags || []), ...input.dispatchTags])];
  const tasks = plan.tasks;
  const decomposing = plan.disposition === 'decompose';
  const stagedTags = decomposing ? [] : tags.filter(tag => tag !== dispatchTag);
  const split = decomposing || (plan.disposition === 'implement' && (tasks.length > 1 || tasks[0].project !== source.project));
  require(!split || `[CLOSE AT NO DEPS] ${title}`.length <= input.snapshot.meta.limits.title,
    'Coordinator title exceeds the NTK limit; tighten it before planning');

  if (plan.ntk.verdict !== 'READY') {
    const human = plan.ntk.verdict === 'NEEDS_HUMAN';
    const blockedTitle = human ? `[HUMAN] ${title}` : title;
    require(blockedTitle.length <= input.snapshot.meta.limits.title,
      'Human decision title exceeds the NTK limit; shorten it before planning');
    await attachReport(source.id, workspace, `planning-ntk-${hash(plan).slice(0, 16)}.json`, report);
    await unchanged(input);
    await update(source.id, {status: 'blocked', title: blockedTitle,
      ...(human ? {assignee: plan.ntk.owner} : {}),
      tag_edits: [`-${dispatchTag}`]});
    return {verdict: plan.ntk.verdict, id: source.id, reason: plan.blockers.join('\n'), owner: plan.ntk.owner, decision: plan.ntk.decision};
  }

  if (!split) {
    const task = tasks[0];
    await attachReport(source.id, workspace, `planning-ntk-${hash(plan).slice(0, 16)}.json`, report);
    await unchanged(input);
    const body = task?.body || plan.ntk.body, module = task?.module || source.module;
    const deps = [...new Set([...(source.deps || []), ...(task?.external_dependencies || [])])];
    await update(source.id, {status: 'open', title, body,
      module, dep_set: deps,
      tag_edits: input.dispatchTags.map(tag => `+${tag}`)});
    const confirmed = await ticket(source.id, workspace);
    require(['open', 'in_progress', 'to_test', 'done'].includes(confirmed.ticket.status) &&
      sameFields(confirmed.ticket, {title, body, module, deps, tags}), 'Prepared ticket fields were not confirmed');
    return {verdict: 'READY', id: source.id, children: []};
  }

  // Mark each POST before sending. An uncertain response must never create another child.
  for (const task of tasks) {
    let child = receipt.children[task.id];
    if (!child) {
      const deps = [...task.external_dependencies, ...task.depends_on.map(key => receipt.children[key].id)];
      child = {task: hash(task)};
      receipt.children[task.id] = child;
      save(receiptFile, receipt);
      const created = await request('POST', '/v1/tickets', {}, {
        workspace, project: task.project, title: task.title, body: task.body, module: task.module,
        status: 'blocked', tags: stagedTags,
        deps,
        ...(source.priority ? {priority: source.priority} : {}),
      });
      require(typeof created?.id === 'string', 'Child creation is uncertain; inspect NTK and publication.json');
      child.id = created.id;
      save(receiptFile, receipt);
    }
    require(child.id && child.task === hash(task), 'Child creation is uncertain or its plan changed; inspect publication.json');
    const saved = await ticket(child.id, workspace);
    const wanted = [...new Set([...task.external_dependencies, ...task.depends_on.map(key => receipt.children[key].id)])].sort();
    const fields = {project: task.project, title: task.title, body: task.body, module: task.module,
      deps: wanted, tags: stagedTags};
    require(saved.ticket.status === 'blocked' && sameFields(saved.ticket, fields) &&
      (!child.revision || child.revision === saved.revision_count), 'Child changed before publication; unchanged');
    child.fields = fields;
    child.revision = saved.revision_count;
    save(receiptFile, receipt);
    const graph = await request('GET', `${route(child.id)}/deps`, {workspace});
    require(hash((graph.up || []).filter(item => item.depth === 1).map(item => item.id).sort()) === hash(wanted),
      'Child dependency direction differs from the plan');
    if (!child.attached) {
      await attachReport(child.id, workspace, `planning-ntk-${source.id}.json`, report);
      child.attached = true;
      save(receiptFile, receipt);
    }
  }
  const ids = tasks.map(task => receipt.children[task.id].id);
  await attachReport(source.id, workspace, `planning-ntk-${hash(plan).slice(0, 16)}.json`, report);
  await unchanged(input);
  await update(source.id, {status: 'to_review', title: `[CLOSE AT NO DEPS] ${title}`,
    dep_set: [...new Set([...(source.deps || []), ...ids])], tag_edits: [`-${dispatchTag}`]});
  const parent = await ticket(source.id, workspace);
  receipt.parent = {status: 'to_review', title: `[CLOSE AT NO DEPS] ${title}`,
    body: source.body, module: source.module, deps: [...new Set([...(source.deps || []), ...ids])],
    tags: (source.tags || []).filter(tag => tag !== dispatchTag)};
  require(sameFields(parent.ticket, receipt.parent), 'Parent publication was not confirmed');
  receipt.parentRevision = parent.revision_count;
  save(receiptFile, receipt);
  return activate(input, receipt, receiptFile, source);
}

try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const action = process.argv[2];
  const result = await ({snapshot, publish}[action])(input);
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) {
  console.error(`planning-ntk: ${error.message}`);
  process.exitCode = 1;
}
