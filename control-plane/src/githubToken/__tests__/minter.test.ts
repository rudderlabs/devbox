import { describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { MinterGaveUpError, type MinterLogger, parseMinterInputs, runMinter } from "../minter";
import type { TokenSink } from "../sinks";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const ecKey = generateKeyPairSync("ec", {
  namedCurve: "P-256",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;
const START = Date.parse("2026-10-19T12:00:00Z");
const TOKEN = "ghs_secretInstallationToken0123456789";
const EXPIRES = "2026-10-19T13:00:00.000Z";

type Reply = { status: number; body: unknown } | Error;
const okReply = (expiresAt = EXPIRES): Reply => ({
  status: 201,
  body: { token: TOKEN, expires_at: expiresAt },
});
const fail = (status: number, message = "boom"): Reply => ({ status, body: { message } });

class Stop extends Error {}

function harness(
  replies: Reply[],
  opts: { once?: boolean; maxSleeps?: number; sinkFails?: number; repositories?: string[] } = {},
) {
  let clock = START;
  const sleeps: number[] = [];
  const logs: Array<{ level: string; msg: string; meta: Record<string, unknown> }> = [];
  const writes: Array<{ token: string; expiresAt: string }> = [];
  let sinkFails = opts.sinkFails ?? 0;
  const sink: TokenSink = {
    describe: "file:/var/run/devbox/github/token",
    write: async (t) => {
      if (sinkFails-- > 0) throw new Error("EACCES: permission denied");
      writes.push(t);
    },
  };
  const log = (level: string) => (msg: string, meta?: object) =>
    logs.push({ level, msg, meta: (meta ?? {}) as Record<string, unknown> });
  const logger: MinterLogger = { info: log("info"), warn: log("warn"), error: log("error") };
  const run = () =>
    runMinter({
      appId: 123,
      installationId: 456,
      privateKeyPem: privateKey,
      repositories: opts.repositories,
      sink,
      once: opts.once ?? false,
      fetch: async () => {
        const r = replies.shift();
        if (!r) throw new Error("no more replies");
        if (r instanceof Error) throw r;
        return new Response(JSON.stringify(r.body), { status: r.status });
      },
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
        if (sleeps.length >= (opts.maxSleeps ?? Number.POSITIVE_INFINITY)) throw new Stop();
      },
      now: () => new Date(clock),
      log: logger,
    }).then(
      () => undefined,
      (e: unknown) => {
        if (e instanceof Stop) return undefined;
        if (e instanceof MinterGaveUpError) return e;
        throw e;
      },
    );
  return { run, sleeps, logs, writes, now: () => clock };
}

const noSecrets = (logs: unknown[]) => {
  const text = JSON.stringify(logs);
  expect(text).not.toContain(TOKEN);
  expect(text).not.toContain("PRIVATE KEY");
  expect(text).not.toContain("eyJ");
};

describe("runMinter", () => {
  it("mints, logs, and sleeps until 30 min before expiry", async () => {
    const h = harness([okReply()], { maxSleeps: 1 });
    await h.run();
    expect(h.writes).toEqual([{ token: TOKEN, expiresAt: EXPIRES }]);
    expect(h.sleeps).toEqual([30 * 60_000]);
    expect(h.logs).toEqual([
      {
        level: "info",
        msg: "github_token.minted",
        meta: {
          installationId: 456,
          expiresAt: EXPIRES,
          repositories: 0,
          sink: "file:/var/run/devbox/github/token",
        },
      },
    ]);
    noSecrets(h.logs);
  });

  it("counts the narrowed repositories in the minted log", async () => {
    const h = harness([okReply()], { once: true, repositories: ["a", "b"] });
    await h.run();
    expect(h.logs[0]?.meta.repositories).toBe(2);
  });

  it("refreshes again after the sleep", async () => {
    const h = harness([okReply(), okReply("2026-10-19T13:40:00.000Z")], { maxSleeps: 2 });
    await h.run();
    expect(h.writes.map((w) => w.expiresAt)).toEqual([EXPIRES, "2026-10-19T13:40:00.000Z"]);
    // second mint at 12:30, refresh at 13:10
    expect(h.sleeps).toEqual([30 * 60_000, 40 * 60_000]);
  });

  it("backs off 5 s then 10 s on 500s, then succeeds", async () => {
    const h = harness([fail(500), fail(500), okReply()], { once: true });
    await h.run();
    expect(h.sleeps).toEqual([5_000, 10_000]);
    expect(h.writes).toHaveLength(1);
    noSecrets(h.logs);
  });

  it("caps the backoff at 300 s in the loop", async () => {
    const h = harness([...Array.from({ length: 8 }, () => fail(502)), okReply()], {
      maxSleeps: 9,
    });
    await h.run();
    expect(h.sleeps.slice(0, 8)).toEqual([5, 10, 20, 40, 80, 160, 300, 300].map((s) => s * 1000));
    expect(h.writes).toHaveLength(1);
  });

  it("resets the backoff after a success", async () => {
    const h = harness([fail(500), fail(500), okReply(), fail(500), okReply()], { maxSleeps: 5 });
    await h.run();
    // minted at 12:00:15, so the refresh sleep is 30 min - 15 s; the refresh
    // fails, then the backoff starts again at 5 s; the late token is past its
    // refresh point, so the floor of 5 s applies
    expect(h.sleeps).toEqual([5_000, 10_000, 30 * 60_000 - 15_000, 5_000, 5_000]);
  });

  it("logs a 422 with the narrowing reason and keeps retrying", async () => {
    const h = harness(
      [fail(422, "There is at least one repository that does not exist"), okReply()],
      { maxSleeps: 2, repositories: ["a"] },
    );
    await h.run();
    expect(h.logs[0]).toEqual({
      level: "warn",
      msg: "github_token.mint_failed",
      meta: {
        installationId: 456,
        status: 422,
        reason:
          "a repo in GITHUB_APP_REPOSITORIES is not in the installation " +
          "(There is at least one repository that does not exist)",
        retryInSec: 5,
        currentTokenExpiresAt: null,
      },
    });
    expect(h.writes).toHaveLength(1);
  });

  it("retries 401 and 404 at the 5 min cap and reports the current token's expiry", async () => {
    const h = harness(
      [okReply(), fail(401, "Bad credentials"), fail(404, "Not Found"), okReply()],
      {
        once: false,
        maxSleeps: 4,
      },
    );
    await h.run();
    expect(h.sleeps.slice(1, 3)).toEqual([300_000, 300_000]);
    expect(h.logs.filter((l) => l.msg === "github_token.mint_failed").map((l) => l.meta)).toEqual([
      {
        installationId: 456,
        status: 401,
        reason: "Bad credentials",
        retryInSec: 300,
        currentTokenExpiresAt: EXPIRES,
      },
      {
        installationId: 456,
        status: 404,
        reason: "Not Found",
        retryInSec: 300,
        currentTokenExpiresAt: EXPIRES,
      },
    ]);
  });

  it("restarts the backoff at 5 s when a transient failure follows a 401", async () => {
    const h = harness([fail(401, "Bad credentials"), fail(500), okReply()], {
      once: false,
      maxSleeps: 3,
    });
    await h.run();
    expect(h.sleeps.slice(0, 2)).toEqual([300_000, 5_000]);
  });

  it("logs a network failure with a null status", async () => {
    const h = harness([new TypeError("fetch failed"), okReply()], { once: true });
    await h.run();
    expect(h.logs[0]?.meta).toEqual({
      installationId: 456,
      status: null,
      reason: "fetch failed",
      retryInSec: 5,
      currentTokenExpiresAt: null,
    });
  });

  it("logs a sink failure and retries", async () => {
    const h = harness([okReply(), okReply()], { once: true, sinkFails: 1 });
    await h.run();
    expect(h.logs[0]).toEqual({
      level: "error",
      msg: "github_token.sink_failed",
      meta: {
        sink: "file:/var/run/devbox/github/token",
        reason: "EACCES: permission denied",
        retryInSec: 5,
      },
    });
    expect(h.sleeps).toEqual([5_000]);
    expect(h.writes).toHaveLength(1);
    noSecrets(h.logs);
  });

  for (const status of [401, 403, 404, 422]) {
    it(`once: a ${status} logs and gives up at once, without sleeping`, async () => {
      const h = harness([fail(status, "nope")], { once: true });
      const gaveUp = await h.run();
      expect(gaveUp).toBeInstanceOf(MinterGaveUpError);
      expect((gaveUp as Error).message).toBe(`token request failed: HTTP ${status}: nope`);
      expect(h.sleeps).toEqual([]);
      expect(h.writes).toEqual([]);
      expect(h.logs).toEqual([
        {
          level: "warn",
          msg: "github_token.mint_failed",
          meta: {
            installationId: 456,
            status,
            reason: "nope",
            retryInSec: null,
            currentTokenExpiresAt: null,
          },
        },
      ]);
    });
  }

  it("once: a narrowed 422 names the refusal once", async () => {
    const h = harness([fail(422, "There is at least one repository that does not exist")], {
      once: true,
      repositories: ["a"],
    });
    const gaveUp = await h.run();
    expect(gaveUp).toEqual(
      new MinterGaveUpError(
        "token request refused (HTTP 422): a repo in GITHUB_APP_REPOSITORIES is not in the installation (There is at least one repository that does not exist)",
      ),
    );
  });

  it("loop mode keeps retrying a 403 with the normal backoff", async () => {
    const h = harness([fail(403), fail(403), okReply()], { maxSleeps: 3 });
    expect(await h.run()).toBeUndefined();
    expect(h.sleeps.slice(0, 2)).toEqual([5_000, 10_000]);
  });

  it("once: other failures get 5 attempts with the normal backoff, then give up", async () => {
    const h = harness(
      Array.from({ length: 6 }, () => fail(500)),
      { once: true },
    );
    const gaveUp = await h.run();
    expect(gaveUp).toBeInstanceOf(MinterGaveUpError);
    expect((gaveUp as Error).message).toBe("gave up after 5 attempts: boom");
    expect(h.sleeps).toEqual([5_000, 10_000, 20_000, 40_000]);
    expect(h.logs.map((l) => l.meta.retryInSec)).toEqual([5, 10, 20, 40, null]);
  });

  it("once: a 401 after transient failures still gives up at once", async () => {
    const h = harness([fail(500), fail(401, "Bad credentials")], { once: true });
    expect(await h.run()).toBeInstanceOf(MinterGaveUpError);
    expect(h.sleeps).toEqual([5_000]);
  });

  it("once: sink failures are bounded too", async () => {
    const h = harness(
      Array.from({ length: 6 }, () => okReply()),
      { once: true, sinkFails: 10 },
    );
    const gaveUp = await h.run();
    expect(gaveUp).toBeInstanceOf(MinterGaveUpError);
    expect((gaveUp as Error).message).toBe("gave up after 5 attempts: EACCES: permission denied");
    expect(h.sleeps).toEqual([5_000, 10_000, 20_000, 40_000]);
    expect(h.logs.map((l) => [l.msg, l.meta.retryInSec])).toEqual([
      ["github_token.sink_failed", 5],
      ["github_token.sink_failed", 10],
      ["github_token.sink_failed", 20],
      ["github_token.sink_failed", 40],
      ["github_token.sink_failed", null],
    ]);
    noSecrets(h.logs);
  });

  it("returns after the first write with once", async () => {
    const h = harness([okReply()], { once: true });
    await h.run();
    expect(h.writes).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
  });

  it("never sleeps less than 5 s when the token is already near expiry", async () => {
    const h = harness([okReply("2026-10-19T12:10:00.000Z")], { maxSleeps: 1 });
    await h.run();
    expect(h.sleeps).toEqual([5_000]);
  });
});

describe("parseMinterInputs", () => {
  const env = {
    GITHUB_APP_ID: "123",
    GITHUB_APP_INSTALLATION_ID: "456",
    GITHUB_APP_PRIVATE_KEY_FILE: "/run/secrets/github_app_private_key",
    GITHUB_APP_REPOSITORIES: " a, b ,,",
    GITHUB_TOKEN_SINK: "file:/var/run/devbox/github/token",
  };
  const readFile = (path: string) => {
    if (path !== "/run/secrets/github_app_private_key") throw new Error("ENOENT");
    return privateKey;
  };

  it("parses the env and argv", () => {
    const inputs = parseMinterInputs(env, ["--once"], readFile);
    expect({ ...inputs, sink: inputs.sink.describe }).toEqual({
      appId: 123,
      installationId: 456,
      privateKeyPem: privateKey,
      repositories: ["a", "b"],
      sink: "file:/var/run/devbox/github/token",
      once: true,
    });
  });

  it("treats unset or empty repositories as no narrowing and once as off", () => {
    const { GITHUB_APP_REPOSITORIES: _, ...rest } = env;
    expect(parseMinterInputs(rest, [], readFile).repositories).toEqual([]);
    const inputs = parseMinterInputs({ ...env, GITHUB_APP_REPOSITORIES: "" }, [], readFile);
    expect(inputs.repositories).toEqual([]);
    expect(inputs.once).toBe(false);
  });

  const cases: Array<[string, Record<string, string | undefined>, string]> = [
    ["missing app id", { GITHUB_APP_ID: undefined }, "GITHUB_APP_ID is required"],
    ["bad app id", { GITHUB_APP_ID: "12a" }, "GITHUB_APP_ID must be a positive integer"],
    [
      "missing installation",
      { GITHUB_APP_INSTALLATION_ID: "" },
      "GITHUB_APP_INSTALLATION_ID is required",
    ],
    [
      "bad installation",
      { GITHUB_APP_INSTALLATION_ID: "0" },
      "GITHUB_APP_INSTALLATION_ID must be a positive integer",
    ],
    [
      "missing key file",
      { GITHUB_APP_PRIVATE_KEY_FILE: undefined },
      "GITHUB_APP_PRIVATE_KEY_FILE is required",
    ],
    ["missing sink", { GITHUB_TOKEN_SINK: undefined }, "GITHUB_TOKEN_SINK is required"],
    ["bad sink", { GITHUB_TOKEN_SINK: "secret:x" }, 'bad GITHUB_TOKEN_SINK: "secret:x"'],
    [
      "owner/repo",
      { GITHUB_APP_REPOSITORIES: "example-org/example-repo" },
      "GITHUB_APP_REPOSITORIES takes repo names without the owner",
    ],
    [
      "unreadable key",
      { GITHUB_APP_PRIVATE_KEY_FILE: "/nope/key.pem" },
      "cannot read the GitHub App private key at /nope/key.pem",
    ],
  ];
  for (const [name, patch, message] of cases) {
    it(`rejects ${name}`, () => {
      expect(() => parseMinterInputs({ ...env, ...patch }, [], readFile)).toThrow(message);
    });
  }

  it("rejects more than 500 repositories", () => {
    const many = Array.from({ length: 501 }, (_, i) => `r${i}`).join(",");
    expect(() =>
      parseMinterInputs({ ...env, GITHUB_APP_REPOSITORIES: many }, [], readFile),
    ).toThrow("GITHUB_APP_REPOSITORIES names 501 repos; GitHub allows at most 500");
  });

  it("rejects a key file that is not a PEM private key, without echoing it", () => {
    const err = (() => {
      try {
        parseMinterInputs(env, [], () => "not a key: hunter2");
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err?.message).toBe(
      "/run/secrets/github_app_private_key is not a PEM private key (GITHUB_APP_PRIVATE_KEY_FILE)",
    );
  });

  it("rejects a non-RSA key at startup, without echoing it", () => {
    const err = (() => {
      try {
        parseMinterInputs(env, [], () => ecKey);
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err?.message).toBe(
      "/run/secrets/github_app_private_key is not an RSA private key (GITHUB_APP_PRIVATE_KEY_FILE)",
    );
    expect(err?.message).not.toContain("PRIVATE KEY");
  });
});
