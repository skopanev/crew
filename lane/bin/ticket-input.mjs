#!/usr/bin/env node
// The shell gives agents their ticket; they do not need an NTK MCP connection.
import fs from 'node:fs';
import path from 'node:path';
import {getTicket} from '../../lane-launcher/ntk.mjs';

try {
  const {ticket_id: id, project_name: workspace, MEDULLA_RUN_DIR: runDir} = process.env;
  if (!id || !workspace || !runDir) throw new Error('Ticket, workspace and run directory are required');
  const file = path.join(runDir, 'artifacts', 'ticket.json');
  const ticket = await getTicket(id, workspace);
  if (ticket.id.toLowerCase() !== id.toLowerCase()) throw new Error('NTK returned a different ticket');
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file + '.tmp', JSON.stringify(ticket, null, 2) + '\n', {mode: 0o600});
  fs.renameSync(file + '.tmp', file);
} catch (error) {
  console.error(`Ticket input: ${error.message}`);
  process.exitCode = 1;
}
