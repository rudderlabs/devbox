import { describe, expect, it } from "bun:test";
import { MemoryKeychain } from "../lib/keychain";
import { type Resolved, type ResolverDeps, SecretError } from "../lib/secrets";
import { CredentialRejected, type Fetch } from "../up/preflight";
import {
  checkJira,
  checkJiraBot,
  checkPermissions,
  cloudIdOf,
  JiraCheckError,
  jiraPreflight,
} from "./check";

const SITE = "https://example.atlassian.net";
const CLOUD = "00000000-0000-0000-0000-000000000000";
const BOT_ID = "712020:00000000-0000-0000-0000-000000000000";
const API = `https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3`;
const CFG = { cloudId: CLOUD, email: "devbox@example.com" };

type Req = { url: string; auth: string | null };

function fakeFetch(answer: (url: string) => Response | Error): { fetch: Fetch; requests: Req[] } {
  const requests: Req[] = [];
  const fetch: Fetch = async (url, init) => {
    requests.push({ url, auth: new Headers(init?.headers).get("authorization") });
    const a = answer(url);
    if (a instanceof Error) throw a;
    return a;
  };
  return { fetch, requests };
}

describe("cloudIdOf", () => {
  it("reads the cloud id from the site's tenant info", async () => {
    const f = fakeFetch(() => Response.json({ cloudId: CLOUD }));
    expect(await cloudIdOf(SITE, f.fetch)).toBe(CLOUD);
    expect(f.requests.map((r) => r.url)).toEqual([`${SITE}/_edge/tenant_info`]);
  });

  it("a site without one is not a Jira Cloud site", async () => {
    for (const answer of [
      () => new Response("Not Found", { status: 404 }),
      () => Response.json({ cloudId: "not-a-uuid" }),
      () => new Response("<html>"),
    ]) {
      await expect(cloudIdOf(SITE, fakeFetch(answer).fetch)).rejects.toThrow(
        `${SITE} is not a Jira Cloud site (no cloud id at /_edge/tenant_info): check the site URL`,
      );
    }
  });

  it("no answer", async () => {
    const f = fakeFetch(() => new TypeError("fetch failed"));
    await expect(cloudIdOf(SITE, f.fetch)).rejects.toThrow(
      new JiraCheckError(
        `can't reach ${SITE}: check the site URL and this machine's egress or proxy`,
      ),
    );
  });
});

describe("checkJira", () => {
  it("GET /myself through the gateway with Basic email:token", async () => {
    const f = fakeFetch(() =>
      Response.json({ accountId: BOT_ID, accountType: "app", displayName: "devbox" }),
    );
    expect(await checkJira(CFG, "tok", f.fetch)).toEqual({
      accountId: BOT_ID,
      displayName: "devbox",
    });
    const basic = `Basic ${Buffer.from("devbox@example.com:tok").toString("base64")}`;
    expect(f.requests).toEqual([{ url: `${API}/myself`, auth: basic }]);
  });

  it("401 is a rejected credential, naming the scopes, never the token", async () => {
    const f = fakeFetch(() => new Response("Unauthorized; scope does not match", { status: 401 }));
    const err = await checkJira(CFG, "secret-token", f.fetch).catch((e) => e);
    expect(err).toBeInstanceOf(CredentialRejected);
    expect(err.message).toBe(
      "Jira rejected JIRA_API_TOKEN, or the email devbox@example.com doesn't match it (401): use the service account's API token, with scopes read:jira-work, write:jira-work and read:jira-user, and the service account's email",
    );
    expect(err.message).not.toContain("secret-token");
  });

  it("another status, no account id, no answer", async () => {
    await expect(
      checkJira(CFG, "t", fakeFetch(() => new Response("", { status: 503 })).fetch),
    ).rejects.toThrow(new JiraCheckError("Jira check failed: GET /myself returned 503"));
    await expect(checkJira(CFG, "t", fakeFetch(() => Response.json({})).fetch)).rejects.toThrow(
      new JiraCheckError("Jira check failed: Jira GET /myself returned no accountId"),
    );
    await expect(
      checkJira(CFG, "t", fakeFetch(() => new TypeError("fetch failed")).fetch),
    ).rejects.toThrow(
      new JiraCheckError("can't reach api.atlassian.com: check this machine's egress or proxy"),
    );
  });
});

