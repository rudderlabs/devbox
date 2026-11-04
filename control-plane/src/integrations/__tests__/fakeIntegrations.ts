import type { Integration } from "../types";

const noop = (): Integration => ({
  async deliver() {},
  async status() {
    return {};
  },
});

// The registry's enabled integrations, for tests: every one a no-op (delivers
// nothing) unless given. A new integration gets its default here, not in every
// test.
export function fakeIntegrations<O extends Record<string, Integration>>(
  overrides: O,
): Record<string, Integration> & O {
  return { linear: noop(), api: noop(), github: noop(), ...overrides };
}

// A webhook controller for integrations built in tests that receive no webhooks.
export const NO_WEBHOOK = {
  handleWebhook: (): Promise<Response> => Promise.reject(new Error("no webhooks in this test")),
};
