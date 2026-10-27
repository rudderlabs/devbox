import { describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { GithubAppError } from "../../src/githubToken/mint";
import { AppApiError, appApi } from "./appApi";

const { privateKey: PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const BASE = "https://api.example.com";
const KEY = { appId: 123, pem: PEM };
const NOW = new Date("2026-10-19T12:00:00Z");

type Call = { url: string; method: string; auth: string | null; body: unknown };

function fake(answers: Response[], now: () => Date = () => NOW) {
  const calls: Call[] = [];
  const api = appApi({
    apiBase: BASE,
    now,
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        auth: headers.get("authorization"),
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      const next = answers.shift();
      if (!next) throw new Error("no answer left");
      return next;
    },
  });
  return { api, calls };
}

const claims = (auth: string | null): unknown => {
  const [, payload] = (auth ?? "").replace(/^Bearer /, "").split(".");
  return JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8"));
};

const CONVERSION = {
  id: 123,
  slug: "example-devbox",
  pem: "-----BEGIN RSA PRIVATE KEY-----\nsecret-key\n-----END RSA PRIVATE KEY-----\n",
  webhook_secret: "whsec-1",
  html_url: "https://github.com/apps/example-devbox",
  owner: { login: "example-org", type: "Organization", id: 9 },
  client_secret: "not-used",
};

describe("convertManifest", () => {
  it("posts the code without credentials and returns the App", async () => {
    const { api, calls } = fake([Response.json(CONVERSION, { status: 201 })]);
    expect(await api.convertManifest("code-1")).toEqual({
      id: 123,
      slug: "example-devbox",
      pem: CONVERSION.pem,
      webhookSecret: "whsec-1",
      htmlUrl: "https://github.com/apps/example-devbox",
      owner: { login: "example-org", type: "Organization" },
    });
    expect(calls).toEqual([
      {
        url: `${BASE}/app-manifests/code-1/conversions`,
        method: "POST",
        auth: null,
        body: undefined,
      },
    ]);
  });

  it("a null webhook secret stays null", async () => {
    const { api } = fake([Response.json({ ...CONVERSION, webhook_secret: null }, { status: 201 })]);
    expect((await api.convertManifest("c")).webhookSecret).toBeNull();
  });

  it("a refusal names the status only, never the body", async () => {
    const { api } = fake([Response.json({ message: "Not Found", pem: "leak" }, { status: 404 })]);
    const err = await api.convertManifest("c").catch((e: unknown) => e);
    expect(err).toEqual(
      new AppApiError(
        "GitHub didn't create the App from its manifest (HTTP 404): run bun run github:setup again",
      ),
    );
  });

  it("an answer without the key: the missing field is named, the body is not", async () => {
    const { api } = fake([Response.json({ ...CONVERSION, pem: undefined }, { status: 201 })]);
    const err = await api.convertManifest("c").catch((e: unknown) => e);
    expect(err).toEqual(
      new AppApiError(
        "GitHub's answer for the new App has no usable pem: run bun run github:setup again",
      ),
    );
    expect(String((err as Error).message)).not.toContain("whsec-1");
  });

  it("an answer that is not JSON: no part of it in the message", async () => {
    const { api } = fake([new Response(`{"pem":"${"x".repeat(10)}`, { status: 201 })]);
    const err = await api.convertManifest("c").catch((e: unknown) => e);
    expect(err).toEqual(
      new AppApiError(
        "GitHub's answer for the new App is not JSON: run bun run github:setup again",
      ),
    );
  });
});

describe("JWT calls", () => {
  it("listInstallations: signs every call afresh", async () => {
    let t = NOW.getTime();
    const page = [
      { id: 7, account: { login: "example-org", type: "Organization" }, app_id: 123 },
      { id: 8, account: { login: "example-user", type: "User" } },
    ];
    const { api, calls } = fake([Response.json(page), Response.json([])], () => new Date(t));
    expect(await api.listInstallations(KEY)).toEqual([
      { id: 7, account: { login: "example-org", type: "Organization" } },
      { id: 8, account: { login: "example-user", type: "User" } },
    ]);
    t += 20 * 60_000;
    expect(await api.listInstallations(KEY)).toEqual([]);
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ["GET", `${BASE}/app/installations?per_page=100&page=1`],
      ["GET", `${BASE}/app/installations?per_page=100&page=1`],
    ]);
    const seconds = NOW.getTime() / 1000;
    expect(claims(calls[0]?.auth ?? null)).toEqual({
      iat: seconds - 60,
      exp: seconds + 540,
      iss: "123",
    });
    expect(claims(calls[1]?.auth ?? null)).toEqual({
      iat: seconds + 1200 - 60,
      exp: seconds + 1200 + 540,
      iss: "123",
    });
  });

  it("listInstallations: follows the pages until one is short", async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      account: { login: `user-${i + 1}`, type: "User" },
    }));
    const { api, calls } = fake([
      Response.json(full),
      Response.json([{ id: 101, account: { login: "example-org", type: "Organization" } }]),
    ]);
    const all = await api.listInstallations(KEY);
    expect(all).toEqual([
      ...full,
      { id: 101, account: { login: "example-org", type: "Organization" } },
    ]);
    expect(calls.map((c) => c.url)).toEqual([
      `${BASE}/app/installations?per_page=100&page=1`,
      `${BASE}/app/installations?per_page=100&page=2`,
    ]);
  });

  it("listInstallations: a refusal is GitHub's error", async () => {
    const { api } = fake([Response.json({ message: "Bad credentials" }, { status: 401 })]);
    const err = await api.listInstallations(KEY).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GithubAppError);
    expect((err as GithubAppError).status).toBe(401);
  });

  it("updateHookConfig sends only the given fields", async () => {
    const { api, calls } = fake([Response.json({}), Response.json({})]);
    await api.updateHookConfig(KEY, { secret: "s" });
    await api.updateHookConfig(KEY, {
      url: "https://hooks.example.com/webhook/github",
      secret: "t",
    });
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ["PATCH", `${BASE}/app/hook/config`, { secret: "s" }],
      [
        "PATCH",
        `${BASE}/app/hook/config`,
        { url: "https://hooks.example.com/webhook/github", secret: "t" },
      ],
    ]);
    expect(calls.every((c) => c.auth?.startsWith("Bearer ey"))).toBe(true);
  });
});

describe("getBotUserId", () => {
  it("looks up <slug>[bot] without credentials", async () => {
    const { api, calls } = fake([Response.json({ id: 1234567, login: "example-devbox[bot]" })]);
    expect(await api.getBotUserId("example-devbox")).toBe(1234567);
    expect(calls).toEqual([
      { url: `${BASE}/users/example-devbox%5Bbot%5D`, method: "GET", auth: null, body: undefined },
    ]);
  });

  it("an answer without an id", async () => {
    const { api } = fake([Response.json({ login: "x" })]);
    expect(await api.getBotUserId("example-devbox").catch((e: unknown) => e)).toEqual(
      new AppApiError("GitHub has no user id for example-devbox[bot]"),
    );
  });
});
