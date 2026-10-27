import { expect, spyOn, test } from "bun:test";
import { unlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sandbox } from "@alibaba-group/opensandbox";
import {
  acquireLockFile,
  createSourceArchive,
  type HarnessTarget,
  installHarnessSource,
  loadSandboxConfig,
  runCheckedProcess,
  sandboxHarnessTarget,
  syncHarnessDependencies,
  validateHarnessWorktree,
} from "./harness-sandbox";

test("shared configuration leaves identity and lifetime decisions to the caller", () => {
  const devTimeout = process.env.DEV_TEST_SANDBOX_TIMEOUT_SECONDS;
  const evalTimeout = process.env.EVAL_SANDBOX_TIMEOUT_SECONDS;
  try {
    // Neither tool-specific setting should be parsed by the shared loader.
    process.env.DEV_TEST_SANDBOX_TIMEOUT_SECONDS = "not-an-infrastructure-setting";
    process.env.EVAL_SANDBOX_TIMEOUT_SECONDS = "not-an-infrastructure-setting";
    const config = loadSandboxConfig();
    expect(config).not.toHaveProperty("metadata");
    expect(config).not.toHaveProperty("timeoutSeconds");
    expect(config.daemonEnv.WORKSPACE).toBe("/workspace");
  } finally {
    if (devTimeout === undefined) delete process.env.DEV_TEST_SANDBOX_TIMEOUT_SECONDS;
    else process.env.DEV_TEST_SANDBOX_TIMEOUT_SECONDS = devTimeout;
    if (evalTimeout === undefined) delete process.env.EVAL_SANDBOX_TIMEOUT_SECONDS;
    else process.env.EVAL_SANDBOX_TIMEOUT_SECONDS = evalTimeout;
  }
});

test("source capture includes current source and scripts, excludes metadata, and freezes the bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-source-test-"));
  const worktree = join(root, "worktree with spaces");
  const archive = join(root, "source.tar.gz");
  try {
    await mkdir(join(worktree, "src/harness/__pycache__"), { recursive: true });
    await mkdir(join(worktree, "src/harness/.git"));
    await mkdir(join(worktree, "scripts"));
    await writeFile(join(worktree, "src/harness/main.py"), "original source\n");
    await writeFile(join(worktree, "scripts/helper.py"), "new untracked helper\n");
    await writeFile(join(worktree, "src/harness/__pycache__/main.pyc"), "bytecode");
    await writeFile(join(worktree, "src/harness/.git/config"), "git metadata");
    await writeFile(join(worktree, "pyproject.toml"), "image-owned manifest");
    await validateHarnessWorktree(worktree);
    await createSourceArchive(worktree, archive);
    await writeFile(join(worktree, "src/harness/main.py"), "changed after capture\n");
    const files = await runCheckedProcess(["tar", "-tzf", archive], "Listing test archive");
    expect(files).toContain("src/harness/main.py");
    expect(files).toContain("scripts/helper.py");
    expect(files).not.toContain("__pycache__");
    expect(files).not.toContain(".git");
    expect(files).not.toContain("pyproject.toml");
    expect(
      await runCheckedProcess(
        ["tar", "-xOzf", archive, "src/harness/main.py"],
        "Reading captured source",
      ),
    ).toBe("original source\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dependency sync uses the target and image-owned manifests", async () => {
  const calls: Array<[string, string, number]> = [];
  const target: HarnessTarget = {
    copyFile: async () => {
      throw new Error("sync must not copy files");
    },
    run: async (command, description, timeout) => {
      calls.push([command, description, timeout]);
    },
  };
  await syncHarnessDependencies(target);
  expect(calls).toEqual([
    [
      "cd /opt/harness && uv sync --frozen --no-dev",
      "Synchronizing frozen production dependencies",
      600,
    ],
  ]);
});

test("installation uses the supplied archive and cleans remote staging without deleting caller data", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-install-test-"));
  const archive = join(root, "retained source.tar.gz");
  const invocation = join(root, "kubectl.json");
  const kubectl = join(root, "kubectl");
  const previousKubectl = process.env.KUBECTL_BIN;
  try {
    await writeFile(archive, "retained archive bytes");
    await writeFile(
      kubectl,
      `#!${process.execPath}\nawait Bun.write(${JSON.stringify(invocation)}, JSON.stringify(process.argv.slice(2)));\n`,
      { mode: 0o700 },
    );
    process.env.KUBECTL_BIN = kubectl;
    for (const exitCode of [0, 1]) {
      const commands: string[] = [];
      const timeouts: number[] = [];
      const sandbox = {
        id: "sandbox-one",
        commands: {
          run: async (command: string, options: { timeoutSeconds: number }) => {
            commands.push(command);
            timeouts.push(options.timeoutSeconds);
            return {
              exitCode: commands.length === 1 ? exitCode : 0,
              logs: { stdout: [], stderr: [] },
            };
          },
        },
      } as unknown as Sandbox;
      const target = sandboxHarnessTarget(sandbox, "test-namespace");
      if (exitCode) {
        await expect(installHarnessSource(target, archive)).rejects.toThrow("remote exit code 1");
      } else {
        await installHarnessSource(target, archive);
      }
      const args = JSON.parse(await readFile(invocation, "utf8"));
      expect(args).toEqual([
        "cp",
        archive,
        expect.stringMatching(/^test-namespace\/sandbox-one-0:\/tmp\/harness-source-.*\.tar\.gz$/),
        "-c",
        "sandbox",
      ]);
      expect(commands).toHaveLength(2);
      expect(commands[0]).toContain("trap restore_source EXIT");
      expect(commands[1]).toMatch(/^rm -rf /);
      expect(timeouts).toEqual([300, 30]);
      expect(await readFile(archive, "utf8")).toBe("retained archive bytes");
    }
  } finally {
    if (previousKubectl === undefined) delete process.env.KUBECTL_BIN;
    else process.env.KUBECTL_BIN = previousKubectl;
    await rm(root, { recursive: true, force: true });
  }
});

