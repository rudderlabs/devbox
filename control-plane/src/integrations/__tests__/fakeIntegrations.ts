import type { Integration, IntegrationName } from "../types";

const noop = (name: IntegrationName): Integration => ({
  name,
  enabled: true,
  async deliver() {},
  async status() {
    return {};
  },
});

// A registry for tests: every integration a no-op (enabled, delivers nothing)
// unless given. A new integration gets its default here, not in every test.
export function fakeIntegrations<
  O extends Partial<Record<IntegrationName, Pick<Integration, "status">>>,
>(overrides: O): Omit<Record<IntegrationName, Integration>, keyof O> & O {
  const defaults: Record<IntegrationName, Integration> = {
    linear: noop("linear"),
    api: noop("api"),
    github: noop("github"),
  };
  return { ...defaults, ...overrides };
}
