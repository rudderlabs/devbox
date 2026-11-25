"""``harness plugins``: list the installed plugins, or check them."""

from __future__ import annotations

import argparse
import sys

from harness.plugins._api import API_VERSION
from harness.plugins._registry import PluginRegistry, load_plugins


def _print_plugins(registry: PluginRegistry) -> None:
    if not registry.plugins:
        print("no plugins loaded")
        return
    width = max(len(plugin.name) for plugin in registry.plugins)
    for plugin in registry.plugins:
        hooks = ", ".join(sorted(plugin.hooks)) or "no hooks"
        source = f"  ({plugin.source})" if plugin.source else ""
        print(f"{plugin.name:<{width}}  {hooks}{source}")


def plugins_main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="harness plugins",
        description="List or check installed plugins",
    )
    sub = parser.add_subparsers(dest="action", required=True)
    sub.add_parser("list", help="show the plugins the daemon would load")
    sub.add_parser(
        "check",
        help="load every plugin and exit non-zero if any cannot be loaded",
    )
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        code = exc.code
        return code if isinstance(code, int) else (0 if code is None else 2)

    registry = load_plugins()
    if args.action == "list":
        _print_plugins(registry)
        for problem in registry.problems:
            print(f"problem: {problem}", file=sys.stderr)
        return 0

    for problem in registry.problems:
        print(f"harness plugins check: {problem}", file=sys.stderr)
    if registry.problems:
        return 1
    _print_plugins(registry)
    print(f"ok (plugin API {API_VERSION})")
    return 0
