"""
Deterministic sandbox harness (v0). Top-level CLI dispatch.

The full `kind='assignment'` 5-stage pipeline (Setup -> Planning -> Implementation
-> Distillation -> Commit) lives in `handlers/assignment.py`; this module keeps
only genuinely shared / top-level code: the CLI entrypoint, a shared setting,
and a few re-exports for tests.
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Callable

from harness.archive import archive_main
from harness.distillation import (
    validate_distillation,  # noqa: F401  re-exported for harness.validate_distillation
)
from harness.env_flags import bool_env
from harness.memory import memory_main

# Kill-switch for the pre-planning repo sync in the assignment flow. Default on:
# it counters stale snapshot checkouts (the attached repos are re-snapshotted only
# every ~30 min). Set false to skip the sync if it ever misbehaves (proxy
# throttling, an unexpected non-ff divergence).
SYNC_REPOS_BEFORE_PLANNING = bool_env(
    "HARNESS_SYNC_REPOS_BEFORE_PLANNING", default=True
)


def run_daemon_cli(argv: list[str]) -> int:
    # No CLI args — all paths are derived from the DEVBOX_DIR env var (set by
    # CP at sandbox creation) via paths.py. argparse is kept for `--help`.
    parser = argparse.ArgumentParser(
        prog="harness daemon", description="Inbox event loop"
    )
    try:
        parser.parse_args(argv)
    except SystemExit as exc:
        code = exc.code
        return code if isinstance(code, int) else (0 if code is None else 2)

    # Imported lazily to keep the import direction one-way: daemon.py imports
    # harness.py at module top; importing daemon here (not at module top) avoids
    # a cycle.
    from harness.daemon import run_daemon

    return run_daemon()


ROOT_SUBCOMMANDS: dict[str, tuple[str, Callable[[list[str]], int]]] = {
    "daemon": ("Run inbox event loop", run_daemon_cli),
    "memory": ("Append a harness memory entry", memory_main),
    "archive": ("Archive harness artifacts into a tar.gz", archive_main),
}


def _build_root_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="harness",
        description="Harness CLI",
        add_help=False,
    )
    choices = [*ROOT_SUBCOMMANDS.keys(), "help"]
    parser.add_argument(
        "command",
        nargs="?",
        choices=choices,
        help="subcommand",
    )
    return parser


def _print_root_help() -> None:
    parser = _build_root_parser()
    print(parser.format_usage().rstrip())
    print(f"\n{parser.description}\n")
    print("subcommands:")
    width = max(len(name) for name in ROOT_SUBCOMMANDS)
    for name, (description, _handler) in ROOT_SUBCOMMANDS.items():
        print(f"  {name:<{width}}  {description}")
    print("\nUse 'harness <subcommand> --help' for subcommand-specific usage.")


def main(argv: list[str] | None = None) -> int:
    parser = _build_root_parser()
    args = list(argv if argv is not None else sys.argv[1:])
    if args and args[0] in {"-h", "--help"}:
        _print_root_help()
        return 0
    if not args:
        _print_root_help()
        return 0
    try:
        ns, rest = parser.parse_known_args(args)
    except SystemExit as exc:
        code = exc.code
        return code if isinstance(code, int) else (0 if code is None else 2)

    command = ns.command
    if command == "help":
        if not rest:
            _print_root_help()
            return 0
        subcommand = rest[0]
        handler_entry = ROOT_SUBCOMMANDS.get(subcommand)
        if handler_entry is None:
            print(f"harness: unknown command {subcommand!r}", file=sys.stderr)
            return 2
        _, handler = handler_entry
        return handler(["--help"])

    handler_entry = ROOT_SUBCOMMANDS.get(command)
    if handler_entry is None:
        _print_root_help()
        return 2
    _, handler = handler_entry
    return handler(rest)


if __name__ == "__main__":
    raise SystemExit(main())
