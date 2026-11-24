// The run files of the Decider agents besides their prompt. The agents find them through read_context.
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// On a retry the author prompt says so. read_context lists the previous draft and the findings, so the prompt names no path.
export const RETRY = 'Retry: read_context lists your previous draft and the findings. Close each finding.';

// A REVISE writes its findings as a granted file and gives the retry line for the author prompt.
export function findings(directory, name, value) {
  const file = path.join(directory, name);
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(file + '.tmp', file);
  return RETRY;
}

export const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
// The host stamps the digests that freeze gave to this critic step. wellFormed still compares them with the current
// draft and assignment. A model does not copy a 64-character hash.
export const stamp = (review, env) => review && typeof review === 'object' && !Array.isArray(review)
  ? {...review, draft_digest: env.draft_digest, context_digest: env.context_digest} : review;
