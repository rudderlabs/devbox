import { afterEach, describe, expect, it, mock, setSystemTime } from "bun:test";

// config.ts reads required env at import; nothing here reads it.
mock.module("../config", () => ({ config: {} }));

const { createIntegrations, statusesWithHolds } = await import("../app");
const { RetryableError } = await import("../integrations/outbound");
const { ReplyHolds } = await import("../services/replyHolds");

type Cfg = Parameters<typeof createIntegrations>[0];
const statusOf = (body: object) => ({ status: async () => body }) as never;
const registry = (cfg: Cfg, linear = {}, github = {}) =>
  createIntegrations(cfg, {} as never, statusOf(linear), statusOf(github));

describe("createIntegrations", () => {
  it("enables each integration from its own setting", () => {
    const enabled = (cfg: Cfg) =>
      Object.fromEntries(Object.values(registry(cfg)).map((i) => [i.name, i.enabled]));
    const off = { api: { enabled: false }, github: {}, gitlab: { ciResultEnabled: true } };
    const allOff = { linear: false, api: false, github: false, gitlab: false };
    expect(enabled(off)).toEqual(allOff);
    expect(enabled({ ...off, linear: {} })).toEqual({ ...allOff, linear: true });
    expect(enabled({ ...off, api: { enabled: true } })).toEqual({ ...allOff, api: true });
    expect(enabled({ ...off, github: { webhooks: {} } })).toEqual({ ...allOff, github: true });
    expect(
      enabled({ ...off, gitlab: { webhooks: { botUsername: "bot" }, ciResultEnabled: true } }),
    ).toEqual({ ...allOff, gitlab: true });
  });
});

describe("statusesWithHolds", () => {
  afterEach(() => {
    setSystemTime();
  });

  it("adds each integration's held sends to its own status body", async () => {
    const T0 = new Date("2026-10-30T12:00:00Z").getTime();
    const holds = new ReplyHolds();
    setSystemTime(new Date(T0));
    holds.hold("t1", { inbox_id: "i1", seq: 1 }, "github", new RetryableError("HTTP 429"));
    setSystemTime(new Date(T0 + 4_000));
    holds.hold("t2", { inbox_id: "i2", seq: 3 }, "github", new RetryableError("HTTP 429"));
    setSystemTime(new Date(T0 + 5_000));
    const linear = { configured: true, lastWebhookAt: null, lastTokenError: null };
    const github = { token: { ok: true }, webhooks: { enabled: true, lastWebhookAt: null } };

    const statuses = statusesWithHolds(
      registry(
        {
          linear: {},
          api: { enabled: true },
          github: { webhooks: {} },
          gitlab: { ciResultEnabled: false },
        },
        linear,
        github,
      ),
      holds,
    );

    const none = { heldTasks: 0, oldestHoldAgeMs: 0 };
    expect(await statuses.linear.status()).toEqual({ ...linear, holds: none });
    expect(await statuses.github.status()).toEqual({
      ...github,
      holds: { heldTasks: 2, oldestHoldAgeMs: 5_000 },
    });
    expect(await statuses.api.status()).toEqual({ enabled: true, holds: none });
    // GitLab off: no token configured (config is mocked empty), webhooks off.
    expect(await statuses.gitlab.status()).toEqual({
      token: { configured: false, source: null, readAt: null, lastError: null },
      webhooks: { enabled: false, lastWebhookAt: null, ciResults: false },
      holds: none,
    });
  });
});
