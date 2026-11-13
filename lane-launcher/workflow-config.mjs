import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const defaultWorkflow = fileURLToPath(new URL('../lane/workflow.yaml', import.meta.url));

// Medulla mounts the directory of an outside definition read-only and reads its workflow.yaml.
export function validateWorkflow(file = defaultWorkflow) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.basename(file) !== 'workflow.yaml') {
    throw new Error('Config needs workflow: an absolute path to a workflow.yaml file');
  }
  let stat;
  try { stat = fs.lstatSync(file); } catch { stat = null; }
  if (!stat?.isFile() || !stat.size) throw new Error(`Workflow file must be a nonempty regular file: ${file}`);
  return file;
}

// The worker passes an empty value for the bundled lane workflow.
export function workflowFile(file = defaultWorkflow) {
  const resolved = fs.realpathSync(validateWorkflow(file));
  return resolved === fs.realpathSync(defaultWorkflow) ? '' : resolved;
}

// A custom workflow must not receive retained state unless it is an exact copy of this supported flow.
export function supportsRetainedCheckout(file = defaultWorkflow) {
  return fs.readFileSync(file, 'utf8') === fs.readFileSync(defaultWorkflow, 'utf8');
}
