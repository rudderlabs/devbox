import type { Integration, IntegrationDefinition } from "../types";

const noop = (): Integration => ({
  async deliver() {},
  async status() {
    return {};
  },
});

// The integrations this build has, as definitions for a test registry. Each
// is on and created as the instance given, a no-op one (delivers nothing)
// unless given, or off when given null. Linear and api create tasks, as the
// real ones do. A new integration gets its default here, not in every test.
export function fakeDefinitions(
  instances: Record<string, Integration | null> = {},
): IntegrationDefinition<Integration>[] {
  const all = { linear: noop(), github: noop(), api: noop(), ...instances };
  return Object.entries(all).map(([name, instance]) => ({
    name,
    createsTasks: name !== "github",
    parseConfig: () => instance ?? undefined,
    create: (_core, i) => i,
    disabledStatus: () => ({}),
  }));
}

// A webhook controller for integrations built in tests that receive no webhooks.
export const NO_WEBHOOK = {
  handleWebhook: (): Promise<Response> => Promise.reject(new Error("no webhooks in this test")),
};