test("copy failure skips source replacement and cleanup failure preserves the copy error", async () => {
  const calls: Array<[string, string, number]> = [];
  const target: HarnessTarget = {
    copyFile: async () => {
      throw new Error("copy failed");
    },
    run: async (command, description, timeout) => {
      calls.push([command, description, timeout]);
      throw new Error("cleanup failed");
    },
  };

  await expect(installHarnessSource(target, "/local/source.tar.gz")).rejects.toThrow("copy failed");
  expect(calls).toEqual([
    [expect.stringMatching(/^rm -rf /), "Cleaning harness source staging", 30],
  ]);
});

test("lockfile excludes a live holder and recovers a stale one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lockfile-"));
  const path = join(dir, "evaluation.lock");
  try {
    const release = await acquireLockFile(path, "busy");
    await expect(acquireLockFile(path, "busy")).rejects.toThrow("busy");
    await release();
    await writeFile(path, "2147483646\n");
    const again = await acquireLockFile(path, "busy");
    expect((await readFile(path, "utf8")).trim()).toBe(String(process.pid));
    await again();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("lockfile recovery keeps a lock another controller took after the stale check", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lockfile-"));
  const path = join(dir, "evaluation.lock");
  const stalePid = 2147483646;
  const otherPid = 2147483645;
  const realKill = process.kill.bind(process);
  // Between reading the stale pid and removing the lock, another controller
  // recovers it first: the stale file is gone and a fresh lock (a new file)
  // holds the path.
  const kill = spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid !== stalePid) return realKill(pid, signal);
    unlinkSync(path);
    writeFileSync(path, `${otherPid}\n`);
    throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
  });
  try {
    await writeFile(path, `${stalePid}\n`);
    await expect(acquireLockFile(path, "busy")).rejects.toThrow("busy");
    expect((await readFile(path, "utf8")).trim()).toBe(String(otherPid));
  } finally {
    kill.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("lockfile surfaces an unreadable lock instead of reporting it busy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lockfile-"));
  const path = join(dir, "evaluation.lock");
  try {
    await mkdir(path);
    await expect(acquireLockFile(path, "busy")).rejects.toThrow(/EISDIR/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("shared configuration forwards HARNESS_POLL_INTERVAL_SECONDS only when set", () => {
  const name = "HARNESS_POLL_INTERVAL_SECONDS";
  const previous = process.env[name];
  try {
    delete process.env[name];
    expect(loadSandboxConfig().daemonEnv).not.toHaveProperty(name);
    process.env[name] = "2.5";
    expect(loadSandboxConfig().daemonEnv[name]).toBe("2.5");
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
});

test("shared configuration forwards stage-specific HARNESS settings to the daemon", () => {
  const name = "HARNESS_PLANNING_REASONING_EFFORT";
  const previous = process.env[name];
  try {
    process.env[name] = "xhigh";
    expect(loadSandboxConfig().daemonEnv[name]).toBe("xhigh");
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
});

test("shared configuration sets no LLM endpoint or key of its own", () => {
  const names = ["HARNESS_LLM_BASE_URL", "HARNESS_LLM_API_KEY", "AZURE_FOUNDRY_KEY"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    const daemonEnv = loadSandboxConfig().daemonEnv;
    for (const name of names) expect(daemonEnv).not.toHaveProperty(name);
    process.env.HARNESS_LLM_API_KEY = "proxy-llm-dummy-token";
    expect(loadSandboxConfig().daemonEnv.HARNESS_LLM_API_KEY).toBe("proxy-llm-dummy-token");
  } finally {
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("shared configuration derives trusted orgs and users from GitHub settings", () => {
  const saved = { ...process.env };
  try {
    for (const name of Object.keys(process.env)) {
      if (name.startsWith("HARNESS_") || name.startsWith("GITHUB_TRUSTED_"))
        delete process.env[name];
    }
    Object.assign(process.env, {
      GITHUB_TRUSTED_ORGS: "acme, widgets",
      GITHUB_TRUSTED_USERS: "frodo samwise",
      HARNESS_TRUSTED_ORGS: "evil",
      HARNESS_TRUSTED_USERS: "gollum",
    });
    expect(loadSandboxConfig().daemonEnv).toMatchObject({
      HARNESS_TRUSTED_ORGS: "acme,widgets",
      HARNESS_TRUSTED_USERS: "frodo,samwise",
    });
  } finally {
    for (const name of Object.keys(process.env)) {
      if (!(name in saved)) delete process.env[name];
    }
    Object.assign(process.env, saved);
  }
});

test("shared configuration never forwards a real secret or the CLI token", () => {
  const set = { GITHUB_TOKEN: "real", LLM_API_KEY: "real", DEVBOX_CLI_TOKEN: "x" };
  const saved = { ...process.env };
  try {
    for (const name of Object.keys(process.env)) {
      if (
        name.startsWith("HARNESS_") ||
        name.startsWith("DEVBOX_") ||
        name.startsWith("GITHUB_TRUSTED_") ||
        name === "GITHUB_SANDBOX_TOKEN"
      )
        delete process.env[name];
    }
    Object.assign(process.env, set);
    expect(loadSandboxConfig().daemonEnv).toEqual({
      WORKSPACE: "/workspace",
      GITHUB_TOKEN: "proxy-github-dummy-token",
    });
  } finally {
    for (const name of Object.keys(process.env)) {
      if (!(name in saved)) delete process.env[name];
    }
    Object.assign(process.env, saved);
  }
});
