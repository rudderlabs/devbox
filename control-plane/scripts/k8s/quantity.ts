// Parses Kubernetes CPU and memory quantities for the node-fit check.
const UNITS: Record<string, number> = {
  "": 1,
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  Ki: 2 ** 10,
  Mi: 2 ** 20,
  Gi: 2 ** 30,
  Ti: 2 ** 40,
};

function parse(q: string): { n: number; unit: string } {
  const m = /^(\d+(?:\.\d+)?)(m|k|M|G|T|Ki|Mi|Gi|Ti)?$/.exec(q.trim());
  if (!m?.[1]) throw new Error(`bad quantity "${q}"`);
  return { n: Number(m[1]), unit: m[2] ?? "" };
}

export function parseCpu(q: string): number {
  const { n, unit } = parse(q);
  return unit === "m" ? n / 1000 : n * (UNITS[unit] ?? Number.NaN);
}

export function parseMemory(q: string): number {
  const { n, unit } = parse(q);
  if (unit === "m") throw new Error(`bad quantity "${q}"`);
  return n * (UNITS[unit] ?? Number.NaN);
}
