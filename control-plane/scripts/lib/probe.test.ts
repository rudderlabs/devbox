import { describe, expect, it } from "bun:test";
import type { Fetch } from "../up/preflight";
import { type ProbeResult, probeWebhook } from "./probe";

const PUBLIC = "https://hooks.example.com";
const HOOK = "https://hooks.example.com/webhook/linear";
const GITHUB_HOOK = "https://hooks.example.com/webhook/github";
const NO_ANSWER =
  "the public URL does not reach devbox. Is the tunnel down, or the Ingress or DNS not ready yet?";

type Req = { url: string; init: RequestInit | undefined };

function fakeFetch(answer: (() => Response) | Error): { fetch: Fetch; requests: Req[] } {
  const requests: Req[] = [];
  const fetch: Fetch = async (url, init) => {
    requests.push({ url, init });
    if (answer instanceof Error) throw answer;
    return answer();
  };
  return { fetch, requests };
}

const probe = (
  answer: (() => Response) | Error,
  opts: { fromApiIngress: boolean } = { fromApiIngress: false },
): Promise<ProbeResult> =>
  probeWebhook(PUBLIC, "/webhook/linear", fakeFetch(answer).fetch, {
    ...opts,
    integration: "Linear",
  });

describe("probeWebhook", () => {
  it("401 invalid signature is ok", async () => {
    expect(
      await probe(() => Response.json({ error: "invalid signature" }, { status: 401 })),
    ).toEqual({ ok: true });
  });

  it("401 with another body is not ok", async () => {
    expect(await probe(() => Response.json({ error: "denied" }, { status: 401 }))).toEqual({
      ok: false,
      message: `the webhook URL ${HOOK} got 401: {"error":"denied"}`,
    });
  });

  it("401 with a non-JSON body is not ok", async () => {
    expect(await probe(() => new Response("Unauthorized", { status: 401 }))).toEqual({
      ok: false,
      message: `the webhook URL ${HOOK} got 401: Unauthorized`,
    });
  });

  it("404", async () => {
    expect(await probe(() => new Response("404 Not Found", { status: 404 }))).toEqual({
      ok: false,
      message: `the webhook URL ${HOOK} got 404: something answered, but not devbox with Linear on. Check that the tunnel or proxy forwards to the control plane (port 3000 on Compose), that integrations.linear.enabled is true and applied, or restart the control plane`,
    });
  });

  it("GitHub: probes /webhook/github and names integrations.githubApp.enabled on 404", async () => {
    const ok = fakeFetch(() => Response.json({ error: "invalid signature" }, { status: 401 }));
    const opts = { fromApiIngress: false, integration: "GitHub" } as const;
    expect(await probeWebhook(PUBLIC, "/webhook/github", ok.fetch, opts)).toEqual({ ok: true });
    expect(ok.requests.map((r) => r.url)).toEqual([GITHUB_HOOK]);
    const missing = fakeFetch(() => new Response("404 Not Found", { status: 404 }));
    expect(await probeWebhook(PUBLIC, "/webhook/github", missing.fetch, opts)).toEqual({
      ok: false,
      message: `the webhook URL ${GITHUB_HOOK} got 404: something answered, but not devbox with GitHub on. Check that the tunnel or proxy forwards to the control plane (port 3000 on Compose), that integrations.githubApp.enabled is true and applied, or restart the control plane`,
    });
  });

  it("no answer", async () => {
    expect(await probe(new Error("getaddrinfo ENOTFOUND hooks.example.com"))).toEqual({
      ok: false,
      message: `the webhook URL ${HOOK} got no answer (getaddrinfo ENOTFOUND hooks.example.com): ${NO_ANSWER}`,
    });
  });

  it("no answer from an api-Ingress URL adds the VPN hint", async () => {
    expect(await probe(new Error("connect ETIMEDOUT"), { fromApiIngress: true })).toEqual({
      ok: false,
      message: `the webhook URL ${HOOK} got no answer (connect ETIMEDOUT): ${NO_ANSWER} The URL comes from ingress.api, which may be reachable only over a VPN: enable a public ingress.webhooks in the target file`,
    });
  });

  it("timeout", async () => {
    expect(await probe(new DOMException("The operation timed out.", "TimeoutError"))).toEqual({
      ok: false,
      message: `the webhook URL ${HOOK} got no answer (no answer within 10s): ${NO_ANSWER}`,
    });
  });

  it("500 with a 600-character body is truncated", async () => {
    expect(await probe(() => new Response("x".repeat(600), { status: 500 }))).toEqual({
      ok: false,
      message: `the webhook URL ${HOOK} got 500: ${"x".repeat(300)}…`,
    });
  });

  it("sends no signature", async () => {
    const { fetch, requests } = fakeFetch(() =>
      Response.json({ error: "invalid signature" }, { status: 401 }),
    );
    await probeWebhook(PUBLIC, "/webhook/linear", fetch, {
      fromApiIngress: false,
      integration: "Linear",
    });
    expect(requests).toHaveLength(1);
    const [req] = requests;
    expect(req?.url).toBe(HOOK);
    expect(req?.init?.method).toBe("POST");
    expect(req?.init?.body).toBe("{}");
    expect(Object.fromEntries(new Headers(req?.init?.headers).entries())).toEqual({
      "content-type": "application/json",
    });
    expect(req?.init?.signal).toBeInstanceOf(AbortSignal);
  });
});
