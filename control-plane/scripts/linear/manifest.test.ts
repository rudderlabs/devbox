import { describe, expect, it } from "bun:test";
import { linearManifest, manifestLink } from "./manifest";

const PREFIX = "https://linear.app/settings/api/applications/new?manifest=";

describe("linearManifest", () => {
  it("the manifest in full", () => {
    expect(linearManifest("https://hooks.example.com", "devbox")).toEqual({
      schemaVersion: "1.0.0",
      distribution: "private",
      display: { description: "devbox coding agent" },
      developer: { name: "devbox" },
      oauth: {
        client_name: "devbox",
        client_uri: "https://github.com/rudderlabs/devbox",
        redirect_uris: ["https://hooks.example.com/oauth/callback"],
        grant_types: ["authorization_code", "client_credentials"],
      },
      webhook: {
        enabled: true,
        url: "https://hooks.example.com/webhook/linear",
        resourceTypes: ["AgentSessionEvent"],
      },
    });
  });

  it("names the app after --name", () => {
    const m = linearManifest("https://hooks.example.com/devbox", "my agent") as {
      oauth: { client_name: string; redirect_uris: string[] };
      webhook: { url: string };
    };
    expect(m.oauth.client_name).toBe("my agent");
    expect(m.oauth.redirect_uris).toEqual(["https://hooks.example.com/devbox/oauth/callback"]);
    expect(m.webhook.url).toBe("https://hooks.example.com/devbox/webhook/linear");
  });
});

describe("manifestLink", () => {
  it("the link decodes back to the manifest", () => {
    const m = linearManifest("https://hooks.example.com", "devbox & co");
    const link = manifestLink(m);
    expect(link.startsWith(PREFIX)).toBe(true);
    expect(JSON.parse(decodeURIComponent(link.slice(PREFIX.length)))).toEqual(m);
    expect(new URL(link).searchParams.get("manifest")).toBe(JSON.stringify(m));
  });
});
