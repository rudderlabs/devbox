"""Tests for the plugin loader, its hooks and `harness plugins`."""

from __future__ import annotations

import io
import os
import signal
import sys
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from importlib import metadata
from pathlib import Path
from typing import ClassVar
from unittest.mock import patch

from harness.plugins import (
    API_VERSION,
    HOOKS,
    SUPPORTED_API_VERSIONS,
    HookSpec,
    Plugin,
    PluginContext,
    hook,
    load_plugins,
)
from harness.plugins import _context as context_module
from harness.plugins import cli as plugins_cli
from harness.plugins._context import plugin_settings
from harness.plugins._registry import enabled_names
from harness.plugins.testing import registry_for

EXAMPLE_SRC = Path(__file__).resolve().parents[1] / "examples/plugins/hello/src"


class Alpha(Plugin):
    name = "alpha"
    requires_api = 1
    calls: ClassVar[list[str]] = []

    @hook("daemon_start")
    def start(self, ctx: PluginContext) -> None:
        Alpha.calls.append(f"alpha:{ctx.name}")


class Beta(Plugin):
    name = "beta"
    requires_api = 1

    @hook("daemon_start")
    def start(self, ctx: PluginContext) -> None:
        Alpha.calls.append("beta")


class Raises(Plugin):
    name = "raises"
    requires_api = 1

    @hook("daemon_start")
    def start(self, ctx: PluginContext) -> None:
        raise RuntimeError("boom")


class Exits(Plugin):
    name = "exits"
    requires_api = 1

    @hook("daemon_start")
    def start(self, ctx: PluginContext) -> None:
        sys.exit(3)


class RaisingProperty(Plugin):
    name = "raisingproperty"
    requires_api = 1
    reads: ClassVar[int] = 0

    @property
    def expensive(self) -> str:
        RaisingProperty.reads += 1
        raise RuntimeError("read while loading")

    @hook("daemon_start")
    def start(self, ctx: PluginContext) -> None:
        Alpha.calls.append("raisingproperty")


class RaisingLookup(Plugin):
    """Raises from the attribute lookup the loader does on a marked method."""

    name = "raisinglookup"
    requires_api = 1

    @hook("daemon_start")
    def start(self, ctx: PluginContext) -> None: ...

    def __getattribute__(self, attr: str):
        if attr == "start":
            raise RuntimeError("no start for you")
        return super().__getattribute__(attr)


class ExitsOnCreate(Plugin):
    name = "exitsoncreate"
    requires_api = 1

    def __init__(self) -> None:
        sys.exit(4)


class WrappedHooks(Plugin):
    """Marks a static method; the marker is under the wrapper."""

    name = "wrappedhooks"
    requires_api = 1

    @staticmethod
    @hook("daemon_start")
    def start(ctx: PluginContext) -> None:
        Alpha.calls.append(f"static:{ctx.name}")


class ClassHook(Plugin):
    name = "classhook"
    requires_api = 1

    @classmethod
    @hook("daemon_start")
    def start(cls, ctx: PluginContext) -> None:
        Alpha.calls.append(f"class:{cls.name}")


class StaticWrongSignature(Plugin):
    name = "staticwrongsignature"
    requires_api = 1

    @staticmethod
    @hook("daemon_start")
    def start() -> None: ...


class KeywordOnly(Plugin):
    name = "keywordonly"
    requires_api = 1

    @hook("daemon_start")
    def start(self, ctx: PluginContext, *, required: str) -> None: ...


class ExtraBeforeStar(Plugin):
    name = "extrabeforestar"
    requires_api = 1

    @hook("daemon_start")
    def start(self, ctx: PluginContext, required: str, *rest: str) -> None: ...


class AsyncHook(Plugin):
    name = "asynchook"
    requires_api = 1

    @hook("daemon_start")
    async def start(self, ctx: PluginContext) -> None: ...


class GeneratorHook(Plugin):
    name = "generatorhook"
    requires_api = 1

    @hook("daemon_start")
    def start(self, ctx: PluginContext):
        yield


class TakesAnything(Plugin):
    name = "takesanything"
    requires_api = 1

    @hook("daemon_start")
    def start(self, *args: object, **kwargs: object) -> None:
        Alpha.calls.append("takesanything")


