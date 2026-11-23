// Planner run rows read from existing run folders. No history store.
import fs from 'node:fs';
import path from 'node:path';
import {tail} from './run-files.mjs';

const json = file => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
};
const alive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
};
const modified = file => {
  try { return fs.statSync(file).mtime.toISOString(); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
};

export function plannerRows(root, current = null, limit = 30, scope = null) {
  const tracked = new Map((Array.isArray(current) ? current : [current]).filter(Boolean).map(run => [run.folder, run]));
  let folders;
  try { folders = fs.readdirSync(root, {withFileTypes: true}); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const launches = new Map(folders.filter(entry => entry.isDirectory())
    .map(entry => [entry.name, json(path.join(root, entry.name, 'launch.json'))]));
  const nested = new Set([...launches.values()].map(run => run?.medullaRun).filter(Boolean).map(folder => path.resolve(folder)));
  return folders.filter(entry => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}_/.test(entry.name))
    .filter(entry => !nested.has(path.resolve(root, entry.name)))
    .sort((a, b) => b.name.localeCompare(a.name)).flatMap(entry => {
      const folder = path.join(root, entry.name);
      const launch = launches.get(entry.name);
      if (scope?.dispatcherId && launch?.dispatcherId && scope.dispatcherId !== launch.dispatcherId) return [];
      const recordFolder = launch?.medullaRun || folder;
      const artifacts = path.join(recordFolder, 'artifacts');
      const input = json(path.join(artifacts, 'input.json'));
      const result = json(path.join(artifacts, 'result.json'));
      let vars = '', pid;
      try { vars = fs.readFileSync(path.join(recordFolder, 'vars.yaml'), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const subject = input?.joppa?.scope === 'requirement' ? input.requirement : input?.ac;
      // A configured flow records the complete selected object. Its identity and revision dedupe later passes.
      // The claim and its release change the item revision, so a finished run records the revision it left.
      const selected = input?.selected && typeof input.selected === 'object' ? input.selected :
        launch?.address ? {address: launch.address, revision: JSON.parse(launch.attemptKey)[1]} : null;
      const ac = selected?.address || subject?.id || /^PLANNING_JOPPA_(?:REQ|AC|ITEM):\s*["']?([^\n"']+)/m.exec(vars)?.[1]?.trim();
      if (!ac) return [];
      const revision = Number.isSafeInteger(result?.selected_revision) ? result.selected_revision :
        selected?.current_revision ?? selected?.revision;
      const title = item => {
        if (!item) return '';
        const data = input?.joppa?.objects?.[item.id]?.document?.data;
        if (data?.title) return data.title;
        try { return JSON.parse(item.text).data?.title || item.id; } catch { return item.id; }
      };
      const label = selected ? selected.document?.data?.title || selected.data?.title || selected.title || ac :
        input ? title(subject) : ac;
      try { pid = Number(fs.readFileSync(path.join(folder, launch ? '.worker.pid' : '.lock'), 'utf8').trim()); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const journal = tail(path.join(recordFolder, 'journal.jsonl')).split('\n').flatMap(line => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
      const last = journal.at(-1);
      const trackedRun = tracked.get(folder);
      const active = launch ? !launch.result && alive(pid || launch.worker?.pid || launch.dispatcherPid) :
        !result && (trackedRun ? !trackedRun.ended : alive(pid));
      const released = json(path.join(artifacts, 'release.json'));
      const claim = json(path.join(artifacts, 'claim.json'));
      if (scope && (input?.workspace && input.workspace !== scope.workspace ||
          claim?.server && claim.server !== scope.url)) return [];
      const publication = json(path.join(artifacts, 'publication.json'));
      const writtenStage = publication?.status === 'confirmed' ? publication.arguments?.operations?.flatMap(({command}) =>
        command?.op === 'save_object' && `${command.kind}:${command.id}` === ac &&
        typeof command.data?.stage === 'string' ? [command.data.stage] : []).at(-1) : undefined;
      const recovery = result?.needs_recovery || !result && (
        [claim, publication, released].some(receipt => ['pending', 'uncertain'].includes(receipt?.status)) ||
        released?.skipped_claims?.some(item => item.unknown === true) ||
        claim?.status === 'confirmed' && released?.status !== 'confirmed');
      const status = active ? 'RUNNING' : ['published', 'unchanged'].includes(result?.status) ? 'READY' :
        recovery ? 'HELD' : result?.reason?.startsWith('Required owner decision:') ? 'HUMAN' :
        result?.status === 'blocked' ? 'BLOCKED' : last?.next === '__exit_fail__' || launch?.result?.code ? 'FAILED' : 'STOPPED';
      let stage = '';
      let reasonCode = result?.reason_code;
      if (active) {
        stage = last?.next && !last.next.startsWith('__') ? last.next : last?.node || 'prepare';
        try {
          const step = fs.readdirSync(path.join(recordFolder, 'steps')).sort().at(-1);
          if (step) stage = step.replace(/^\d+-/, '');
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      } else if (status !== 'READY') {
        const failure = [...journal].reverse().find(row => ['failed', 'needs_human', '__exit_fail__'].includes(row.next)
          && !['failed', 'needs_human'].includes(row.node));
        reasonCode ||= failure?.node === 'rejected' ? 'REJECTED' : failure?.signal;
        stage = recovery ? 'RECOVERY_REQUIRED' : status === 'HUMAN' ? 'HUMAN' :
          reasonCode || (released?.status === 'confirmed' && !result ? 'INTERRUPTED' : status);
      }
      if (!active && !recovery && (publication?.status === 'confirmed' || reasonCode)) {
        stage = [writtenStage ? `→ ${writtenStage}` : '', reasonCode].filter(Boolean).join(' · ') || 'NO_STAGE_WRITE';
      }
      const displayStatus = !active && typeof reasonCode === 'string' && reasonCode ? reasonCode : status;
      const negative = ['FAIL', 'DISPUTED', 'REJECTED'].includes(reasonCode) || writtenStage === 'to_decide';
      const outcomeTone = !active ? negative ? 'red' : scope?.result_colors ? recovery ? 'yellow' :
        scope.result_colors[reasonCode] || scope.result_colors[writtenStage] ||
        (status === 'FAILED' ? 'red' : scope.result_colors.default || 'yellow') : status === 'READY' ? 'ready' : undefined : undefined;
      const match = /^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})-(.+)$/.exec(entry.name);
      const start = match ? new Date(`${match[1]}T${match[2]}:${match[3]}:${match[4]}`).toISOString() : modified(folder);
      const end = active ? undefined : trackedRun?.finishedAt || launch?.result?.finishedAt ||
        modified(path.join(artifacts, 'result.json')) || modified(path.join(artifacts, 'release.json')) ||
        modified(path.join(folder, 'journal.jsonl')) || start;
      return [{ticket: label, acTitle: selected ? label : input ? title(subject) : '', ac,
        ...(selected && Number.isSafeInteger(revision) ? {attemptKey: JSON.stringify([ac, revision])} : {}),
        ...(result?.item_revisions ? {attemptKeys: Object.entries(result.item_revisions)
          .filter(([address, value]) => address.includes(':') && Number.isSafeInteger(value))
          .map(([address, value]) => JSON.stringify([address, value]))} : {}),
        runId: match?.[5] || entry.name, start, end, active, status, displayStatus, stage, ...(outcomeTone ? {outcomeTone} : {})}];
    }).sort((a, b) => Number(b.active) - Number(a.active) || Date.parse(b.start) - Date.parse(a.start)).slice(0, limit);
}

export function titleCell(row, width) {
  const clip = (text, size) => {
    const chars = Array.from(text.replace(/[\x00-\x1f\x7f]/g, ' '));
    return chars.length > size ? chars.slice(0, size - 1).join('') + '…' : chars.join('');
  };
  return clip(row.acTitle || row.ticket, width);
}
