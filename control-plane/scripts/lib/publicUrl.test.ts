import { describe, expect, it } from "bun:test";
import type { Deployment } from "./keychain";
import {
  type Configured,
  ingressPublicUrl,
  ingressSource,
  PublicUrlError,
  publicUrlChangeLines,
  resolvePublicUrl,
  validatePublicUrl,
} from "./publicUrl";

const P = "Webhooks need a public HTTPS URL: ";

describe("validatePublicUrl", () => {
  it("accepts a public DNS name", () => {
    expect(validatePublicUrl("https://devbox.example.com")).toBe("https://devbox.example.com");
  });

  it("trims a trailing slash", () => {
    expect(validatePublicUrl("https://devbox.example.com/")).toBe("https://devbox.example.com");
    expect(validatePublicUrl("https://devbox.example.com//")).toBe("https://devbox.example.com");
  });

  it("keeps a path prefix", () => {
    expect(validatePublicUrl("https://proxy.example.com/devbox/")).toBe(
      "https://proxy.example.com/devbox",
    );
  });

  it("keeps a port", () => {
    expect(validatePublicUrl("https://devbox.example.com:8443")).toBe(
      "https://devbox.example.com:8443",
    );
  });

  const refused: Array<[string, string, string]> = [
    [
      "a non-URL",
      "devbox.example.com",
      `${P}the value is not an absolute URL (start it with https://)`,
    ],
    [
      "a non-URL with a query, without echoing it",
      "h.example.com/?token=s3cret",
      `${P}the value is not an absolute URL (start it with https://)`,
    ],
    [
      "http with a query, without echoing it",
      "http://h.example.com/?token=s3cret",
      `${P}http://h.example.com uses http:, not https:`,
    ],
    [
      "ws with a fragment, without echoing it",
      "ws://h.example.com/hooks#access_token=s3cret",
      `${P}ws://h.example.com/hooks uses ws:, not https:`,
    ],
    [
      "a non-https URL",
      "http://devbox.example.com",
      `${P}http://devbox.example.com uses http:, not https:`,
    ],
    ["localhost", "https://localhost:3000", `${P}localhost is not reachable from the internet`],
    [
      "a *.localhost name",
      "https://devbox.localhost",
      `${P}devbox.localhost is not reachable from the internet`,
    ],
    ["an IPv4 loopback", "https://127.0.0.1", `${P}127.0.0.1 is a loopback address`],
    ["an IPv4 loopback in 127/8", "https://127.8.9.10", `${P}127.8.9.10 is a loopback address`],
    ["an IPv4 link-local", "https://169.254.1.2", `${P}169.254.1.2 is a link-local address`],
    ["an RFC 1918 10/8", "https://10.1.2.3", `${P}10.1.2.3 is a private (RFC 1918) address`],
    [
      "an RFC 1918 172.16/12",
      "https://172.31.0.1",
      `${P}172.31.0.1 is a private (RFC 1918) address`,
    ],
    [
      "an RFC 1918 192.168/16",
      "https://192.168.1.1",
      `${P}192.168.1.1 is a private (RFC 1918) address`,
    ],
    ["an IPv6 loopback", "https://[::1]", `${P}[::1] is a loopback address`],
    ["an IPv6 link-local", "https://[fe80::1]", `${P}[fe80::1] is a link-local address`],
    [
      "an IPv6 link-local at the top of fe80::/10",
      "https://[febf::1]",
      `${P}[febf::1] is a link-local address`,
    ],
    ["an IPv6 ULA fc00::/7 (fc)", "https://[fc00::1]", `${P}[fc00::1] is a private (ULA) address`],
    [
      "an IPv6 ULA fc00::/7 (fd)",
      "https://[fd12:3456::1]",
      `${P}[fd12:3456::1] is a private (ULA) address`,
    ],
    [
      "a query",
      "https://devbox.example.com/?token=s3cret",
      `${P}https://devbox.example.com/ must not have a query`,
    ],
    [
      "a fragment",
      "https://devbox.example.com/hooks#access_token=s3cret",
      `${P}https://devbox.example.com/hooks must not have a fragment`,
    ],
    [
      "a bare query mark",
      "https://devbox.example.com?",
      `${P}https://devbox.example.com/ must not have a query`,
    ],
    [
      "another scheme, without echoing the rest (it may hold a password)",
      "devbox:pw@example.com",
      `${P}the URL uses devbox:, not https:`,
    ],
    ["0.0.0.0", "https://0.0.0.0", `${P}0.0.0.0 is an unspecified address`],
    ["[::]", "https://[::]", `${P}[::] is an unspecified address`],
    [
      "an IPv4-mapped loopback, dotted",
      "https://[::ffff:127.0.0.1]",
      `${P}[::ffff:7f00:1] is a loopback address`,
    ],
    [
      "an IPv4-mapped loopback, hex",
      "https://[::ffff:7f00:1]",
      `${P}[::ffff:7f00:1] is a loopback address`,
    ],
    [
      "an IPv4-mapped link-local",
      "https://[::ffff:169.254.0.1]",
      `${P}[::ffff:a9fe:1] is a link-local address`,
    ],
    [
      "an IPv4-mapped private address",
      "https://[::ffff:192.168.0.1]",
      `${P}[::ffff:c0a8:1] is a private (RFC 1918) address`,
    ],
    [
      "credentials",
      "https://user:pass@devbox.example.com",
      `${P}the URL must not contain credentials`,
    ],
  ];
  for (const [what, raw, message] of refused) {
    it(`refuses ${what}`, () => {
      let err: unknown;
      try {
        validatePublicUrl(raw);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(PublicUrlError);
      expect((err as Error).message).toBe(message);
      expect((err as Error).message).not.toContain("s3cret");
    });
  }

  it("accepts public addresses next to the private ranges", () => {
    expect(validatePublicUrl("https://172.32.0.1")).toBe("https://172.32.0.1");
    expect(validatePublicUrl("https://[fec0::1]")).toBe("https://[fec0::1]");
    expect(validatePublicUrl("https://[2001:db8::1]")).toBe("https://[2001:db8::1]");
    expect(validatePublicUrl("https://[::ffff:8.8.8.8]")).toBe("https://[::ffff:808:808]");
  });
});

describe("ingressPublicUrl", () => {
  const webhooks = { enabled: true, host: "hooks.example.com", tls: [{ hosts: ["x"] }] };
  const api = { enabled: true, host: "devbox.example.com", tls: [{ hosts: ["y"] }] };

  it("webhooks Ingress wins", () => {
    expect(ingressPublicUrl({ values: { ingress: { webhooks, api } } })).toBe(
      "https://hooks.example.com",
    );
  });

  it("falls back to the api Ingress", () => {
    expect(
      ingressPublicUrl({
        values: { ingress: { webhooks: { enabled: false, host: "hooks.example.com" }, api } },
      }),
    ).toBe("https://devbox.example.com");
    expect(
      ingressPublicUrl({ values: { ingress: { webhooks: { enabled: true, host: "" }, api } } }),
    ).toBe("https://devbox.example.com");
  });

  it("https only with tls", () => {
    expect(ingressPublicUrl({ values: { ingress: { webhooks: { ...webhooks, tls: [] } } } })).toBe(
      "http://hooks.example.com",
    );
    expect(
      ingressPublicUrl({
        values: { ingress: { api: { enabled: true, host: "devbox.example.com" } } },
      }),
    ).toBe("http://devbox.example.com");
  });

  it("none without an Ingress", () => {
    expect(ingressPublicUrl({ values: {} })).toBeUndefined();
    expect(
      ingressPublicUrl({
        values: { ingress: { api: { enabled: false, host: "devbox.example.com" } } },
      }),
    ).toBeUndefined();
  });

  it("says which Ingress it used", () => {
    expect(ingressSource({ values: { ingress: { webhooks, api } } })).toBe("webhooks");
    expect(ingressSource({ values: { ingress: { api } } })).toBe("api");
    expect(ingressSource({ values: {} })).toBeUndefined();
  });
});

const COMPOSE: Deployment = { kind: "compose" };
const K8S: Deployment = { kind: "k8s", context: "kind-devbox", namespace: "devbox" };
const NEXT = "https://hooks.example.com";

describe("resolvePublicUrl", () => {
  const deps = (o: { isTTY?: boolean; answer?: string } = {}) => {
    const asked: string[] = [];
    return {
      asked,
      deps: {
        resolver: { isTTY: o.isTTY ?? true },
        promptLine: async (q: string) => {
          asked.push(q);
          return o.answer ?? "";
        },
      },
    };
  };

  it("--public-url wins, validated and trimmed", async () => {
    const x = deps();
    expect(
      await resolvePublicUrl(
        { deployment: COMPOSE, publicUrl: "https://saved.example.com" },
        { publicUrl: `${NEXT}/` },
        x.deps,
      ),
    ).toBe(NEXT);
    await expect(
      resolvePublicUrl({ deployment: COMPOSE }, { publicUrl: "http://x.example.com" }, x.deps),
    ).rejects.toBeInstanceOf(PublicUrlError);
    expect(x.asked).toEqual([]);
  });

  it("then the saved publicUrl", async () => {
    expect(
      await resolvePublicUrl(
        { deployment: K8S, publicUrl: NEXT, ingressUrl: "https://i.example.com" },
        {},
        deps().deps,
      ),
    ).toBe(NEXT);
  });

  it("k8s: the Ingress URL", async () => {
    expect(
      await resolvePublicUrl(
        { deployment: K8S, ingressUrl: "https://i.example.com" },
        {},
        deps().deps,
      ),
    ).toBe("https://i.example.com");
  });

  it("k8s: an http Ingress gets the TLS hint", async () => {
    await expect(
      resolvePublicUrl({ deployment: K8S, ingressUrl: "http://i.example.com" }, {}, deps().deps),
    ).rejects.toThrow(
      new PublicUrlError(
        `${P}http://i.example.com uses http:, not https:. If TLS ends at a load balancer in front of the Ingress, pass --public-url https://i.example.com`,
      ),
    );
  });

  it("k8s: an Ingress host with a space gets no hint", async () => {
    await expect(
      resolvePublicUrl({ deployment: K8S, ingressUrl: "http://i example.com" }, {}, deps().deps),
    ).rejects.toThrow(
      new PublicUrlError(`${P}the value is not an absolute URL (start it with https://)`),
    );
  });

  it("k8s: no Ingress", async () => {
    await expect(resolvePublicUrl({ deployment: K8S }, {}, deps().deps)).rejects.toThrow(
      new PublicUrlError(`${P}enable ingress.webhooks, or pass --public-url.`),
    );
  });

  it("Compose: a prompt with a terminal", async () => {
    const x = deps({ answer: ` ${NEXT}/ ` });
    expect(await resolvePublicUrl({ deployment: COMPOSE }, {}, x.deps)).toBe(NEXT);
    expect(x.asked).toEqual([
      "Public HTTPS URL that forwards to port 3000 on this machine (a tunnel or reverse proxy): ",
    ]);
  });

  it("Compose: no terminal or an empty answer fails naming --public-url", async () => {
    const none = new PublicUrlError(
      `${P}pass --public-url <https URL that forwards to port 3000 on this machine>`,
    );
    const x = deps({ isTTY: false });
    await expect(resolvePublicUrl({ deployment: COMPOSE }, {}, x.deps)).rejects.toThrow(none);
    expect(x.asked).toEqual([]);
    await expect(resolvePublicUrl({ deployment: COMPOSE }, {}, deps().deps)).rejects.toThrow(none);
  });
});

describe("publicUrlChangeLines", () => {
  const OLD = "https://old.example.com";
  const LINEAR_LINE = `Update the webhook URL in the Linear app to ${NEXT}/webhook/linear`;
  const EXTERNAL_LINE = `Update the webhook URL in the GitHub App to ${NEXT}/webhook/github: https://github.com/settings/apps/example-devbox`;
  const UPDATED = `Updated the GitHub App's webhook URL to ${NEXT}/webhook/github`;
  const RUN_GITHUB = "Run bun run github:setup to update the GitHub App's webhook URL";
  const app = (tokens: "devbox" | "external", hookUpdated?: boolean) => ({
    tokens,
    slug: "example-devbox",
    ...(hookUpdated !== undefined ? { hookUpdated } : {}),
  });

  const table: Array<[string, Configured, "linear" | "github", string[]]> = [
    ["nothing configured", { linear: false }, "linear", []],
    ["Linear, from linear", { linear: true }, "linear", [LINEAR_LINE]],
    ["Linear, from github", { linear: true }, "github", [LINEAR_LINE]],
    [
      "devbox App, from linear: points at github:setup",
      { linear: false, githubApp: app("devbox") },
      "linear",
      [RUN_GITHUB],
    ],
    [
      "devbox App, from github, hook updated",
      { linear: false, githubApp: app("devbox", true) },
      "github",
      [UPDATED],
    ],
    [
      "devbox App, from github, hook not updated (no key): by hand",
      { linear: false, githubApp: app("devbox", false) },
      "github",
      [EXTERNAL_LINE],
    ],
    [
      "devbox App, from github, hookUpdated unset: by hand",
      { linear: false, githubApp: app("devbox") },
      "github",
      [EXTERNAL_LINE],
    ],
    [
      "devbox App, from linear ignores hookUpdated",
      { linear: false, githubApp: app("devbox", true) },
      "linear",
      [RUN_GITHUB],
    ],
    [
      "external App, from linear",
      { linear: false, githubApp: app("external") },
      "linear",
      [EXTERNAL_LINE],
    ],
    [
      "external App, from github",
      { linear: false, githubApp: app("external") },
      "github",
      [EXTERNAL_LINE],
    ],
    [
      "Linear and devbox App, from linear: Linear first",
      { linear: true, githubApp: app("devbox") },
      "linear",
      [LINEAR_LINE, RUN_GITHUB],
    ],
    [
      "Linear and devbox App, from github, hook updated",
      { linear: true, githubApp: app("devbox", true) },
      "github",
      [LINEAR_LINE, UPDATED],
    ],
    [
      "Linear and external App, from linear",
      { linear: true, githubApp: app("external") },
      "linear",
      [LINEAR_LINE, EXTERNAL_LINE],
    ],
    [
      "Linear and external App, from github",
      { linear: true, githubApp: app("external") },
      "github",
      [LINEAR_LINE, EXTERNAL_LINE],
    ],
  ];
  for (const [what, configured, from, lines] of table) {
    it(what, () => {
      expect(publicUrlChangeLines(OLD, NEXT, configured, from)).toEqual(lines);
    });
  }

  it("an organization's App: its settings link is the organization's", () => {
    expect(
      publicUrlChangeLines(
        OLD,
        NEXT,
        { linear: false, githubApp: { ...app("external"), org: "example-org" } },
        "github",
      ),
    ).toEqual([
      `Update the webhook URL in the GitHub App to ${NEXT}/webhook/github: https://github.com/organizations/example-org/settings/apps/example-devbox`,
    ]);
  });

  it("no lines when the URL is new or unchanged", () => {
    const all: Configured = { linear: true, githubApp: app("external") };
    expect(publicUrlChangeLines(undefined, NEXT, all, "linear")).toEqual([]);
    expect(publicUrlChangeLines(NEXT, NEXT, all, "github")).toEqual([]);
  });
});
