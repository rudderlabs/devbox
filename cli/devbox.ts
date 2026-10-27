#!/usr/bin/env bun
// devbox: a CLI over the control-plane HTTP API. Wires the real core into the
// interface. Config comes from flags, env, then a profile in the
// config file `bun run up` and `bun run k8s:install` write; the CLI writes only
// the config file, through `devbox profile`.
import { ApiClient } from "./core/api";
import { bindCore } from "./core/ops";
import { realConfigFs } from "./interface/configFile";
import { EXIT } from "./interface/exit";
import { runCli } from "./interface/main";
import { bunVersionWarning } from "./interface/runtime";

const interrupt = new AbortController();
process.on("SIGINT", () => {
  if (interrupt.signal.aborted) process.exit(EXIT.interrupted);
  interrupt.abort();
  // Safety net if something ignores the signal (e.g. a pending stdin read).
  setTimeout(() => process.exit(EXIT.interrupted), 1000).unref();
});

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

const warning = bunVersionWarning(Bun.version);
if (warning) process.stderr.write(`${warning}\n`);

process.exitCode = await runCli(
  process.argv.slice(2),
  {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    readStdin: () => Bun.stdin.text(),
    readFile: (path) => Bun.file(path).text(),
    env: process.env,
    configFs: realConfigFs,
    isTTY: process.stdout.isTTY === true,
    now: () => Date.now(),
    interrupt: interrupt.signal,
  },
  (config) => bindCore(new ApiClient(config, fetch), { sleep }),
);
