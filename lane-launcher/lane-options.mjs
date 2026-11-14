const require = (ok, message) => { if (!ok) throw new Error(message); };
const text = value => typeof value === 'string' && value.trim() && !/[\r\n\0]/.test(value);

export function reviewerInputs(reviewers) {
  if (reviewers === undefined) return undefined;
  require(Array.isArray(reviewers) && reviewers.length, 'reviewers must be a nonempty list');
  const slugs = new Set();
  return reviewers.map((seat, index) => {
    require(seat && typeof seat === 'object' && !Array.isArray(seat) &&
      Object.keys(seat).every(key => ['harness', 'model', 'effort', 'flag', 'settings', 'slug'].includes(key)),
    'Each reviewer needs harness and model, with optional effort, flag, settings and slug');
    require(text(seat.harness) && text(seat.model), 'Each reviewer needs harness and model');
    require(seat.effort === undefined || text(seat.effort), 'Reviewer effort must be text');
    for (const key of ['flag', 'settings']) require(seat[key] === undefined || seat[key] === '' || text(seat[key]),
      `Reviewer ${key} must be text`);
    const slug = seat.slug ?? `reviewer-${index + 1}`;
    require(typeof slug === 'string' && /^[A-Za-z0-9_-]+$/.test(slug) && !slugs.has(slug),
      'Reviewer slugs must be distinct file names');
    slugs.add(slug);
    return {effort: 'high', flag: '', settings: '', ...seat, slug};
  });
}

export function validateLaneOptions(config) {
  require(config.scout === undefined || typeof config.scout === 'boolean', 'scout must be true or false');
  reviewerInputs(config.reviewers);
}

export function laneOptionsEnv(config) {
  validateLaneOptions(config);
  const reviewers = reviewerInputs(config.reviewers);
  return {LANE_SCOUT: String(config.scout ?? true),
    LANE_REVIEWERS_JSON: reviewers ? JSON.stringify(reviewers) : ''};
}
