// Start a worker in its own process group without a terminal or dispatcher lifetime.
import {spawn} from 'node:child_process';

export async function startDetached(command, args, options = {}) {
  const child = spawn(command, args, {...options, detached: true, stdio: options.stdio ?? 'ignore'});
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  return child.pid;
}
