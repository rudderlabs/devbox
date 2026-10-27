import { describe, expect, it } from "bun:test";
import type { Choices } from "./choices";
import { integrationSteps, startStep, statusCommands } from "./steps";

const COMPOSE: Choices = { platform: "compose", githubApp: false, linear: false };
const KIND: Choices = { platform: "kind", githubApp: false, linear: false };
const PLAIN = { noKeychain: false };

describe("startStep", () => {
  it("runs up on Compose and k8s:kind on kind", () => {
    expect(startStep(COMPOSE, PLAIN)).toEqual({
      title: "bun run up",
      cmd: ["bun", "control-plane/scripts/up.ts"],
    });
    expect(startStep(KIND, { noKeychain: true })).toEqual({
      title: "bun run k8s:kind",
      cmd: ["bun", "control-plane/scripts/k8s.ts", "kind", "--no-keychain"],
    });
  });
});

describe("integrationSteps", () => {
  it("is empty without integrations", () => {
    expect(integrationSteps(COMPOSE, PLAIN)).toEqual([]);
  });

  it("runs the GitHub App's setup, then Linear's, passing the public URL", () => {
    const steps = integrationSteps(
      { ...COMPOSE, githubApp: true, linear: true },
      { noKeychain: false, publicUrl: "https://hooks.example.com" },
    );
    expect(steps).toEqual([
      {
        title: "bun run github:setup",
        cmd: [
          "bun",
          "control-plane/scripts/github.ts",
          "setup",
          "--public-url",
          "https://hooks.example.com",
        ],
      },
      {
        title: "bun run linear:setup",
        cmd: [
          "bun",
          "control-plane/scripts/linear.ts",
          "setup",
          "--public-url",
          "https://hooks.example.com",
        ],
      },
    ]);
  });

  it("targets devbox.kind.json on kind", () => {
    expect(integrationSteps({ ...KIND, linear: true }, { noKeychain: true })).toEqual([
      {
        title: "bun run linear:setup --target devbox.kind.json",
        cmd: [
          "bun",
          "control-plane/scripts/linear.ts",
          "setup",
          "--target",
          "devbox.kind.json",
          "--no-keychain",
        ],
      },
    ]);
  });
});

describe("statusCommands", () => {
  it("covers what was set up now and what was on already", () => {
    expect(statusCommands({ ...KIND, linear: true }, { githubApp: true, linear: false })).toEqual([
      "bun run github:status --target devbox.kind.json",
      "bun run linear:status --target devbox.kind.json",
    ]);
    expect(statusCommands(COMPOSE, { githubApp: false, linear: false })).toEqual([]);
  });
});