class SignalsOnCreate(Plugin):
    """Stands in for a shutdown signal that arrives while a plugin loads."""

    name = "signalsoncreate"
    requires_api = 1

    def __init__(self) -> None:
        os.kill(os.getpid(), signal.SIGTERM)
        time.sleep(5)


class SignalsInHook(Plugin):
    name = "signalsinhook"
    requires_api = 1

    @hook("daemon_start")
    def start(self, ctx: PluginContext) -> None:
        os.kill(os.getpid(), signal.SIGTERM)
        time.sleep(5)


class AlphaTwo(Plugin):
    name = "alpha_two"
    requires_api = 1


class Slow(Plugin):
    name = "slow"
    requires_api = 1

    @hook("daemon_start")
    def start(self, ctx: PluginContext) -> None:
        time.sleep(5)


class NoHooks(Plugin):
    name = "nohooks"
    requires_api = 1


class OldApi(Plugin):
    name = "oldapi"
    requires_api = 0


class WrongName(Plugin):
    name = "something_else"
    requires_api = 1


class UnknownHook(Plugin):
    name = "unknownhook"
    requires_api = 1

    @hook("no_such_hook")
    def start(self, ctx: PluginContext) -> None: ...


class WrongSignature(Plugin):
    name = "wrongsignature"
    requires_api = 1

    @hook("daemon_start")
    def start(self) -> None: ...


class TwoHandlers(Plugin):
    name = "twohandlers"
    requires_api = 1

    @hook("daemon_start")
    def one(self, ctx: PluginContext) -> None: ...

    @hook("daemon_start")
    def two(self, ctx: PluginContext) -> None: ...


class NeedsArgument(Plugin):
    name = "needsargument"
    requires_api = 1

    def __init__(self, required: str) -> None:
        self.required = required


def _entry_point(name: str, cls: type | str) -> metadata.EntryPoint:
    target = cls if isinstance(cls, str) else f"{__name__}:{cls.__name__}"
    return metadata.EntryPoint(name=name, value=target, group="devbox.plugins")


class PluginTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        Alpha.calls = []

    def tearDown(self) -> None:
        # Collect whatever a test spawned, so none outlives it.
        for proc in list(context_module._spawned.values()):
            if proc.poll() is None:
                proc.kill()
            proc.wait()
        context_module._spawned.clear()
        context_module._exited.clear()
        self._tmp.cleanup()

    def load(self, entry_points: list[metadata.EntryPoint], env=None):
        return load_plugins(
            env=env or {},
            entry_points=entry_points,
            state_root=self.root / "state",
            runtime_root=self.root / "runtime",
            workspace=self.root / "workspace",
        )


