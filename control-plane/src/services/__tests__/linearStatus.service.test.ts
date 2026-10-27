import { afterEach, describe, expect, it, mock } from "bun:test";
import type { ClientCredentialsToken } from "../../clients/linearOauth";
import { LinearStatusService } from "../linearStatus.service";
import { LinearTokenProvider } from "../linearTokenProvider";

const IDENTITY = {
  viewer: { id: "app-1", name: "Devbox" },
  organization: { id: "org-1", name: "Example", urlKey: "example" },
};

function setup(query: () => Promise<unknown>, lastTokenError: string | null = null) {
  const warn = mock(() => {});
  const rawRequest = mock(query);
  const provider = {
    getAuthorizedLinearClient: async () => ({ client: { rawRequest } }) as never,
    lastTokenError,
  };
  return { rawRequest, warn, service: new LinearStatusService(provider, { warn } as never) };
}

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => {
  server?.stop(true);
  server = undefined;
});

describe("LinearStatusService", () => {
  it("reports not configured", async () => {
    expect(await new LinearStatusService(undefined).status()).toEqual({ configured: false });
  });

  it("reports workspace, app user, last webhook and token error", async () => {
    const { service } = setup(async () => ({ data: IDENTITY }), "boom");
    service.recordWebhook(new Date("2026-10-16T07:55:25.031Z"));
    expect(await service.status()).toEqual({
      configured: true,
      workspace: { id: "org-1", name: "Example", urlKey: "example" },
      appUser: { id: "app-1", name: "Devbox" },
      lastWebhookAt: "2026-10-16T07:55:25.031Z",
      lastTokenError: "boom",
    });
  });

  it("caches identity for the process", async () => {
    const { service, rawRequest } = setup(async () => ({ data: IDENTITY }));
    await service.status();
    await service.status();
    expect(rawRequest).toHaveBeenCalledTimes(1);
  });

  it("leaves identity null when the query fails", async () => {
    let fail = true;
    const { service, warn } = setup(async () => {
      if (fail) throw new Error("down");
      return { data: IDENTITY };
    }, "token rejected");
    expect(await service.status()).toEqual({
      configured: true,
      workspace: null,
      appUser: null,
      lastWebhookAt: null,
      lastTokenError: "token rejected",
    });
    expect(warn).toHaveBeenCalledWith("linear identity query failed", { message: "down" });
    fail = false;
    const again = await service.status();
    expect(again.configured && again.workspace).toEqual({
      id: "org-1",
      name: "Example",
      urlKey: "example",
    });
  });

  it("renews a rejected token and retries the identity query once", async () => {
    const seen: string[] = [];
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const auth = req.headers.get("authorization") ?? "";
        seen.push(auth);
        if (auth === "Bearer t2") return Response.json({ data: IDENTITY });
        return Response.json(
          {
            errors: [
              { message: "Authentication required", extensions: { type: "authentication error" } },
            ],
          },
          { status: 401 },
        );
      },
    });
    const queue = ["t1", "t2"];
    const requestToken = mock(
      async (): Promise<ClientCredentialsToken> => ({
        accessToken: queue.shift() ?? "none",
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        scope: "",
      }),
    );
    const provider = new LinearTokenProvider({
      creds: { clientId: "id", clientSecret: "s" },
      requestToken,
      apiUrl: `http://localhost:${server.port}/graphql`,
      log: { warn: () => {}, error: () => {} },
    });
    const service = new LinearStatusService(provider, { warn: () => {} });

    expect(await service.status()).toEqual({
      configured: true,
      workspace: { id: "org-1", name: "Example", urlKey: "example" },
      appUser: { id: "app-1", name: "Devbox" },
      lastWebhookAt: null,
      lastTokenError: null,
    });
    expect(requestToken).toHaveBeenCalledTimes(2);
    expect(seen).toEqual(["Bearer t1", "Bearer t2"]);
  });
});
