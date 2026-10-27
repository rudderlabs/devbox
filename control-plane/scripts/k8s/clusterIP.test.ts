import { describe, expect, it } from "bun:test";
import { DNS_IP_ARGS, nextFreeAddress, pickClusterIP, TAKEN_IPS_ARGS } from "./clusterIP";
import { fakeRunner } from "./fakeRunner";
import { kube } from "./run";

describe("nextFreeAddress", () => {
  it("is the DNS address plus 10", () => {
    expect(nextFreeAddress("10.96.0.10", new Set())).toBe("10.96.0.20");
  });
  it("skips taken addresses and carries across octets", () => {
    expect(nextFreeAddress("10.96.0.250", new Set(["10.96.1.4", "10.96.1.5"]))).toBe("10.96.1.6");
  });
  it("refuses IPv6", () => {
    expect(() => nextFreeAddress("fd00::a", new Set())).toThrow(
      "the cluster DNS address fd00::a is not IPv4: set values.ironProxy.clusterIP in the target file",
    );
  });
});

describe("pickClusterIP", () => {
  it("reads the DNS Service and the taken addresses", async () => {
    const f = fakeRunner([
      { cmd: ["kubectl", "--context", "c", ...DNS_IP_ARGS], result: { stdout: "10.96.0.10" } },
      {
        cmd: ["kubectl", "--context", "c", ...TAKEN_IPS_ARGS],
        result: { stdout: "10.96.0.1\n10.96.0.20\nNone\n" },
      },
    ]);
    expect(await pickClusterIP(kube(f.runner, "c"))).toBe("10.96.0.21");
    f.done();
  });

  it("asks for the documented jsonpath", () => {
    expect(DNS_IP_ARGS).toEqual([
      "get",
      "service",
      "kube-dns",
      "-n",
      "kube-system",
      "-o",
      "jsonpath={.spec.clusterIP}",
    ]);
    expect(TAKEN_IPS_ARGS).toEqual([
      "get",
      "services",
      "-A",
      "-o",
      'jsonpath={range .items[*]}{.spec.clusterIP}{"\\n"}{end}',
    ]);
  });
});