class TestLoading(PluginTestCase):
    def test_no_plugins_installed_is_an_empty_registry(self) -> None:
        registry = self.load([])
        self.assertEqual(registry.plugins, [])
        self.assertEqual(registry.problems, [])
        registry.run("daemon_start")

    def test_loads_in_name_order_when_unset(self) -> None:
        registry = self.load([_entry_point("beta", Beta), _entry_point("alpha", Alpha)])
        self.assertEqual([p.name for p in registry.plugins], ["alpha", "beta"])
        self.assertEqual(registry.problems, [])

    def test_harness_plugins_selects_and_orders(self) -> None:
        entry_points = [_entry_point("alpha", Alpha), _entry_point("beta", Beta)]
        registry = self.load(entry_points, {"HARNESS_PLUGINS": "beta, alpha"})
        self.assertEqual([p.name for p in registry.plugins], ["beta", "alpha"])
        registry = self.load(entry_points, {"HARNESS_PLUGINS": "beta"})
        self.assertEqual([p.name for p in registry.plugins], ["beta"])

    def test_harness_plugins_none_turns_all_off(self) -> None:
        registry = self.load(
            [_entry_point("alpha", Alpha)], {"HARNESS_PLUGINS": "none"}
        )
        self.assertEqual(registry.plugins, [])
        self.assertEqual(registry.problems, [])

    def test_enabled_names(self) -> None:
        self.assertIsNone(enabled_names({}))
        self.assertIsNone(enabled_names({"HARNESS_PLUGINS": "  "}))
        self.assertEqual(enabled_names({"HARNESS_PLUGINS": "None"}), [])
        self.assertEqual(enabled_names({"HARNESS_PLUGINS": "b a,b"}), ["b", "a"])
        self.assertEqual(
            enabled_names({"HARNESS_PLUGINS": "Beta,ALPHA"}), ["beta", "alpha"]
        )

    def test_harness_plugins_is_read_without_regard_to_case(self) -> None:
        registry = self.load(
            [_entry_point("alpha", Alpha), _entry_point("beta", Beta)],
            {"HARNESS_PLUGINS": "Beta, Alpha"},
        )
        self.assertEqual([p.name for p in registry.plugins], ["beta", "alpha"])
        self.assertEqual(registry.problems, [])

    def test_listed_but_not_installed_is_a_problem(self) -> None:
        registry = self.load(
            [_entry_point("alpha", Alpha)], {"HARNESS_PLUGINS": "alpha,ghost"}
        )
        self.assertEqual([p.name for p in registry.plugins], ["alpha"])
        self.assertEqual(
            [str(p) for p in registry.problems],
            ["ghost: listed in HARNESS_PLUGINS but not installed"],
        )

    def test_a_bad_plugin_is_left_out_and_the_rest_load(self) -> None:
        cases = {
            "oldapi": (OldApi, "requires_api is 0"),
            "wrongname": (WrongName, "differs from its entry point name"),
            "unknownhook": (UnknownHook, "unknown hook 'no_such_hook'"),
            "wrongsignature": (WrongSignature, "must take (self, ctx)"),
            "twohandlers": (TwoHandlers, "more than one handler"),
            "needsargument": (NeedsArgument, "could not be created"),
            "raisinglookup": (RaisingLookup, "could not be checked"),
            "exitsoncreate": (ExitsOnCreate, "could not be created: SystemExit: 4"),
            "staticwrongsignature": (StaticWrongSignature, "must take (self, ctx)"),
            "keywordonly": (KeywordOnly, "must take (self, ctx)"),
            "extrabeforestar": (ExtraBeforeStar, "must take (self, ctx)"),
            "asynchook": (AsyncHook, "must be a plain function"),
            "generatorhook": (GeneratorHook, "must be a plain function"),
            "missing": ("no_such_module_for_plugins:Thing", "import failed"),
            "notaplugin": (f"{__name__}:PluginTestCase", "not a harness.plugins"),
        }
        for name, (target, message) in cases.items():
            with self.subTest(name):
                registry = self.load([
                    _entry_point(name, target),
                    _entry_point("alpha", Alpha),
                ])
                self.assertEqual([p.name for p in registry.plugins], ["alpha"])
                self.assertEqual(len(registry.problems), 1)
                self.assertEqual(registry.problems[0].plugin, name)
                self.assertIn(message, registry.problems[0].message)

    def test_invalid_and_duplicate_names_are_problems(self) -> None:
        registry = self.load([
            _entry_point("Bad-Name", Alpha),
            _entry_point("alpha", Alpha),
            _entry_point("alpha", Alpha),
        ])
        self.assertEqual([p.name for p in registry.plugins], ["alpha"])
        self.assertEqual(
            sorted(p.plugin for p in registry.problems), ["Bad-Name", "alpha"]
        )

    def test_a_module_that_exits_on_import_is_left_out(self) -> None:
        module = "harness_test_plugin_that_exits"
        (self.root / f"{module}.py").write_text("import sys\nsys.exit(5)\n", "utf-8")
        with patch.object(sys, "path", [str(self.root), *sys.path]):
            registry = self.load([
                _entry_point("exitsonimport", f"{module}:Thing"),
                _entry_point("alpha", Alpha),
            ])
        self.addCleanup(sys.modules.pop, module, None)
        self.assertEqual([p.name for p in registry.plugins], ["alpha"])
        self.assertEqual(
            [str(p) for p in registry.problems],
            ["exitsonimport: import failed: SystemExit: 5"],
        )

    def test_a_property_is_not_read_while_loading(self) -> None:
        RaisingProperty.reads = 0
        registry = self.load([
            _entry_point("raisingproperty", RaisingProperty),
            _entry_point("alpha", Alpha),
        ])
        self.assertEqual(registry.problems, [])
        self.assertEqual(
            [p.name for p in registry.plugins], ["alpha", "raisingproperty"]
        )
        self.assertEqual(list(registry.plugins[1].hooks), ["daemon_start"])
        self.assertEqual(RaisingProperty.reads, 0)

    def test_a_name_that_would_share_settings_is_left_out(self) -> None:
        # alpha would read HARNESS_PLUGIN_ALPHA_TWO_<KEY> as its own two_<key>.
        registry = self.load([
            _entry_point("alpha_two", AlphaTwo),
            _entry_point("alpha", Alpha),
            _entry_point("alphabet", NoHooks),
        ])
        self.assertEqual([p.name for p in registry.plugins], ["alpha"])
        problems = {p.plugin: p.message for p in registry.problems}
        self.assertIn("plugin 'alpha' and an underscore", problems["alpha_two"])
        # "alphabet" shares letters, not a settings prefix; it fails on its
        # class name only.
        self.assertIn("differs from its entry point name", problems["alphabet"])

    def test_an_overlapping_name_is_fine_when_the_other_is_not_enabled(self) -> None:
        registry = self.load(
            [_entry_point("alpha_two", AlphaTwo), _entry_point("alpha", Alpha)],
            {"HARNESS_PLUGINS": "alpha_two"},
        )
        self.assertEqual([p.name for p in registry.plugins], ["alpha_two"])
        self.assertEqual(registry.problems, [])

    def test_a_shutdown_signal_while_loading_is_not_a_plugin_problem(self) -> None:
        # The daemon's SIGTERM handler calls sys.exit(0) on the main thread.
        previous = signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
        self.addCleanup(signal.signal, signal.SIGTERM, previous)
        with self.assertRaises(SystemExit):
            self.load([_entry_point("signalsoncreate", SignalsOnCreate)])

    def test_a_plugin_without_hooks_loads(self) -> None:
        registry = self.load([_entry_point("nohooks", NoHooks)])
        self.assertEqual(registry.problems, [])
        self.assertEqual(dict(registry.plugins[0].hooks), {})

    def test_current_api_version_is_supported(self) -> None:
        self.assertIn(API_VERSION, SUPPORTED_API_VERSIONS)


