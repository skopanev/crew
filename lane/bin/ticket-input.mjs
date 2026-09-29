#!/usr/bin/env node
// The shell gives agents their ticket; they do not need an NTK MCP connection.
import fs from 'node:fs';
import path from 'node:path';
import {getTicket} from '../../lane-launcher/ntk.mjs';

try {
  const args = process.argv.slice(2);
  const readOnly = args.length > 0;
  if (readOnly && (args.length !== 4 || args[0] !== '--read' || args[2] !== '--workspace')) {
    throw new Error('Usage: ticket-input.mjs [--read <ticket-id> --workspace <workspace>]');
  }
  const id = readOnly ? args[1] : process.env.ticket_id;
  const workspace = readOnly ? args[3] : process.env.project_name;
  const runDir = process.env.MEDULLA_RUN_DIR;
  if (!id || !workspace || (!readOnly && !runDir)) throw new Error('Ticket, workspace and run directory are required');
  const ticket = await getTicket(id, workspace);
  if (ticket.id.toLowerCase() !== id.toLowerCase()) throw new Error('NTK returned a different ticket');
  const content = JSON.stringify(ticket, null, 2) + '\n';
  if (readOnly) {
    process.stdout.write(content);
  } else {
    const file = path.join(runDir, 'artifacts', 'ticket.json');
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file + '.tmp', content, {mode: 0o600});
    fs.renameSync(file + '.tmp', file);
  }
} catch (error) {
  console.error(`Ticket input: ${error.message}`);
  process.exitCode = 1;
}
