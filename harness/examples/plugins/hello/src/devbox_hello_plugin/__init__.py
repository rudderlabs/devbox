"""Example harness plugin: records each daemon start in its state directory.

It shows the three things a first plugin needs: a namespaced name, a hook
and a setting. See docs/plugins.md.
"""

from __future__ import annotations

from datetime import UTC, datetime

from harness.plugins import Plugin, PluginContext, hook


class Hello(Plugin):
    name = "example.hello"
    requires_api = 1

    @hook("daemon_start")
    def greet(self, ctx: PluginContext) -> None:
        # HARNESS_PLUGIN_EXAMPLE_HELLO_GREETING, when the image or the operator sets it.
        greeting = ctx.settings.get("greeting", "hello")
        ctx.state_dir.mkdir(parents=True, exist_ok=True)
        with (ctx.state_dir / "starts.log").open("a", encoding="utf-8") as out:
            out.write(f"{datetime.now(UTC).isoformat()} {greeting}\n")
        ctx.log.info("%s from the example plugin", greeting)
