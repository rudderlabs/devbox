import { describe, expect, it } from "bun:test";
import { GithubStatusService } from "../githubStatus.service";

const TOKEN = {
  source: "file" as const,
  expiresAt: "2026-10-19T12:31:00Z",
  readAt: "2026-10-19T11:32:10.000Z",
  lastError: null,
};

describe("GithubStatusService", () => {
  it("reports the token state and the webhook state when webhooks are on", () => {
    const service = new GithubStatusService(() => TOKEN, {
      enabled: true,
      ciResults: true,
      lastWebhookAt: () => "2026-10-19T11:20:02.000Z",
    });
    expect(service.status()).toEqual({
      token: TOKEN,
      webhooks: { enabled: true, lastWebhookAt: "2026-10-19T11:20:02.000Z", ciResults: true },
    });
  });

  it("reports a webhook that has not seen a delivery yet", () => {
    const service = new GithubStatusService(() => TOKEN, {
      enabled: true,
      ciResults: false,
      lastWebhookAt: () => null,
    });
    expect(service.status().webhooks).toEqual({
      enabled: true,
      lastWebhookAt: null,
      ciResults: false,
    });
  });

  it("reports webhooks off as all-false even when CI results are configured", () => {
    const service = new GithubStatusService(
      () => ({ source: "env", expiresAt: null, readAt: null, lastError: null }),
      { enabled: false, ciResults: true, lastWebhookAt: () => "ignored" },
    );
    expect(service.status()).toEqual({
      token: { source: "env", expiresAt: null, readAt: null, lastError: null },
      webhooks: { enabled: false, lastWebhookAt: null, ciResults: false },
    });
  });

  it("passes a token read error through", () => {
    const service = new GithubStatusService(() => ({ ...TOKEN, lastError: "EIO" }), {
      enabled: false,
      ciResults: false,
      lastWebhookAt: () => null,
    });
    expect(service.status().token.lastError).toBe("EIO");
  });
});
