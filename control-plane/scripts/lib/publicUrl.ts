// The deployment's one public URL, where Linear and
// GitHub deliver webhooks. Both refuse anything but a public HTTPS URL, so a
// bad one is caught here, before a manifest or a test webhook is built from
// it. A path prefix (a reverse proxy under /devbox) is kept; trailing slashes
// are trimmed.
import type { Target } from "../k8s/target";
import { userValue } from "../k8s/values";
import type { Deployment } from "./keychain";

export class PublicUrlError extends Error {}

const refuse = (why: string): never => {
  throw new PublicUrlError(`Webhooks need a public HTTPS URL: ${why}`);
};

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

// URL has already normalised an IPv4 literal to four decimal octets.
function ipv4Kind(host: string): string | undefined {
  const m = IPV4.exec(host);
  if (!m) return undefined;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 0) return "an unspecified address";
  if (a === 127) return "a loopback address";
  if (a === 169 && b === 254) return "a link-local address";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
    return "a private (RFC 1918) address";
  }
  return undefined;
}

// URL has already compressed an IPv6 literal and lower-cased it, in brackets.
function ipv6Kind(host: string): string | undefined {
  if (!host.startsWith("[")) return undefined;
  const ip = host.slice(1, -1);
  if (ip === "::") return "an unspecified address";
  if (ip === "::1") return "a loopback address";
  // An IPv4-mapped address (URL writes ::ffff:127.0.0.1 as ::ffff:7f00:1) is
  // the IPv4 address it maps.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
  if (mapped) {
    const [hi, lo] = [Number.parseInt(mapped[1] ?? "", 16), Number.parseInt(mapped[2] ?? "", 16)];
    return ipv4Kind(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  const first = ip.startsWith("::") ? 0 : Number.parseInt(ip.split(":")[0] ?? "", 16);
  if (first >= 0xfe80 && first <= 0xfebf) return "a link-local address";
  if (first >= 0xfc00 && first <= 0xfdff) return "a private (ULA) address";
  return undefined;
}

export function validatePublicUrl(raw: string): string {
  const text = raw.trim();
  // The input is never echoed whole: a query, fragment or credentials in it
  // may hold a token.
  if (!URL.canParse(text))
    return refuse("the value is not an absolute URL (start it with https://)");
  const url = new URL(text);
  if (url.username || url.password) return refuse("the URL must not contain credentials");
  if (url.protocol !== "https:") {
    // Only a URL with a host (http:, ws:, …) had its credentials refused
    // above; in any other ("devbox:pw@example.com") the rest may be one.
    const what = url.host
      ? `${url.protocol}//${url.host}${url.pathname}`.replace(/\/+$/, "")
      : "the URL";
    return refuse(`${what} uses ${url.protocol}, not https:`);
  }
  const host = url.hostname;
  if (host === "localhost" || host.endsWith(".localhost")) {
    return refuse(`${host} is not reachable from the internet`);
  }
  const kind = ipv4Kind(host) ?? ipv6Kind(host);
  if (kind) return refuse(`${host} is ${kind}`);
  // `search` and `hash` are empty for a bare "?" or "#"; the href keeps them.
  const bare = `${url.origin}${url.pathname}`;
  if (url.search || url.href.includes("?")) return refuse(`${bare} must not have a query`);
  if (url.hash || url.href.includes("#")) return refuse(`${bare} must not have a fragment`);
  return url.href.replace(/\/+$/, "");
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

type IngressValues = { enabled?: unknown; host?: unknown; tls?: unknown };

function ingress(target: Pick<Target, "values">, name: string): IngressValues | undefined {
  const v = userValue(target, ["ingress", name]);
  return isObject(v) && v.enabled === true && typeof v.host === "string" && v.host !== ""
    ? v
    : undefined;
}

// The Ingress k8s derives the public URL from: `webhooks` when it
// is enabled with a host, else `api`.
export const ingressSource = (target: Pick<Target, "values">): "webhooks" | "api" | undefined =>
  ingress(target, "webhooks") ? "webhooks" : ingress(target, "api") ? "api" : undefined;

// That Ingress's URL: https:// when it has TLS. Without TLS (or with TLS ended
// at a load balancer) it is http://, which validatePublicUrl refuses.
export function ingressPublicUrl(target: Pick<Target, "values">): string | undefined {
  const source = ingressSource(target);
  const v = source && ingress(target, source);
  if (!v) return undefined;
  return `${Array.isArray(v.tls) && v.tls.length > 0 ? "https" : "http"}://${v.host}`;
}

// A `publicUrl` setting in a config file: a string, validated, with the
// field's name in front of the message.
export function parsePublicUrl(raw: unknown, field: string, fail: (msg: string) => never): string {
  if (typeof raw !== "string") return fail(`${field}: must be a string`);
  try {
    return validatePublicUrl(raw);
  } catch (err) {
    if (err instanceof PublicUrlError) return fail(`${field}: ${err.message}`);
    throw err;
  }
}

export type PublicUrlDeps = {
  resolver: { isTTY: boolean };
  // Asks with echo; empty at EOF.
  promptLine: (q: string) => Promise<string>;
};

const URL_QUESTION =
  "Public HTTPS URL that forwards to port 3000 on this machine (a tunnel or reverse proxy): ";

// The public URL to use: --public-url, the saved
// `publicUrl`, the Ingress (k8s), a prompt (Compose, with a terminal).
export async function resolvePublicUrl(
  d: { publicUrl?: string; deployment: Deployment; ingressUrl?: string },
  opts: { publicUrl?: string },
  deps: PublicUrlDeps,
): Promise<string> {
  if (opts.publicUrl !== undefined) return validatePublicUrl(opts.publicUrl);
  if (d.publicUrl) return d.publicUrl;
  if (d.deployment.kind === "k8s") {
    if (!d.ingressUrl) {
      throw new PublicUrlError(
        "Webhooks need a public HTTPS URL: enable ingress.webhooks, or pass --public-url.",
      );
    }
    try {
      return validatePublicUrl(d.ingressUrl);
    } catch (err) {
      const url = d.ingressUrl;
      if (!(err instanceof PublicUrlError) || !url.startsWith("http://") || !URL.canParse(url)) {
        throw err;
      }
      // An Ingress without `tls` may still be HTTPS at a load balancer.
      throw new PublicUrlError(
        `${err.message}. If TLS ends at a load balancer in front of the Ingress, pass --public-url https://${new URL(url).host}`,
      );
    }
  }
  const none = new PublicUrlError(
    "Webhooks need a public HTTPS URL: pass --public-url <https URL that forwards to port 3000 on this machine>",
  );
  if (!deps.resolver.isTTY) throw none;
  const answer = (await deps.promptLine(URL_QUESTION)).trim();
  if (!answer) throw none;
  return validatePublicUrl(answer);
}

export type Configured = {
  linear: boolean;
  // hookUpdated: github:setup updated the App's webhook URL itself. org: the
  // organization that owns the App, when known (its settings page is there).
  githubApp?: {
    tokens: "devbox" | "external";
    slug: string;
    hookUpdated?: boolean;
    org?: string;
  };
};

// What each configured integration needs when the public URL changes, in
// the order Linear, then GitHub. `from` is the command that changed it: the
// App's webhook URL is updated by github:setup, which holds the key. `flag`
// is the deployment's ` --target <file>` (empty on Compose).
export function publicUrlChangeLines(
  old: string | undefined,
  next: string,
  configured: Configured,
  from: "linear" | "github",
  flag = "",
): string[] {
  if (old === undefined || old === next) return [];
  const lines: string[] = [];
  if (configured.linear) {
    lines.push(`Update the webhook URL in the Linear app to ${next}/webhook/linear`);
  }
  const app = configured.githubApp;
  if (app) {
    if (app.tokens === "devbox" && from === "github" && app.hookUpdated) {
      lines.push(`Updated the GitHub App's webhook URL to ${next}/webhook/github`);
    } else if (app.tokens === "devbox" && from === "linear") {
      lines.push(`Run bun run github:setup${flag} to update the GitHub App's webhook URL`);
    } else {
      // External tokens, or github:setup without the key: by hand.
      const settings = app.org
        ? `https://github.com/organizations/${app.org}/settings/apps`
        : "https://github.com/settings/apps";
      lines.push(
        `Update the webhook URL in the GitHub App to ${next}/webhook/github: ${settings}/${app.slug}`,
      );
    }
  }
  return lines;
}
