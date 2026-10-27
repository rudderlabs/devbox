import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRY = join(import.meta.dir, "../../githubTokenMinter.ts");
const TOKEN = "ghs_secretInstallationToken0123456789";
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const PEM_BODY_LINE = privateKey.split("\n")[1] as string;

let dir: string;
let keyFile: string;
let status = 201;
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "devbox-minter-entry-"));
  keyFile = join(dir, "key.pem");
  writeFileSync(keyFile, privateKey);
  server = Bun.serve({
    port: 0,
    fetch: () =>
      status === 201
        ? Response.json(
            { token: TOKEN, expires_at: new Date(Date.now() + 3_600_000).toISOString() },
            { status: 201 },
          )
        : Response.json({ message: "Bad credentials" }, { status }),
  });
});
afterAll(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

async function run(env: Record<string, string>, args: string[] = ["--once"]) {
  const proc = Bun.spawn(["bun", "run", ENTRY, ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

const goodEnv = (tokenPath: string) => ({
  GITHUB_APP_ID: "123",
  GITHUB_APP_INSTALLATION_ID: "456",
  GITHUB_APP_PRIVATE_KEY_FILE: keyFile,
  GITHUB_TOKEN_SINK: `file:${tokenPath}`,
  GITHUB_API_BASE_URL: `http://localhost:${server.port}`,
});

describe("bun run github-token", () => {
  it("exits 1 naming the variable on bad input", async () => {
    const r = await run({ ...goodEnv(join(dir, "t0")), GITHUB_APP_ID: "abc" });
    expect(r.code).toBe(1);
    expect(r.stderr).toBe("github-token: GITHUB_APP_ID must be a positive integer\n");
    expect(r.stdout + r.stderr).not.toContain("PRIVATE KEY");
    expect(r.stdout + r.stderr).not.toContain(PEM_BODY_LINE);
  });

  it("--once exits 1 at once on a 401 and writes nothing", async () => {
    status = 401;
    const tokenPath = join(dir, "t1");
    const started = Date.now();
    const r = await run(goodEnv(tokenPath));
    expect(r.code).toBe(1);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r.stderr).toContain("github-token: token request failed: HTTP 401: Bad credentials");
    expect(existsSync(tokenPath)).toBe(false);
    expect(r.stdout + r.stderr).not.toContain("PRIVATE KEY");
    expect(r.stdout + r.stderr).not.toContain(PEM_BODY_LINE);
  });

  it("--once writes the token file and exits 0", async () => {
    status = 201;
    const tokenPath = join(dir, "t2");
    const r = await run(goodEnv(tokenPath));
    expect(r.code).toBe(0);
    expect(readFileSync(tokenPath, "utf8").trim()).toBe(TOKEN);
    const out = r.stdout + r.stderr;
    expect(out).not.toContain("PRIVATE KEY");
    expect(out).not.toContain(PEM_BODY_LINE);
    expect(out).not.toContain(TOKEN);
  });
});
