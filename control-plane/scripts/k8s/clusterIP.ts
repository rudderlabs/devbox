// iron-proxy's pinned ClusterIP is the cluster DNS Service's address plus a
// fixed offset, skipping addresses Services already hold. The service
// range is not re-checked here: the API server validates the address, and
// the installer shows its error with the fix.
import { type Kube, KubeError } from "./run";

export const CLUSTER_IP_OFFSET = 10;
const MAX_TRIES = 50;

export const DNS_IP_ARGS = [
  "get",
  "service",
  "kube-dns",
  "-n",
  "kube-system",
  "-o",
  "jsonpath={.spec.clusterIP}",
];
export const TAKEN_IPS_ARGS = [
  "get",
  "services",
  "-A",
  "-o",
  'jsonpath={range .items[*]}{.spec.clusterIP}{"\\n"}{end}',
];

const toInt = (ip: string) => ip.split(".").reduce((n, octet) => n * 256 + Number(octet), 0);
const toIp = (n: number) => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join(".");

export function nextFreeAddress(
  dnsIp: string,
  taken: Set<string>,
  offset = CLUSTER_IP_OFFSET,
): string {
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(dnsIp)) {
    throw new KubeError(
      `the cluster DNS address ${dnsIp} is not IPv4: set values.ironProxy.clusterIP in the target file`,
    );
  }
  for (let i = 0; i < MAX_TRIES; i++) {
    const candidate = toIp(toInt(dnsIp) + offset + i);
    if (!taken.has(candidate)) return candidate;
  }
  throw new KubeError(
    "no free address near the cluster DNS Service: set values.ironProxy.clusterIP in the target file",
  );
}

export async function pickClusterIP(k: Kube): Promise<string> {
  const dns = (await k.kubectlOk(DNS_IP_ARGS)).trim();
  const taken = await k.kubectlOk(TAKEN_IPS_ARGS);
  return nextFreeAddress(
    dns,
    new Set(
      taken
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  );
}
