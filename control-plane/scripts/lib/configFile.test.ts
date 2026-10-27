import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeConfigKeys } from "./configFile";

const dir = mkdtempSync(join(tmpdir(), "devbox-config-file-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
function file(content: unknown): string {
  const path = join(dir, `c${n++}.json`);
  writeFileSync(path, JSON.stringify(content));
  return path;
}
const read = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const LINEAR = { enabled: true, clientId: "client-1" };
const APP = { enabled: true, appId: 7, slug: "example-devbox" };

describe("writeConfigKeys", () => {
  it("adds a nested key and keeps the rest", () => {
    const path = file({
      context: "kind-devbox",
      values: { ingress: { webhooks: { enabled: true } } },
    });
    writeConfigKeys(path, { "integrations.linear": LINEAR });
    expect(read(path)).toEqual({
      context: "kind-devbox",
      values: { ingress: { webhooks: { enabled: true } } },
      integrations: { linear: LINEAR },
    });
  });

  it("sets publicUrl and integrations.githubApp in one call, other keys unchanged", () => {
    const path = file({
      repos: [{ url: "https://github.com/example-org/example-repo.git" }],
      publicUrl: "https://old.example.com",
      integrations: { linear: LINEAR, slack: { enabled: true } },
    });
    writeConfigKeys(path, {
      publicUrl: "https://hooks.example.com",
      "integrations.githubApp": APP,
    });
    expect(read(path)).toEqual({
      repos: [{ url: "https://github.com/example-org/example-repo.git" }],
      publicUrl: "https://hooks.example.com",
      integrations: { linear: LINEAR, slack: { enabled: true }, githubApp: APP },
    });
  });

  it("writes 2-space JSON and a newline", () => {
    const path = file({ context: "c" });
    writeConfigKeys(path, { publicUrl: "https://hooks.example.com" });
    const text = readFileSync(path, "utf8");
    expect(JSON.parse(text)).toEqual({ context: "c", publicUrl: "https://hooks.example.com" });
    expect(text.endsWith("}\n")).toBe(true);
    expect(
      text
        .split("\n")
        .filter((l) => l.startsWith(" "))
        .every((l) => /^ {2}\S/.test(l)),
    ).toBe(true);
  });

  it("replaces an existing value", () => {
    const path = file({ context: "c", integrations: { linear: { clientId: "old" } } });
    writeConfigKeys(path, { "integrations.linear": LINEAR });
    expect(read(path)).toEqual({ context: "c", integrations: { linear: LINEAR } });
  });

  it("undefined deletes a key", () => {
    const path = file({ context: "c", publicUrl: "https://hooks.example.com" });
    writeConfigKeys(path, { publicUrl: undefined });
    expect(read(path)).toEqual({ context: "c" });
  });

  it("deleting the last key under integrations removes integrations", () => {
    const path = file({ context: "c", integrations: { linear: LINEAR } });
    writeConfigKeys(path, { "integrations.linear": undefined });
    expect(read(path)).toEqual({ context: "c" });
  });

  it("keeps other integrations when deleting one", () => {
    const path = file({ context: "c", integrations: { linear: LINEAR, githubApp: APP } });
    writeConfigKeys(path, { "integrations.linear": undefined });
    expect(read(path)).toEqual({ context: "c", integrations: { githubApp: APP } });
  });

  it("deleting a key that is not there changes nothing", () => {
    const path = file({ context: "c" });
    writeConfigKeys(path, { "integrations.linear": undefined });
    expect(read(path)).toEqual({ context: "c" });
  });
});
