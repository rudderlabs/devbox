import { describe, expect, it } from "bun:test";
import { type Bind, CallbackError, startCallbackListener } from "./listener";

const page = (port: number) => `form for ${port}`;
const WRONG_STATE = "The answer from GitHub doesn't match this run: run bun run github:setup again";
const TIMEOUT = "No answer from GitHub after 15 minutes: run bun run github:setup again";

// Whether a new TCP connection to the port is refused. fetch could reuse a
// kept-alive connection to the stopped server, so it can't tell.
const refused = async (port: number): Promise<boolean> => {
  try {
    const socket = await Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: { data() {} },
    });
    socket.end();
    return false;
  } catch {
    return true;
  }
};

describe("startCallbackListener", () => {
  it("serves the form at / on 127.0.0.1", async () => {
    const l = await startCallbackListener({ state: "s1", timeoutMs: 60_000, page });
    try {
      const res = await fetch(`http://127.0.0.1:${l.port}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).toBe(`form for ${l.port}`);
    } finally {
      l.close();
    }
  });

  it("the right state: resolves the code, answers a close-this-tab page and stops", async () => {
    const l = await startCallbackListener({ state: "s1", timeoutMs: 60_000, page });
    const res = await fetch(`http://127.0.0.1:${l.port}/callback?code=c&state=s1`);
    expect(await l.code).toBe("c");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(
      "<!doctype html>\n<p>devbox got the App from GitHub. You can close this tab and go back to the terminal.</p>\n",
    );
    expect(await refused(l.port)).toBe(true);
  });

  it("a wrong state: rejects, uses no code, and stops", async () => {
    const l = await startCallbackListener({ state: "s1", timeoutMs: 60_000, page });
    const settled = l.code.then(
      () => "resolved",
      (err: unknown) => err,
    );
    const res = await fetch(`http://127.0.0.1:${l.port}/callback?code=c&state=other`);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(
      "<!doctype html>\n<p>This answer doesn't match the running bun run github:setup. Run it again.</p>\n",
    );
    expect(await settled).toEqual(new CallbackError(WRONG_STATE));
    expect(await refused(l.port)).toBe(true);
  });

  it("a code without a state is a wrong answer", async () => {
    const l = await startCallbackListener({ state: "s1", timeoutMs: 60_000, page });
    const settled = l.code.catch((err: unknown) => err);
    await fetch(`http://127.0.0.1:${l.port}/callback?code=c`);
    expect(await settled).toEqual(new CallbackError(WRONG_STATE));
  });

  it("a request without a code is turned away and the wait goes on", async () => {
    const l = await startCallbackListener({ state: "s1", timeoutMs: 60_000, page });
    try {
      for (const query of ["", "?state=s1", "?state=other", "?error=access_denied"]) {
        const res = await fetch(`http://127.0.0.1:${l.port}/callback${query}`);
        expect(res.status).toBe(400);
        expect(await res.text()).toBe(
          "<!doctype html>\n<p>This request carries no answer from GitHub.</p>\n",
        );
      }
      await fetch(`http://127.0.0.1:${l.port}/callback?code=c3&state=s1`);
      expect(await l.code).toBe("c3");
    } finally {
      l.close();
    }
  });

  it("other paths are 404 and keep it waiting", async () => {
    const l = await startCallbackListener({ state: "s1", timeoutMs: 60_000, page });
    try {
      expect((await fetch(`http://127.0.0.1:${l.port}/favicon.ico`)).status).toBe(404);
      await fetch(`http://127.0.0.1:${l.port}/callback?code=c2&state=s1`);
      expect(await l.code).toBe("c2");
    } finally {
      l.close();
    }
  });

  it("refuses a request for another host name (DNS rebinding)", async () => {
    const l = await startCallbackListener({ state: "s1", timeoutMs: 60_000, page });
    try {
      const res = await fetch(`http://127.0.0.1:${l.port}/`, {
        headers: { Host: `attacker.example.com:${l.port}` },
      });
      expect(res.status).toBe(403);
      expect(await res.text()).toBe("");
    } finally {
      l.close();
    }
  });

  it("no answer in time: rejects and stops", async () => {
    const l = await startCallbackListener({ state: "s1", timeoutMs: 30, page });
    expect(await l.code.catch((err: unknown) => err)).toEqual(new CallbackError(TIMEOUT));
    expect(await refused(l.port)).toBe(true);
  });

  it("close() stops it without settling the code", async () => {
    const l = await startCallbackListener({ state: "s1", timeoutMs: 60_000, page });
    l.close();
    expect(await refused(l.port)).toBe(true);
  });

  describe("binding", () => {
    const fail = (code: string) => Object.assign(new Error(code), { code });
    function binder(v6: Array<string | "ok">) {
      const calls: string[] = [];
      const bind: Bind = (hostname, port, fetch) => {
        calls.push(`${hostname}:${port === 0 ? "any" : "same"}`);
        if (hostname === "::1") {
          const next = v6.shift() ?? "ok";
          if (next !== "ok") throw fail(next);
          // Stands in for a ::1 socket; this machine may have no IPv6.
          return { port, stop: () => {} };
        }
        return Bun.serve({ hostname, port, fetch });
      };
      return { bind, calls };
    }

    it("::1's port taken: a new port for both", async () => {
      const b = binder(["EADDRINUSE", "ok"]);
      const ports: number[] = [];
      const l = await startCallbackListener({
        state: "s1",
        timeoutMs: 60_000,
        page: (p) => {
          ports.push(p);
          return "form";
        },
        bind: b.bind,
      });
      try {
        expect(b.calls).toEqual(["127.0.0.1:any", "::1:same", "127.0.0.1:any", "::1:same"]);
        expect(ports).toEqual([l.port]);
        expect(await (await fetch(`http://127.0.0.1:${l.port}/`)).text()).toBe("form");
      } finally {
        l.close();
      }
    });

    it("no IPv6 loopback: 127.0.0.1 alone", async () => {
      const b = binder(["EADDRNOTAVAIL"]);
      const l = await startCallbackListener({ state: "s1", timeoutMs: 60_000, page, bind: b.bind });
      try {
        expect(b.calls).toEqual(["127.0.0.1:any", "::1:same"]);
        expect((await fetch(`http://127.0.0.1:${l.port}/`)).status).toBe(200);
      } finally {
        l.close();
      }
    });

    it("::1 taken every time: gives up after five ports", async () => {
      const b = binder(Array(5).fill("EADDRINUSE"));
      expect(
        await startCallbackListener({ state: "s1", timeoutMs: 60_000, page, bind: b.bind }).catch(
          (e: unknown) => e,
        ),
      ).toEqual(
        new CallbackError(
          "No local port free on both 127.0.0.1 and ::1: run bun run github:setup again",
        ),
      );
      expect(b.calls).toHaveLength(10);
    });
  });
});