class TestHooks(PluginTestCase):
    def test_runs_each_plugin_in_order(self) -> None:
        registry = registry_for([Alpha, Beta], root=self.root)
        registry.run("daemon_start")
        self.assertEqual(Alpha.calls, ["alpha:alpha", "beta"])

    def test_a_raising_hook_is_logged_and_the_next_plugin_runs(self) -> None:
        registry = registry_for([Raises, Beta], root=self.root)
        with self.assertLogs("harness.plugins", level="ERROR") as logs:
            registry.run("daemon_start")
        self.assertEqual(Alpha.calls, ["beta"])
        self.assertIn("plugin raises: daemon_start failed", logs.output[0])
        self.assertIn("RuntimeError: boom", logs.output[0])

    def test_a_hook_that_exits_is_a_failed_hook(self) -> None:
        registry = registry_for([Exits, Beta], root=self.root)
        with self.assertLogs("harness.plugins", level="ERROR") as logs:
            registry.run("daemon_start")
        self.assertEqual(Alpha.calls, ["beta"])
        self.assertIn("plugin exits: daemon_start failed", logs.output[0])
        self.assertIn("SystemExit: 3", logs.output[0])

    def test_static_and_class_method_hooks_are_found_and_called(self) -> None:
        registry = registry_for([WrappedHooks, ClassHook], root=self.root)
        for plugin in registry.plugins:
            self.assertEqual(list(plugin.hooks), ["daemon_start"])
        registry.run("daemon_start")
        self.assertEqual(Alpha.calls, ["static:wrappedhooks", "class:classhook"])

    def test_a_shutdown_signal_during_a_hook_stops_the_run(self) -> None:
        previous = signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
        self.addCleanup(signal.signal, signal.SIGTERM, previous)
        registry = registry_for([SignalsInHook, Beta], root=self.root)
        with self.assertRaises(SystemExit):
            registry.run("daemon_start")
        self.assertEqual(Alpha.calls, [])

    def test_a_hook_that_takes_anything_fits(self) -> None:
        registry = registry_for([TakesAnything], root=self.root)
        registry.run("daemon_start")
        self.assertEqual(Alpha.calls, ["takesanything"])

    def test_a_hook_over_budget_is_left_behind(self) -> None:
        registry = registry_for([Slow, Beta], root=self.root)
        short = HookSpec(params=("ctx",), budget_seconds=0.05, summary="")
        started = time.monotonic()
        with (
            patch.dict(HOOKS, {"daemon_start": short}),
            self.assertLogs("harness.plugins", level="WARNING") as logs,
        ):
            registry.run("daemon_start")
        self.assertLess(time.monotonic() - started, 2)
        self.assertEqual(Alpha.calls, ["beta"])
        self.assertIn("still running", logs.output[0])

    def test_registry_for_raises_on_a_plugin_that_would_not_load(self) -> None:
        with self.assertRaisesRegex(ValueError, "requires_api"):
            registry_for([OldApi], root=self.root)
        with self.assertRaisesRegex(ValueError, "alpha_two: its name starts with"):
            registry_for([Alpha, AlphaTwo], root=self.root)


