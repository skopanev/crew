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
  let folders;
  try { folders = fs.readdirSync(root, {withFileTypes: true}); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return folders.filter(entry => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}_/.test(entry.name))
    .sort((a, b) => b.name.localeCompare(a.name)).flatMap(entry => {
      const folder = path.join(root, entry.name);
      const artifacts = path.join(folder, 'artifacts');
      const input = json(path.join(artifacts, 'input.json'));
      const result = json(path.join(artifacts, 'result.json'));
      let vars = '', pid;
      try { vars = fs.readFileSync(path.join(folder, 'vars.yaml'), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const subject = input?.joppa?.scope === 'requirement' ? input.requirement : input?.ac;
      const ac = subject?.id || /^PLANNING_JOPPA_(?:REQ|AC):\s*["']?([^\n"']+)/m.exec(vars)?.[1]?.trim();
      if (!ac) return [];
      const title = item => {
        if (!item) return '';
        const data = input?.joppa?.objects?.[item.id]?.document?.data;
        if (data?.title) return data.title;
        try { return JSON.parse(item.text).data?.title || item.id; } catch { return item.id; }
      };
      const label = input ? title(subject) : ac;
      try { pid = Number(fs.readFileSync(path.join(folder, '.lock'), 'utf8').trim()); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const journal = tail(path.join(folder, 'journal.jsonl')).split('\n').flatMap(line => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
      const last = journal.at(-1);
      const active = !result && (current?.folder === folder ? !current.ended : alive(pid));
      const released = json(path.join(artifacts, 'release.json'));
      const claim = json(path.join(artifacts, 'claim.json'));
      if (scope && (input?.workspace && input.workspace !== scope.workspace ||
          claim?.server && claim.server !== scope.url)) return [];
      const publication = json(path.join(artifacts, 'publication.json'));
      const recovery = result?.needs_recovery || !result && (
        [claim, publication, released].some(receipt => ['pending', 'uncertain'].includes(receipt?.status)) ||
        released?.skipped_claims?.some(item => item.unknown === true) ||
        claim?.status === 'confirmed' && released?.status !== 'confirmed');
      const status = active ? 'RUNNING' : ['published', 'unchanged'].includes(result?.status) ? 'READY' :
        recovery ? 'HELD' : result?.reason?.startsWith('Required owner decision:') ? 'HUMAN' :
        result?.status === 'blocked' ? 'BLOCKED' : last?.next === '__exit_fail__' ? 'FAILED' : 'STOPPED';
      let stage = '';
      if (active) {
        stage = last?.next && !last.next.startsWith('__') ? last.next : last?.node || 'prepare';
        try {
          const step = fs.readdirSync(path.join(folder, 'steps')).sort().at(-1);
          if (step) stage = step.replace(/^\d+-/, '');
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      } else if (status !== 'READY') {
        const failure = [...journal].reverse().find(row => ['failed', 'needs_human', '__exit_fail__'].includes(row.next)
          && !['failed', 'needs_human'].includes(row.node));
        stage = recovery ? 'RECOVERY_REQUIRED' : status === 'HUMAN' ? 'HUMAN' :
          failure?.signal || (released?.status === 'confirmed' && !result ? 'INTERRUPTED' : status);
      }
      const match = /^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})-(.+)$/.exec(entry.name);
      const start = match ? new Date(`${match[1]}T${match[2]}:${match[3]}:${match[4]}`).toISOString() : modified(folder);
      const end = active ? undefined : current?.folder === folder && current.finishedAt ||
        modified(path.join(artifacts, 'result.json')) || modified(path.join(artifacts, 'release.json')) ||
        modified(path.join(folder, 'journal.jsonl')) || start;
      return [{ticket: label, acTitle: input ? title(subject) : '', ac,
        runId: match?.[5] || entry.name, start, end, active, status, stage}];
    }).sort((a, b) => Number(b.active) - Number(a.active) || Date.parse(b.start) - Date.parse(a.start)).slice(0, limit);
}

export function titleCell(row, width) {
  const clip = (text, size) => {
    const chars = Array.from(text.replace(/[\x00-\x1f\x7f]/g, ' '));
    return chars.length > size ? chars.slice(0, size - 1).join('') + '…' : chars.join('');
  };
  return clip(row.acTitle || row.ticket, width);
}
