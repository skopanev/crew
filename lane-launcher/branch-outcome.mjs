// A confirmed branch handoff completes the run. Its Tasks still await integration.
export function branchSuccessStatus(config = {}) {
  return config.branchSuccessStatus ?? 'DONE';
}

export function branchOutcome(run, result = run.result) {
  if (!result || result.code !== 0 || result.held || result.blocked ||
      !(result.pendingDelivery || result.status === 'PENDING_LANDING')) return null;
  return branchSuccessStatus(run.config);
}
