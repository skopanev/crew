// Crew's own planning failure marks, read from the existing run receipts. No new store, no writes.
// planning_retry.py makes the final decision before the claim. This read only keeps ineligible ACs out of the queue.
import fs from 'node:fs';
import path from 'node:path';

const FIRST_DELAY_MS = 60 * 1000;
const json = file => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
};
const addresses = claim => {
  const args = claim?.arguments || {};
  const commands = args.command ? [args.command] : (args.operations || []).map(item => item.command);
  return new Set(commands.map(command => command.target || `${command.kind}:${command.id}`));
};

// Map AC address -> the failure mark of the last run that claimed it, when that mark has exact provenance.
export function retryMarks(root, config) {
  const marks = new Map();
  let folders;
  try { folders = fs.readdirSync(root, {withFileTypes: true}); }
  catch (error) { if (error.code === 'ENOENT') return marks; throw error; }
  for (const entry of folders.filter(item => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const artifacts = path.join(root, entry.name, 'artifacts');
    const claim = json(path.join(artifacts, 'claim.json'));
    if (!claim || claim.status === 'rejected' || claim.arguments?.workspace !== config.workspace ||
        claim.server && config.url && claim.server !== config.url) continue;
    const receipts = ['claim.json', 'publication.json', 'release.json'].map(name => json(path.join(artifacts, name)));
    const release = receipts[2];
    const uncertain = receipts.some(receipt => ['pending', 'uncertain'].includes(receipt?.status));
    for (const address of addresses(claim)) {
      const mark = release?.status === 'confirmed' ? release.marks?.[address] : null;
      const unknown = release?.skipped_claims?.some(item => item.ac === address && item.unknown === true);
      // A later run replaces the earlier mark. A run without a usable mark leaves none.
      if (mark && !uncertain && !unknown && Number.isSafeInteger(mark.position)) marks.set(address, mark);
      else marks.delete(address);
    }
  }
  return marks;
}

const assessment = row => row.process?.assessment ?? row['process.assessment'] ?? {};

// A waiting AC with Crew's own exact mark and a due retry. An exhausted mark returns only after an AC edit,
// because a changed authored context starts a new count. planning_retry.py compares that context.
export function retryDue(row, mark, now = Date.now()) {
  const value = assessment(row);
  if (!mark || value.state !== 'waiting' || value.position !== mark.position || value.reason !== mark.code) return false;
  if (mark.retry_exhausted) return row.revision !== mark.revision && Date.parse(mark.marked_at) + FIRST_DELAY_MS <= now;
  return typeof mark.retry_after === 'string' && Date.parse(mark.retry_after) <= now;
}
