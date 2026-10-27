# Repository conventions

## Running and operating devbox

`skills/devbox/SKILL.md` explains how devbox works and how to set it up, use,
connect and troubleshoot it in every deployment mode. Claude Code loads it
from `.claude/skills/devbox`, a symlink. Keep it in step with the commands and
docs it names; `control-plane/scripts/skill.test.ts` checks that every script
and link in it exists.

## Environment variable namespaces

- Unprefixed and subsystem-prefixed variables such as `DATABASE_URL`, `GITHUB_*`
  and `SANDBOX_*` (including `SANDBOX_IMAGE`) configure the control plane or its
  infrastructure. They do not cross into sandboxes automatically.
- `HARNESS_*` is the namespace for operator-configurable settings read by the
  harness inside a sandbox. `control-plane/src/forwardedEnv.ts` forwards only
  its explicit allowlist and its enumerated stage model/reasoning patterns,
  never every variable sharing the prefix. This keeps Kubernetes Service links,
  platform-injected variables, and stray control-plane values out of sandboxes.
- Real secrets never use a forwarded name. Forwarded credential-shaped values,
  such as `HARNESS_LLM_API_KEY`, are proxy placeholders only; real credentials
  remain in the control plane or egress proxy.
- `DEVBOX_CLI_*` belongs only to the CLI and never crosses into a sandbox.
- Runtime-only `DEVBOX_*` names (`DEVBOX_DIR`, event paths, inbox and target ids,
  and related path settings) are created or consumed inside the sandbox. They
  are deliberately separate from forwarded configuration.
- A new harness setting requires updating its reader, the forwarding contract,
  and the contract inventory test. Do not introduce prefix-wide forwarding.

## Sandbox workspace ownership

The Kubernetes snapshot builder runs as non-root uid 1000 to satisfy restricted
pod security, while the harness runs as root. `harness/scripts/bootstrap.sh`
therefore configures Git to trust every directory below `/workspace`; removing
that trust breaks restored repositories with dubious-ownership errors.

Checks that run in a sandbox must exercise the workspace as the harness does.
In particular, Kubernetes end-to-end checks run Git against the restored repo,
so uid or ownership mismatches are caught rather than hidden by file-only tests.
