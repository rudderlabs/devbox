// --timeout values: Go-style h/m/s parts, e.g. 45s, 30m, 2h, 1h30m. A bare
// number is rejected because seconds-or-minutes would be a guess.
const DURATION_RE = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;

export function parseDuration(text: string): number | null {
  const m = DURATION_RE.exec(text);
  if (text === "" || !m) return null;
  const [, h = "0", min = "0", s = "0"] = m;
  const ms = ((Number(h) * 60 + Number(min)) * 60 + Number(s)) * 1000;
  return ms > 0 ? ms : null;
}