class TestContext(PluginTestCase):
    def context(self, env=None) -> PluginContext:
        registry = registry_for([Alpha], root=self.root, env=env)
        return registry.context(registry.plugins[0])

    def test_settings_come_only_from_the_plugins_prefix(self) -> None:
        env = {
            "HARNESS_PLUGIN_ALPHA_GREETING": "hi",
            "HARNESS_PLUGIN_ALPHA_MAX_ITEMS": "3",
            "HARNESS_PLUGIN_ALPHA_": "empty key",
            "HARNESS_PLUGIN_BETA_GREETING": "other plugin",
            "HARNESS_MODEL": "core setting",
        }
        self.assertEqual(
            plugin_settings("alpha", env), {"greeting": "hi", "max_items": "3"}
        )
        self.assertEqual(self.context(env).settings["greeting"], "hi")

    def test_directories_are_per_plugin(self) -> None:
        ctx = self.context()
        self.assertEqual(ctx.state_dir, self.root / "state" / "alpha")
        self.assertEqual(ctx.runtime_dir, self.root / "runtime" / "alpha")
        self.assertEqual(ctx.workspace, self.root / "workspace")

    def _wait_for(self, path: Path, text: str) -> None:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if path.exists() and text in path.read_text(encoding="utf-8"):
                return
            time.sleep(0.05)
        self.fail(f"{path} never contained {text!r}")

    def test_spawn_runs_detached_and_logs_to_the_state_dir(self) -> None:
        ctx = self.context()
        pid = ctx.spawn(
            [sys.executable, "-c", "import os; print('from', os.environ['WHO'])"],
            log="out.log",
            env={"WHO": "plugin"},
        )
        self.assertIsInstance(pid, int)
        self._wait_for(ctx.state_dir / "out.log", "from plugin")

    def test_spawn_once_skips_while_the_first_is_alive(self) -> None:
        ctx = self.context()
        sleeper = [sys.executable, "-c", "import time; time.sleep(30)"]
        first = ctx.spawn(sleeper, log="out.log", once="server")
        self.assertIsInstance(first, int)
        self.assertIsNone(ctx.spawn(sleeper, log="out.log", once="server"))
        # Another name is other work.
        other = ctx.spawn(sleeper, log="out.log", once="worker")
        self.assertIsInstance(other, int)

    def test_spawn_once_starts_again_after_the_first_exits(self) -> None:
        ctx = self.context()
        first = ctx.spawn([sys.executable, "-c", "pass"], log="out.log", once="job")
        self.assertIsInstance(first, int)
        deadline = time.monotonic() + 10
        second = None
        while second is None and time.monotonic() < deadline:
            time.sleep(0.05)
            second = ctx.spawn(
                [sys.executable, "-c", "pass"], log="out.log", once="job"
            )
        self.assertIsInstance(second, int)
        self.assertNotEqual(first, second)

    def test_spawn_once_starts_again_after_a_stale_marker(self) -> None:
        ctx = self.context()
        ctx.runtime_dir.mkdir(parents=True)
        (ctx.runtime_dir / "server.pid").write_text("not a pid\n", encoding="utf-8")
        pid = ctx.spawn([sys.executable, "-c", "pass"], log="out.log", once="server")
        self.assertIsInstance(pid, int)
        self.assertEqual(
            (ctx.runtime_dir / "server.pid").read_text(encoding="utf-8").strip(),
            str(pid),
        )

    def test_a_finished_process_is_collected_without_another_spawn(self) -> None:
        ctx = self.context()
        pid = ctx.spawn([sys.executable, "-c", "pass"], log="a.log")
        deadline = time.monotonic() + 10
        while context_module._spawned and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertEqual(context_module._spawned, {})
        self.assertIn(pid, context_module._exited)

    def test_spawn_once_from_two_threads_starts_one_process(self) -> None:
        ctx = self.context()
        sleeper = [sys.executable, "-c", "import time; time.sleep(30)"]
        barrier = threading.Barrier(8)
        pids: list[int | None] = []

        def launch() -> None:
            barrier.wait()
            pids.append(ctx.spawn(sleeper, log="a.log", once="server"))

        threads = [threading.Thread(target=launch) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(len([pid for pid in pids if pid is not None]), 1)

    def test_spawn_rejects_paths_as_names(self) -> None:
        ctx = self.context()
        for kwargs in ({"log": "../out.log"}, {"log": "out.log", "once": "a/b"}):
            with self.subTest(kwargs), self.assertRaises(ValueError):
                ctx.spawn([sys.executable, "-c", "pass"], **kwargs)
        with self.assertRaises(ValueError):
            ctx.spawn([], log="out.log")


class TestExamplePlugin(PluginTestCase):
    def test_the_example_loads_and_records_a_start(self) -> None:
        sys.path.insert(0, str(EXAMPLE_SRC))
        self.addCleanup(sys.path.remove, str(EXAMPLE_SRC))
        self.addCleanup(sys.modules.pop, "devbox_hello_plugin", None)
        registry = self.load(
            [_entry_point("hello", "devbox_hello_plugin:Hello")],
            {"HARNESS_PLUGIN_HELLO_GREETING": "good morning"},
        )
        self.assertEqual(registry.problems, [])
        registry.run("daemon_start")
        log = (self.root / "state" / "hello" / "starts.log").read_text(encoding="utf-8")
        self.assertIn("good morning", log)


class TestCli(PluginTestCase):
    def run_cli(self, argv: list[str], entry_points: list[metadata.EntryPoint]):
        out, err = io.StringIO(), io.StringIO()
        registry = self.load(entry_points)
        with (
            patch.object(plugins_cli, "load_plugins", return_value=registry),
            redirect_stdout(out),
            redirect_stderr(err),
        ):
            rc = plugins_cli.plugins_main(argv)
        return rc, out.getvalue(), err.getvalue()

    def test_check_passes_with_no_plugins(self) -> None:
        rc, out, err = self.run_cli(["check"], [])
        self.assertEqual(rc, 0)
        self.assertIn("no plugins loaded", out)
        self.assertEqual(err, "")

    def test_check_lists_plugins_and_passes(self) -> None:
        rc, out, _err = self.run_cli(["check"], [_entry_point("alpha", Alpha)])
        self.assertEqual(rc, 0)
        self.assertIn("alpha  daemon_start", out)
        self.assertIn(f"ok (plugin API {API_VERSION})", out)

    def test_check_fails_on_any_problem(self) -> None:
        rc, out, err = self.run_cli(
            ["check"], [_entry_point("alpha", Alpha), _entry_point("oldapi", OldApi)]
        )
        self.assertEqual(rc, 1)
        self.assertEqual(out, "")
        self.assertIn("harness plugins check: oldapi: requires_api", err)

    def test_list_shows_problems_but_exits_zero(self) -> None:
        rc, out, err = self.run_cli(
            ["list"], [_entry_point("alpha", Alpha), _entry_point("oldapi", OldApi)]
        )
        self.assertEqual(rc, 0)
        self.assertIn("alpha", out)
        self.assertIn("problem: oldapi", err)

    def test_an_action_is_required(self) -> None:
        rc, _out, _err = self.run_cli([], [])
        self.assertEqual(rc, 2)


if __name__ == "__main__":
    unittest.main()
