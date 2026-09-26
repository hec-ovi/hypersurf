// Evaluation metrics for event times (MIREX-style), used by the analysis
// quality gates and the debug overlay.

/**
 * One-to-one matching of sorted `estimates` to sorted `reference` times
 * within ±tolerance seconds. Returns { matched, precision, recall, f, errors }
 * where `errors` are estimate − reference for each match.
 */
export function matchEvents(reference, estimates, tolerance) {
  const ref = Float64Array.from(reference).sort();
  const est = Float64Array.from(estimates).sort();
  let i = 0, j = 0, matched = 0;
  const errors = [];
  while (i < ref.length && j < est.length) {
    const d = est[j] - ref[i];
    if (Math.abs(d) <= tolerance) {
      // Prefer the closer of this estimate and the next one for this reference.
      if (j + 1 < est.length && Math.abs(est[j + 1] - ref[i]) < Math.abs(d)) { j++; continue; }
      errors.push(d);
      matched++; i++; j++;
    } else if (d < 0) j++;
    else i++;
  }
  const precision = est.length ? matched / est.length : 0;
  const recall = ref.length ? matched / ref.length : 0;
  const f = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { matched, precision, recall, f, errors };
}

export function median(values) {
  const a = Float64Array.from(values).sort();
  if (!a.length) return NaN;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : 0.5 * (a[m - 1] + a[m]);
}
