import { describe, expect, it } from "bun:test";
import { HttpError } from "../../http";
import type { JiraGroup } from "../client";
import { errorClass, JiraTrust, TRUST_RETRY_MS, TRUST_TTL_MS } from "../trust";

// Synthetic account ids.
const MEMBER = "5c3e2f1a9b8d7c6e5f4a3b21";
const OUTSIDER = "5d4c3b2a1f0e9d8c7b6a5f43";
const LISTED = "5a1b2c3d4e5f6a7b8c9d0e1f";

const group = (name: string): JiraGroup => ({ name, groupId: null });

// A trust cache on a hand-driven clock. `answer` decides each lookup.
function setup(
  answer: (accountId: string) => Promise<JiraGroup[]> = async (id) =>
    id === MEMBER ? [group("jira-users"), group("Developers")] : [group("jira-users")],
  cfg = { trustedUsers: [LISTED], trustedGroups: ["developers"] },
) {
  const clock = { t: 1_000_000 };
  const lookups: string[] = [];
  const warnings: unknown[][] = [];
  const log = { warn: (...args: unknown[]) => warnings.push(args) } as never;
  const trust = new JiraTrust(
    cfg,
    (id) => {
      lookups.push(id);
      return answer(id);
    },
    log,
    () => clock.t,
  );
  return { trust, clock, lookups, warnings };
}

const failing = async (): Promise<JiraGroup[]> => {
  throw new HttpError("Jira GET /user/groups failed: HTTP 503 upstream says hello", 503);
};

describe("JiraTrust", () => {
  it("trusts a listed account without a lookup, and a group member by name in any case", async () => {
    const { trust, lookups } = setup();
    expect(await trust.check({ accountId: LISTED })).toBe(true);
    expect(lookups).toEqual([]);
    expect(await trust.check({ accountId: MEMBER, accountType: "atlassian" })).toBe(true);
    expect(await trust.check({ accountId: OUTSIDER })).toBe(false);
    expect(lookups).toEqual([MEMBER, OUTSIDER]);
  });

  it("never trusts app or customer accounts, even listed ones", async () => {
    const { trust, lookups } = setup();
    expect(await trust.check({ accountId: LISTED, accountType: "app" })).toBe(false);
    expect(await trust.check({ accountId: MEMBER, accountType: "customer" })).toBe(false);
    expect(lookups).toEqual([]);
  });

  it("looks nothing up when only users are trusted", async () => {
    const { trust, lookups } = setup(undefined, { trustedUsers: [LISTED], trustedGroups: [] });
    expect(await trust.check({ accountId: MEMBER })).toBe(false);
    expect(lookups).toEqual([]);
  });

  it("serves an answer for the TTL, then looks it up again", async () => {
    const { trust, clock, lookups } = setup();
    await trust.check({ accountId: MEMBER });
    clock.t += TRUST_TTL_MS - 1;
    expect(await trust.check({ accountId: MEMBER })).toBe(true);
    expect(lookups).toHaveLength(1);
    clock.t += 1;
    expect(await trust.check({ accountId: MEMBER })).toBe(true);
    expect(lookups).toHaveLength(2);
  });

  it("is unresolved without an answer, and retries at most once a minute", async () => {
    const { trust, clock, lookups, warnings } = setup(failing);
    expect(await trust.check({ accountId: MEMBER })).toBe("unresolved");
    // The account id and the failure's class only, never upstream text.
    expect(warnings).toEqual([
      ["jira trust lookup failed", { accountId: MEMBER, error: "http_503" }],
    ]);
    clock.t += TRUST_RETRY_MS - 1;
    expect(await trust.check({ accountId: MEMBER })).toBe("unresolved");
    expect(lookups).toHaveLength(1);
    clock.t += 1;
    expect(await trust.check({ accountId: MEMBER })).toBe("unresolved");
    expect(lookups).toHaveLength(2);
  });

  it("keeps the last answer for one more TTL while lookups fail", async () => {
    let fail = false;
    const { trust, clock, lookups } = setup(async () => {
      if (fail) throw new Error("connection reset");
      return [group("developers")];
    });
    await trust.check({ accountId: MEMBER });
    fail = true;
    clock.t += TRUST_TTL_MS;
    expect(await trust.check({ accountId: MEMBER })).toBe(true);
    expect(lookups).toHaveLength(2);
    clock.t += TRUST_TTL_MS - 1;
    expect(await trust.check({ accountId: MEMBER })).toBe(true);
    expect(lookups).toHaveLength(3);
    clock.t += TRUST_RETRY_MS;
    expect(await trust.check({ accountId: MEMBER })).toBe("unresolved");
    // A success replaces the answer and starts a fresh TTL.
    fail = false;
    clock.t += TRUST_RETRY_MS;
    expect(await trust.check({ accountId: MEMBER })).toBe(true);
    clock.t += TRUST_TTL_MS - 1;
    expect(await trust.check({ accountId: MEMBER })).toBe(true);
    expect(lookups).toHaveLength(5);
  });

  it("shares one lookup between concurrent checks of an account", async () => {
    let release!: (groups: JiraGroup[]) => void;
    const { trust, lookups } = setup(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const both = Promise.all([
      trust.check({ accountId: MEMBER }),
      trust.check({ accountId: MEMBER }),
    ]);
    release([group("developers")]);
    expect(await both).toEqual([true, true]);
    expect(lookups).toEqual([MEMBER]);
  });

  it("reports its source, cached accounts and the last error's class only", async () => {
    let fail = true;
    const { trust, clock } = setup(async () => {
      if (fail) return failing();
      return [];
    });
    await trust.check({ accountId: MEMBER });
    expect(trust.status()).toEqual({
      source: "groups+users",
      cachedAccounts: 0,
      lastError: "http_503",
    });
    fail = false;
    clock.t += TRUST_RETRY_MS;
    await trust.check({ accountId: MEMBER });
    expect(trust.status()).toEqual({ source: "groups+users", cachedAccounts: 1 });
    expect(setup(undefined, { trustedUsers: [], trustedGroups: ["g"] }).trust.status().source).toBe(
      "groups",
    );
  });
});

describe("errorClass", () => {
  it("names the failure without its text", () => {
    expect(errorClass(new HttpError("HTTP 401 body", 401))).toBe("http_401");
    expect(errorClass(new Error("timed out after 3000 ms"))).toBe("timeout");
    expect(errorClass(Object.assign(new TypeError("x"), { code: "ECONNREFUSED" }))).toBe(
      "ECONNREFUSED",
    );
    expect(errorClass(new RangeError("whatever"))).toBe("RangeError");
    expect(errorClass("a string")).toBe("unknown");
  });
});
