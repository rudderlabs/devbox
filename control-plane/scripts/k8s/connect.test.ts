import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertPortFree, connect, freePort, isPortFree } from "./connect";
import { fakeRunner } from "./fakeRunner";
import { KubeError } from "./run";
import type { Target } from "./target";

const root = mkdtempSync(join(tmpdir(), "devbox-connect-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
function homeWith(profiles: Record<string, { url: string; token: string }>): string {
  const home = join(root, `home-${++n}`);
  mkdirSync(join(home, ".config", "devbox"), { recursive: true });
  writeFileSync(
    join(home, ".config", "devbox", "config.json"),
    JSON.stringify({ current: undefined, profiles }),
  );
  return home;
}

function deps(over: { target: Target; home: string; free?: boolean }) {
  const f = fakeRunner([]);
  const logs: string[] = [];
  const forwarded: string[][] = [];
  return {
    f,
    logs,
    forwarded,
    deps: {
      runner: f.runner,
      target: over.target,
      env: {},
      home: over.home,
      log: (line: string) => void logs.push(line),
      isPortFree: async () => over.free ?? true,
      forwardForeground: async (cmd: string[]) => {
        forwarded.push(cmd);
        return 0;
      },
    },
  };
}

describe("assertPortFree", () => {
  it("names the port and the profile when the port is taken", async () => {
    await expect(assertPortFree(13000, "k8s-kind-devbox", async () => false)).rejects.toThrow(
      new KubeError(
        'port 13000 is in use: another `bun run k8s:connect` for profile "k8s-kind-devbox" may still be running (stop it, or free the port)',
      ),
    );
  });

  it("passes on a free port", async () => {
    await assertPortFree(13000, "k8s-kind-devbox", async () => true);
  });
});

describe("freePort", () => {
  it("skips busy ports", async () => {
    const asked: number[] = [];
    const free = async (port: number) => {
      asked.push(port);
      return port === 13002;
    };
    expect(await freePort(13000, free)).toBe(13002);
    expect(asked).toEqual([13000, 13001, 13002]);
  });

  it("gives up after 100 ports", async () => {
    await expect(freePort(13000, async () => false)).rejects.toThrow(
      new KubeError("no free local port in 13000-13099"),
    );
  });
});

describe("connect", () => {
  it("needs a profile from k8s:install", async () => {
    const d = deps({ target: { context: "prod", values: {} }, home: homeWith({}) });
    await expect(connect(d.deps)).rejects.toThrow(
      new KubeError('no CLI profile "k8s-prod": run `bun run k8s:install --target <file>` first'),
    );
    d.f.done();
    expect(d.forwarded).toEqual([]);
  });

  it("on kind, needs a profile from k8s:kind", async () => {
    const d = deps({ target: { context: "kind-devbox", values: {} }, home: homeWith({}) });
    await expect(connect(d.deps)).rejects.toThrow(
      new KubeError('no CLI profile "k8s-kind-devbox": run `bun run k8s:kind` first'),
    );
    d.f.done();
    expect(d.forwarded).toEqual([]);
  });

  it("does nothing for a profile behind an Ingress", async () => {
    const d = deps({
      target: { context: "kind-devbox", profile: "k8s-x", values: {} },
      home: homeWith({ "k8s-x": { url: "https://devbox.example.com", token: "dbx_t" } }),
    });
    expect(await connect(d.deps)).toBe(0);
    d.f.done();
    expect(d.f.calls).toEqual([]);
    expect(d.forwarded).toEqual([]);
    expect(d.logs).toEqual([
      'profile "k8s-x" uses https://devbox.example.com: no port-forward needed',
    ]);
  });

  it("port-forwards on the profile's port", async () => {
    const d = deps({
      target: { context: "kind-devbox", values: {} },
      home: homeWith({ "k8s-kind-devbox": { url: "http://localhost:13000", token: "dbx_t" } }),
    });
    expect(await connect(d.deps)).toBe(0);
    d.f.done();
    expect(d.forwarded).toEqual([
      [
        "kubectl",
        "--context",
        "kind-devbox",
        "port-forward",
        "-n",
        "devbox",
        "svc/devbox-control-plane",
        "13000:3000",
        "--address",
        "127.0.0.1",
      ],
    ]);
    expect(d.logs).toEqual([
      'devbox (profile "k8s-kind-devbox") at http://localhost:13000: press Ctrl-C to stop',
    ]);
  });

  it("refuses a taken port with a clear message", async () => {
    const d = deps({
      target: { context: "kind-devbox", values: {} },
      home: homeWith({ "k8s-kind-devbox": { url: "http://localhost:13000", token: "dbx_t" } }),
      free: false,
    });
    await expect(connect(d.deps)).rejects.toThrow(
      new KubeError(
        'port 13000 is in use: another `bun run k8s:connect` for profile "k8s-kind-devbox" may still be running (stop it, or free the port)',
      ),
    );
    expect(d.forwarded).toEqual([]);
  });
});

describe("isPortFree", () => {
  it("sees a bound port as taken", async () => {
    const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = server.port;
    expect(await isPortFree(port)).toBe(false);
    server.stop(true);
    expect(await isPortFree(port)).toBe(true);
  });
});