describe("checkPermissions", () => {
  const ALL = "BROWSE_PROJECTS%2CADD_COMMENTS%2CTRANSITION_ISSUES%2CLINK_ISSUES%2CASSIGNABLE_USER";

  it("asks once, without a project; nothing to say when every permission is held somewhere", async () => {
    const asked = (url: string) => new URL(url).searchParams.get("permissions")?.split(",") ?? [];
    const f = fakeFetch((url) =>
      Response.json({
        permissions: Object.fromEntries(asked(url).map((p) => [p, { havePermission: true }])),
      }),
    );
    expect(await checkPermissions(CFG, "t", f.fetch)).toBeUndefined();
    expect(f.requests.map((r) => r.url)).toEqual([`${API}/mypermissions?permissions=${ALL}`]);
  });

  it("warns about a permission held in no project, or when they can't be read", async () => {
    const some = fakeFetch(() =>
      Response.json({
        permissions: {
          BROWSE_PROJECTS: { havePermission: true },
          ADD_COMMENTS: { havePermission: true },
          TRANSITION_ISSUES: { havePermission: false },
        },
      }),
    );
    expect(await checkPermissions(CFG, "t", some.fetch)).toBe(
      "warning: the bot lacks TRANSITION_ISSUES, LINK_ISSUES, ASSIGNABLE_USER (needed to assign issues to the bot) in every project: give the service account a role that has them in each project devbox works in",
    );
    const refused = fakeFetch(() => new Response("", { status: 403 }));
    expect(await checkPermissions(CFG, "t", refused.fetch)).toBe(
      "warning: can't check the bot's permissions: HTTP 403",
    );
    const down = fakeFetch(() => new TypeError("fetch failed"));
    expect(await checkPermissions(CFG, "t", down.fetch)).toBe(
      "warning: can't check the bot's permissions: can't reach api.atlassian.com: check this machine's egress or proxy",
    );
  });
});

