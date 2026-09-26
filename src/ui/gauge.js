// The ring gauge (docs/art-direction.md §4.4, reference 3): a thin track
// circle, a dotted tick ring and a glowing value arc, with the value in the
// centre and a tracked label under it.

/** A ring gauge's markup: value text, arc fraction 0..1, label, optional sub-line (trusted HTML). */
export function gaugeHtml({ label, value, unit = '', fraction = 0, sub = '' }) {
  const v = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  return `<div class="gauge"><div class="face"><svg viewBox="0 0 76 76" aria-hidden="true"><circle class="tick" cx="38" cy="38" r="37"/><circle class="trk" cx="38" cy="38" r="34"/><circle class="arc" cx="38" cy="38" r="34" pathLength="100" style="--v:${v}"/></svg><b>${value}${unit ? `<small>${unit}</small>` : ''}</b></div><span class="lbl">${label}</span>${sub ? `<span class="sub">${sub}</span>` : ''}</div>`;
}
