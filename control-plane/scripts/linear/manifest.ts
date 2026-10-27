// `linear:setup` opens Linear's pre-filled "create app" page with this manifest,
// so the webhook URL and event type can't be mistyped. Linear requires the
// authorization_code grant and a redirect URI; devbox never uses either because
// it gets its token with client credentials.
const CREATE_APP = "https://linear.app/settings/api/applications/new?manifest=";

export function linearManifest(publicUrl: string, name: string): object {
  return {
    schemaVersion: "1.0.0",
    distribution: "private",
    display: { description: "devbox coding agent" },
    developer: { name: "devbox" },
    oauth: {
      client_name: name,
      client_uri: "https://github.com/rudderlabs/devbox",
      redirect_uris: [`${publicUrl}/oauth/callback`],
      grant_types: ["authorization_code", "client_credentials"],
    },
    webhook: {
      enabled: true,
      url: `${publicUrl}/webhook/linear`,
      resourceTypes: ["AgentSessionEvent"],
    },
  };
}

export const manifestLink = (m: object): string =>
  `${CREATE_APP}${encodeURIComponent(JSON.stringify(m))}`;