describe("checkJiraBot and jiraPreflight", () => {
  const JIRA = {
    enabled: true as const,
    siteUrl: SITE,
    cloudId: CLOUD,
    botEmail: "devbox@example.com",
    botAccountId: BOT_ID,
    botName: "devbox",
  };
  // /myself answers for "jira-token" as `accountId`, and 401 for anything else.
  const jiraFetch = (accountId = BOT_ID) =>
    fakeFetch((url) =>
      url.endsWith("/myself")
        ? Response.json({ accountId, accountType: "app", displayName: "devbox" })
        : new Response("", { status: 599 }),
    );
  const credentials = (auth: string | null) =>
    Buffer.from((auth ?? "").replace(/^Basic /, ""), "base64")
      .toString()
      .split(":");
  // 401 unless both the email and the token are the bot's.
  const gated: Fetch = async (url, init) => {
    const [email, token] = credentials(new Headers(init?.headers).get("authorization"));
    return email === "devbox@example.com" && token === "jira-token"
      ? jiraFetch().fetch(url, init)
      : new Response("Unauthorized", { status: 401 });
  };

  function resolver(o: { isTTY?: boolean; hidden?: string[]; saved?: Record<string, string> }) {
    const log: string[] = [];
    const asked: string[] = [];
    const hidden = [...(o.hidden ?? [])];
    const keychain = new MemoryKeychain(o.saved);
    const deps: ResolverDeps = {
      env: {},
      keychain,
      deployment: { kind: "compose" },
      isTTY: o.isTTY ?? true,
      prompt: async (q) => {
        asked.push(q);
        return hidden.shift() ?? "";
      },
      confirm: async (q) => {
        asked.push(q);
        return true;
      },
      run: async () => ({ code: 1, stdout: "" }),
      log: (l) => log.push(l),
    };
    return { deps, log, asked, keychain };
  }
  const secrets = (source: Resolved["source"], token = "jira-token") => ({
    token: { name: "JIRA_API_TOKEN" as const, value: token, source },
    webhook: { name: "JIRA_WEBHOOK_SECRET" as const, value: "whs", source },
  });

  it("a token of another account is refused, naming both", async () => {
    await expect(
      checkJiraBot(
        JIRA,
        "jira-token",
        jiraFetch("712020:other").fetch,
        "bun run jira:setup --target t.json",
      ),
    ).rejects.toThrow(
      new JiraCheckError(
        `JIRA_API_TOKEN belongs to devbox (712020:other), not the configured bot devbox (${BOT_ID}): run bun run jira:setup --target t.json`,
      ),
    );
  });

  it("checks the token, then offers to save both typed secrets", async () => {
    const r = resolver({});
    const out = await jiraPreflight(JIRA, secrets("prompt"), r.deps, {
      skip: false,
      fetch: gated,
    });
    expect(out?.token.value).toBe("jira-token");
    expect(r.log).toEqual([`Jira: devbox acts as devbox on ${SITE}`]);
    expect(r.asked).toEqual([
      "Save JIRA_API_TOKEN to the system keychain for compose? [Y/n] ",
      "Save JIRA_WEBHOOK_SECRET to the system keychain for compose? [Y/n] ",
    ]);
    expect(r.keychain.entries()).toEqual({
      "compose/JIRA_API_TOKEN": "jira-token",
      "compose/JIRA_WEBHOOK_SECRET": "whs",
    });
  });

  it("a rejected saved token is kept and asked for again; without a terminal a 401 stops", async () => {
    const r = resolver({ hidden: ["jira-token"], saved: { "compose/JIRA_API_TOKEN": "old" } });
    const out = await jiraPreflight(JIRA, secrets("keychain", "old"), r.deps, {
      skip: false,
      fetch: gated,
    });
    expect(out?.token).toEqual({ name: "JIRA_API_TOKEN", value: "jira-token", source: "prompt" });
    expect(r.log[0]).toBe("The saved JIRA_API_TOKEN for compose was rejected; keeping it");

    const headless = resolver({ isTTY: false, saved: { "compose/JIRA_API_TOKEN": "old" } });
    await expect(
      jiraPreflight(JIRA, secrets("keychain", "old"), headless.deps, {
        skip: false,
        fetch: gated,
      }),
    ).rejects.toBeInstanceOf(CredentialRejected);
    expect(headless.keychain.entries()).toEqual({ "compose/JIRA_API_TOKEN": "old" });
  });

  it("a wrong email with a good saved token: the token stays saved", async () => {
    const saved = { "compose/JIRA_API_TOKEN": "jira-token" };
    const r = resolver({ hidden: [""], saved });
    const typo = { ...JIRA, botEmail: "typo@example.com" };
    await expect(
      jiraPreflight(typo, secrets("keychain"), r.deps, { skip: false, fetch: gated }),
    ).rejects.toBeInstanceOf(SecretError);
    expect(r.log).toEqual([
      "The saved JIRA_API_TOKEN for compose was rejected; keeping it",
      "Jira rejected JIRA_API_TOKEN, or the email typo@example.com doesn't match it (401): use the service account's API token, with scopes read:jira-work, write:jira-work and read:jira-user, and the service account's email",
      "Enter JIRA_API_TOKEN again, or press Enter on an empty value to exit.",
    ]);
    expect(r.keychain.entries()).toEqual(saved);
  });

  it("checks only the token", async () => {
    const r = resolver({ isTTY: false });
    const f = jiraFetch();
    await jiraPreflight(JIRA, secrets("env"), r.deps, { skip: false, fetch: f.fetch });
    expect(f.requests.map((q) => q.url)).toEqual([`${API}/myself`]);
    expect(r.log).toEqual([`Jira: devbox acts as devbox on ${SITE}`]);
  });

  it("skipped: no call to Jira", async () => {
    const r = resolver({ isTTY: false });
    const f = jiraFetch();
    const out = await jiraPreflight(JIRA, secrets("env", "anything"), r.deps, {
      skip: true,
      fetch: f.fetch,
    });
    expect(out?.token.value).toBe("anything");
    expect(f.requests).toEqual([]);
    expect(r.log).toEqual([]);
  });

  it("the user's own Secret: nothing to check", async () => {
    const r = resolver({});
    const f = jiraFetch();
    const out = await jiraPreflight(JIRA, undefined, r.deps, { skip: false, fetch: f.fetch });
    expect(out).toBeUndefined();
    expect(f.requests).toEqual([]);
    expect(r.log).toEqual([]);
  });
});
