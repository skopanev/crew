#!/usr/bin/env node
// Internal lane completion, not a general ticket CLI. The host worker records
// the Joppa outcome; inside the lane this only checks the confirmed claim.
import fs from 'node:fs';
import path from 'node:path';

const {ticket_id: id, project_name: workspace, MEDULLA_RUN_DIR: runDir} = process.env;
const artifacts = path.join(runDir || '', 'artifacts');

function requireClaim() {
  const claim = JSON.parse(fs.readFileSync(path.join(artifacts, 'claim.json'), 'utf8'));
  if (!id || !workspace || !runDir || claim.claimed !== true || claim.status !== 'in_progress' ||
      claim.id?.toLowerCase() !== id.toLowerCase() || claim.workspace !== workspace || claim.run_dir !== runDir) {
    throw new Error('No confirmed claim for this ticket and run; Joppa was not modified');
  }
  if (claim.source !== 'joppa') throw new Error('The claim is not a Joppa Task claim');
  return claim;
}

function main(mode) {
  const claim = requireClaim();
  if (!['to-test', 'blocked', 'findings'].includes(mode)) throw new Error('Expected to-test, blocked or findings');
  console.log(mode === 'findings' ? 'Joppa findings remain in followups.txt for the host completion evidence' :
    `Joppa ${mode}: host worker records the outcome for ${claim.address}`);
}

try { main(process.argv[2]); }
catch (error) { console.error(error.message); process.exitCode = 1; }
