import { expect, it } from "bun:test";
import { logger } from "../../../logger";
import { api } from "..";

it("is on only with API_ENABLED=true, takes no webhooks, and reports whether it is on", async () => {
  expect(api.createsTasks).toBe(true);
  for (const value of [undefined, "", "false", "1", "TRUE"]) {
    expect(api.parseConfig({ API_ENABLED: value })).toBeUndefined();
  }
  const cfg = api.parseConfig({ API_ENABLED: "true", API_PUBLIC_BASE_URL: "https://api.example" });
  if (!cfg) throw new Error("the API should be on");
  const integration = api.create({ tasks: {} as never, log: logger }, cfg);
  expect(integration.webhook).toBeUndefined();
  expect(await integration.status()).toEqual({ enabled: true });
  expect(api.disabledStatus()).toEqual({ enabled: false });
});
