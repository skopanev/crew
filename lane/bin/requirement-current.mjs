#!/usr/bin/env node
// Recheck the live unit under the target lock. A read failure must prevent a push.
import fs from 'node:fs';
import path from 'node:path';
import {callJoppa} from '../../lane-launcher/joppa-api.mjs';
import {requirementPlan} from '../../lane-launcher/requirement-delivery.mjs';

try {
  const claim = JSON.parse(fs.readFileSync(path.join(process.env.MEDULLA_RUN_DIR, 'artifacts/claim.json'), 'utf8'));
  const {input, plan} = claim.delivery || {};
  if (!plan?.final || !plan.fingerprint || !input || !process.env.REQUIREMENT_READER_FILE) {
    throw new Error('Requirement finalization needs its captured plan and read-only credential');
  }
  const fresh = await requirementPlan(input, (tool, args) => callJoppa(input.config.joppa.url,
    process.env.REQUIREMENT_READER_FILE, tool, {workspace: input.workspace, ...args}));
  if (!fresh.final || fresh.planningHeld || fresh.fingerprint !== plan.fingerprint) {
    throw new Error('Requirement composition or planning ownership changed after claim');
  }
  console.log('Requirement composition is current; no planner holds the unit.');
} catch (error) {
  console.error(`REQUIREMENT_CHANGED: ${error.message}`);
  process.exitCode = 1;
}
