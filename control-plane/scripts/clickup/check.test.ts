import { describe, expect, it } from "bun:test";
import { MemoryKeychain } from "../lib/keychain";
import type { Resolved, ResolverDeps } from "../lib/secrets";
import { CredentialRejected, type Fetch } from "../up/preflight";
import { ClickupCheckError, checkClickup, checkClickupBot, clickupPreflight } from "./check";

const API = "https://api.clickup.com/api/v2";
const BOT_ID = 100000001;
const CLICKUP = {
  enabled: true as const,
  teamId: "9000000000",
  botUserId: BOT_ID,
  botName: "devbox",
};

type Req = { url: string; auth: string | null };

// GET /user answers for "pk_bot" as `id`, and 401 for any other token.
function fakeFetch(answer?: (url: string) => Response | Error, id = BOT_ID) {
  const requests: Req[] = [];
  const fetch: Fetch = async (url, init) => {
    const auth = new Headers(init?.headers).get("authorization");
    requests.push({ url, auth });
    const a = answer
      ? answer(url)
      : auth === "pk_bot"
        ? Response.json({ user: { id, username: "devbox", email: "bot@example.com" } })
        : Response.json({ err: "Token invalid" }, { status: 401 });
    if (a instanceof Error) throw a;
    return a;
  };
  return { fetch, requests };
}

describe("checkClickup", () => {
  it("GET /user with the token as it is, no Bearer", async () => {
    const f = fakeFetch();
    expect(await checkClickup("pk_bot", f.fetch)).toEqual({ id: BOT_ID, username: "devbox" });
    expect(f.requests).toEqual([{ url: `${API}/user`, auth: "pk_bot" }]);
  });

  it("401 is a rejected credential, never naming the token", async () => {
    const err = await checkClickup("pk_secret", fakeFetch().fetch).catch((e) => e);
    expect(err).toBeInstanceOf(CredentialRejected);
    expect(err.message).toBe(
      "ClickUp rejected CLICKUP_API_TOKEN (401): use the bot's personal API token (pk_…), from ClickUp's Settings → Apps while signed in as the bot",
    );
    expect(err.message).not.toContain("pk_secret");
  });

  it("another status, no user id, no answer", async () => {
    await expect(
      checkClickup("t", fakeFetch(() => new Response("", { status: 503 })).fetch),
    ).rejects.toThrow(new ClickupCheckError("ClickUp GET /user returned 503"));
    await expect(checkClickup("t", fakeFetch(() => Response.json({})).fetch)).rejects.toThrow(
      new ClickupCheckError("ClickUp GET /user returned no user id"),
    );
    await expect(
      checkClickup("t", fakeFetch(() => new TypeError("fetch failed")).fetch),
    ).rejects.toThrow(
      new ClickupCheckError("can't reach api.clickup.com: check this machine's egress or proxy"),
    );
  });
});

describe("checkClickupBot and clickupPreflight", () => {
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
  const secrets = (source: Resolved["source"], token = "pk_bot") => ({
    token: { name: "CLICKUP_API_TOKEN" as const, value: token, source },
    webhook: { name: "CLICKUP_WEBHOOK_SECRET" as const, value: "whs", source },
  });

  it("a token of another account is refused, naming both", async () => {
    await expect(
      checkClickupBot(
        CLICKUP,
        "pk_bot",
        fakeFetch(undefined, 7).fetch,
        "bun run clickup:setup --target t.json",
      ),
    ).rejects.toThrow(
      new ClickupCheckError(
        `CLICKUP_API_TOKEN belongs to devbox (user 7), not the configured bot devbox (user ${BOT_ID}): run bun run clickup:setup --target t.json`,
      ),
    );
  });

  it("checks the token, then offers to save both typed secrets", async () => {
    const r = resolver({});
    const f = fakeFetch();
    const out = await clickupPreflight(CLICKUP, secrets("prompt"), r.deps, {
      skip: false,
      fetch: f.fetch,
    });
    expect(out?.token.value).toBe("pk_bot");
    expect(f.requests.map((q) => q.url)).toEqual([`${API}/user`]);
    expect(r.log).toEqual(["ClickUp: devbox acts as devbox in workspace 9000000000"]);
    expect(r.keychain.entries()).toEqual({
      "compose/CLICKUP_API_TOKEN": "pk_bot",
      "compose/CLICKUP_WEBHOOK_SECRET": "whs",
    });
  });

  it("a rejected saved token is kept and asked for again; without a terminal a 401 stops", async () => {
    const r = resolver({ hidden: ["pk_bot"], saved: { "compose/CLICKUP_API_TOKEN": "pk_old" } });
    const out = await clickupPreflight(CLICKUP, secrets("keychain", "pk_old"), r.deps, {
      skip: false,
      fetch: fakeFetch().fetch,
    });
    expect(out?.token).toEqual({ name: "CLICKUP_API_TOKEN", value: "pk_bot", source: "prompt" });
    expect(r.log[0]).toBe("The saved CLICKUP_API_TOKEN for compose was rejected; keeping it");
    expect(r.asked[0]).toBe("ClickUp API token of the bot (pk_…) (input hidden): ");

    const headless = resolver({ isTTY: false, saved: { "compose/CLICKUP_API_TOKEN": "pk_old" } });
    await expect(
      clickupPreflight(CLICKUP, secrets("keychain", "pk_old"), headless.deps, {
        skip: false,
        fetch: fakeFetch().fetch,
      }),
    ).rejects.toBeInstanceOf(CredentialRejected);
    expect(headless.keychain.entries()).toEqual({ "compose/CLICKUP_API_TOKEN": "pk_old" });
  });

  it("skipped: no call to ClickUp; the user's own Secret: nothing to check", async () => {
    const r = resolver({ isTTY: false });
    const f = fakeFetch();
    const out = await clickupPreflight(CLICKUP, secrets("env", "anything"), r.deps, {
      skip: true,
      fetch: f.fetch,
    });
    expect(out?.token.value).toBe("anything");
    expect(
      await clickupPreflight(CLICKUP, undefined, r.deps, { skip: false, fetch: f.fetch }),
    ).toBeUndefined();
    expect(f.requests).toEqual([]);
    expect(r.log).toEqual([]);
  });
});
