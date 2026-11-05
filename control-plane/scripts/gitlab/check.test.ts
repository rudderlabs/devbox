import { describe, expect, it } from "bun:test";
import type { RepoConfig } from "../up/config";
import { CredentialRejected, type Fetch } from "../up/preflight";
import { checkGitlab, GitlabCheckError, versionAtLeast } from "./check";

type Req = { method: string; url: string; headers: Record<string, string>; body?: unknown };

function fakeFetch(routes: Record<string, [number, unknown] | Error>): {
  fetch: Fetch;
  requests: Req[];
} {
  const requests: Req[] = [];
  const fetch: Fetch = async (url, init) => {
    const method = init?.method ?? "GET";
    requests.push({
      method,
      url: String(url),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    const route = routes[`${method} ${url}`];
    if (route instanceof Error) throw route;
    if (!route) return new Response("not routed", { status: 599 });
    return typeof route[1] === "string"
      ? new Response(route[1], { status: route[0] })
      : Response.json(route[1], { status: route[0] });
  };
  return { fetch, requests };
}

const BASE = "https://gitlab.example.com";
const instance = { baseUrl: BASE };
const api = (repo: string, rest = "") =>
  `${BASE}/api/v4/projects/${encodeURIComponent(repo)}${rest}`;
const REPO: RepoConfig = {
  url: `${BASE}/platform/backend/api.git`,
  branch: "main",
  host: "gitlab",
  owner: "platform/backend",
  name: "api",
};
const VERSION = `GET ${BASE}/api/v4/version`;
const USER = `GET ${BASE}/api/v4/user`;
const PROJECT = `GET ${api("platform/backend/api")}`;
const PUSH = `GET ${BASE}/platform/backend/api.git/info/refs?service=git-receive-pack`;
const MRS = `POST ${api("platform/backend/api", "/merge_requests")}`;
const PIPELINES = `GET ${api("platform/backend/api", "/pipelines?per_page=1")}`;
const JOBS = `GET ${api("platform/backend/api", "/jobs?per_page=1")}`;
const MEMBERS = `GET ${BASE}/api/v4/groups/platform/members/all?per_page=1`;
const bot = { id: 2, username: "devbox", name: "devbox", bot: true };
const headName = () => "devbox-preflight-0123456789abcdef";

const writable = {
  [VERSION]: [200, { version: "19.5.3" }],
  [USER]: [200, bot],
  [PROJECT]: [200, { id: 1 }],
  [PUSH]: [200, "001f# service=git-receive-pack\n"],
  [MRS]: [400, { message: ["Source branch does not exist"] }],
} satisfies Record<string, [number, unknown]>;

describe("versionAtLeast", () => {
  it("compares major.minor.patch numerically", () => {
    expect(versionAtLeast("19.5.3", "19.1")).toBe(true);
    expect(versionAtLeast("19.1.0", "19.1")).toBe(true);
    expect(versionAtLeast("19.0.2", "19.1")).toBe(false);
    expect(versionAtLeast("18.11.0", "19.1")).toBe(false);
    expect(versionAtLeast("20.0.0-pre", "19.1")).toBe(true);
  });
});

describe("checkGitlab", () => {
  it("checks the instance, the token's user, each project's visibility, push and merge requests", async () => {
    const f = fakeFetch(writable);
    expect(await checkGitlab(instance, "glpat-t", [REPO], f.fetch, { headName })).toEqual({
      id: 2,
      username: "devbox",
      name: "devbox",
      bot: true,
      version: "19.5.3",
    });
    expect(f.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      VERSION,
      USER,
      PROJECT,
      PUSH,
      MRS,
    ]);
    expect(f.requests[0]?.headers.authorization).toBe("Bearer glpat-t");
    // git's push advertisement takes the token as a Basic password.
    expect(f.requests[3]?.headers.authorization).toBe(
      `Basic ${Buffer.from("oauth2:glpat-t").toString("base64")}`,
    );
    expect(f.requests[4]?.body).toEqual({
      source_branch: "devbox-preflight-0123456789abcdef",
      target_branch: "main",
      title: "devbox preflight check (never created)",
    });
  });

  it("a rejected token is a CredentialRejected", async () => {
    const f = fakeFetch({ [VERSION]: [401, { message: "401 Unauthorized" }] });
    await expect(checkGitlab(instance, "bad", [REPO], f.fetch)).rejects.toBeInstanceOf(
      CredentialRejected,
    );
  });

  it("an empty token stops before any request", async () => {
    const f = fakeFetch({});
    await expect(checkGitlab(instance, "", [REPO], f.fetch)).rejects.toThrow(
      "GITLAB_TOKEN is empty",
    );
    expect(f.requests).toEqual([]);
  });

  it("a TLS failure points at gitlab.caFile", async () => {
    const f = fakeFetch({ [VERSION]: new Error("unable to verify the first certificate") });
    await expect(checkGitlab(instance, "t", [REPO], f.fetch)).rejects.toThrow(
      "a private CA? set gitlab.caFile in devbox.config.json to its PEM",
    );
  });

  it("names a project the token cannot see", async () => {
    const f = fakeFetch({
      ...writable,
      [PROJECT]: [404, { message: "404 Project Not Found" }],
    });
    await expect(checkGitlab(instance, "t", [REPO], f.fetch)).rejects.toThrow(
      "platform/backend/api (repos[0]) does not exist or GITLAB_TOKEN cannot see it",
    );
  });

  it("names a token that cannot push, and the scope it needs", async () => {
    const f = fakeFetch({ ...writable, [PUSH]: [403, "Forbidden"] });
    await expect(checkGitlab(instance, "t", [REPO], f.fetch)).rejects.toThrow(
      "GITLAB_TOKEN cannot push to platform/backend/api (repos[0]): git's push endpoint returned 403: Forbidden; the token needs the write_repository scope",
    );
  });

  it("a fine-grained token's refusal names the permission to add", async () => {
    const f = fakeFetch({
      ...writable,
      [MRS]: [
        403,
        {
          error: "insufficient_granular_scope",
          error_description:
            "Access denied: This operation requires a fine-grained personal access token with the following project permissions: [Merge Request: Create].",
        },
      ],
    });
    await expect(checkGitlab(instance, "t", [REPO], f.fetch, { headName })).rejects.toThrow(
      "(add the permission Merge Request: Create to the token)",
    );
  });

  it("closes a merge request it opened by accident and fails loudly", async () => {
    const f = fakeFetch({
      ...writable,
      [MRS]: [201, { iid: 9, web_url: `${BASE}/platform/backend/api/-/merge_requests/9` }],
      [`PUT ${api("platform/backend/api", "/merge_requests/9")}`]: [200, {}],
    });
    await expect(checkGitlab(instance, "t", [REPO], f.fetch, { headName })).rejects.toThrow(
      "opened a real merge request in platform/backend/api",
    );
    expect(f.requests.at(-1)?.body).toEqual({ state_event: "close" });
  });

  it("a 403 on /version leaves the version unknown and goes on (fine-grained token without Metadata: Read)", async () => {
    const f = fakeFetch({
      ...writable,
      [VERSION]: [
        403,
        {
          error: "forbidden",
          error_description:
            "Access denied: This operation requires a fine-grained personal access token with the following instance permissions: [Metadata: Read].",
        },
      ],
    });
    const id = await checkGitlab(instance, "t", [REPO], f.fetch);
    expect(id.version).toBe("");
    expect(id.username).toBe(bot.username);
  });

  it("requirePush false stops after the project lookup", async () => {
    const f = fakeFetch({
      [VERSION]: [200, { version: "19.5.3" }],
      [USER]: [200, bot],
      [PROJECT]: [200, { id: 1 }],
    });
    await checkGitlab(instance, "t", [REPO], f.fetch, { requirePush: false });
    expect(f.requests.map((r) => r.url)).toEqual([
      `${BASE}/api/v4/version`,
      `${BASE}/api/v4/user`,
      api("platform/backend/api"),
    ]);
  });

  it("with the webhooks on, reads pipelines, jobs and each trusted group's members", async () => {
    const f = fakeFetch({
      ...writable,
      [PIPELINES]: [200, []],
      [JOBS]: [200, []],
      [MEMBERS]: [200, [{ id: 3, username: "rahul" }]],
    });
    await checkGitlab(instance, "t", [REPO], f.fetch, {
      headName,
      webhooks: { trustedGroups: ["platform"] },
    });
    expect(f.requests.slice(5).map((r) => `${r.method} ${r.url}`)).toEqual([
      PIPELINES,
      JOBS,
      MEMBERS,
    ]);
  });

  it("a group with no members fails closed, a missing one is named", async () => {
    const f = fakeFetch({
      ...writable,
      [PIPELINES]: [200, []],
      [JOBS]: [200, []],
      [MEMBERS]: [200, []],
    });
    await expect(
      checkGitlab(instance, "t", [REPO], f.fetch, {
        headName,
        webhooks: { trustedGroups: ["platform"] },
      }),
    ).rejects.toThrow("group platform (gitlab.trustedGroups) has no members");
    const g = fakeFetch({
      ...writable,
      [PIPELINES]: [200, []],
      [JOBS]: [200, []],
      [MEMBERS]: [404, { message: "404 Group Not Found" }],
    });
    await expect(
      checkGitlab(instance, "t", [REPO], g.fetch, {
        headName,
        webhooks: { trustedGroups: ["platform"] },
      }),
    ).rejects.toThrow("the group does not exist or the token cannot see it");
  });

  it("a job list the token cannot read names Job: Read", async () => {
    const f = fakeFetch({
      ...writable,
      [PIPELINES]: [200, []],
      [JOBS]: [403, { message: "403 Forbidden" }],
    });
    const err = await checkGitlab(instance, "t", [REPO], f.fetch, {
      headName,
      webhooks: { trustedGroups: [] },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitlabCheckError);
    expect(String((err as Error).message)).toContain("(the token needs Job: Read)");
  });
});
