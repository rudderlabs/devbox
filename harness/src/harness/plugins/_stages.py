"""The hooks of one round: an assignment's stages, or a follow-up's start.

``RoundPlugins`` is what a round's handler holds: the registry bound to one
inbox entry. Each method runs one hook on every plugin that handles it and
returns the stage's artifact with the plugins' results merged in.

A hook that saves its result is called once per assignment. Its result is
written under the plugin's state directory, keyed by inbox id, before it is
merged; on a restart the saved result is merged again and the hook is not
called. A hook that raised or overran its budget saved nothing, so a restart
calls it again. Merging is idempotent, so an artifact that already carries the
results is returned unchanged.
"""

from __future__ import annotations

import copy
import json
import logging
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from harness.plugins._api import HOOKS, HookResult, PrSection, TaskInfo
from harness.plugins._registry import LoadedPlugin, PluginRegistry
from harness.util import safe_marker_fragment, write_json

if TYPE_CHECKING:
    from harness.events import RoundEvents

# The key in plan.json and implementation.json that holds plugin data, one
# entry per plugin name.
EXTENSIONS_KEY = "extensions"

_log = logging.getLogger("harness.plugins")


def _normalize(hook_name: str, value: Any) -> HookResult:
    """A hook's return value as a HookResult. Raises on one it may not return."""
    spec = HOOKS[hook_name]
    if value is None:
        return HookResult()
    result = value if isinstance(value, HookResult) else HookResult(data=value)
    if result.data is not None and not isinstance(result.data, Mapping):
        raise TypeError("data must be a mapping or None")
    sections = tuple(result.pr_sections)
    if sections and not spec.pr_sections:
        raise TypeError(f"{hook_name} may not return pull request sections")
    for section in sections:
        if not isinstance(section, PrSection):
            raise TypeError("pr_sections must hold PrSection values")
        for name in ("repo", "title", "body"):
            text = getattr(section, name)
            if not isinstance(text, str) or not text.strip():
                raise TypeError(f"PrSection.{name} must be a non-empty string")
    data = None if result.data is None else json.loads(json.dumps(result.data))
    return HookResult(data=data, pr_sections=sections)


def _to_json(result: HookResult) -> dict[str, Any]:
    return {
        "data": result.data,
        "pr_sections": [
            {"repo": s.repo, "title": s.title, "body": s.body}
            for s in result.pr_sections
        ],
    }


def _from_json(raw: Any) -> HookResult:
    return HookResult(
        data=raw["data"],
        pr_sections=tuple(PrSection(**section) for section in raw["pr_sections"]),
    )


def _render(section: PrSection) -> str:
    return f"## {section.title.strip()}\n\n{section.body.strip()}\n"


@dataclass(frozen=True)
class RoundPlugins:
    registry: PluginRegistry
    task: TaskInfo
    # Where ctx.say posts; None when the task's source shows no progress.
    events: RoundEvents | None = None

    def after_planning(self, plan: Mapping[str, Any]) -> dict[str, Any]:
        """Run after_planning. Returns the plan with the plugins' data."""
        results = self._results("after_planning", plan)
        return _with_extensions(plan, results)

    def before_implementation(self, plan: Mapping[str, Any]) -> None:
        for plugin in self._handlers("before_implementation"):
            self.registry.invoke(
                plugin,
                "before_implementation",
                self._context(plugin),
                copy.deepcopy(dict(plan)),
            )

    def followup_start(self, kind: str) -> None:
        for plugin in self._handlers("followup_start"):
            self.registry.invoke(plugin, "followup_start", self._context(plugin), kind)

    def after_implementation(
        self, plan: Mapping[str, Any], implementation: Mapping[str, Any]
    ) -> dict[str, Any]:
        """Run after_implementation. Returns the implementation with the
        plugins' data and pull request sections."""
        results = self._results("after_implementation", plan, implementation)
        merged = _with_extensions(implementation, results)
        for name, result in results.items():
            for section in result.pr_sections:
                _append_pr_section(merged, name, section)
        return merged

    def _handlers(self, hook_name: str) -> list[LoadedPlugin]:
        return [p for p in self.registry.plugins if hook_name in p.hooks]

    def _context(self, plugin: LoadedPlugin):
        return self.registry.context(plugin, task=self.task, events=self.events)

    def _result_path(self, plugin: LoadedPlugin, hook_name: str) -> Path:
        inbox = safe_marker_fragment(self.task.inbox_id)
        return (
            self.registry.state_root
            / plugin.name
            / "results"
            / f"{hook_name}-{inbox}.json"
        )

    def _saved(self, plugin: LoadedPlugin, hook_name: str) -> HookResult | None:
        path = self._result_path(plugin, hook_name)
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            # The file name is a sanitized inbox id; the stored one is exact.
            if raw["inbox_id"] != self.task.inbox_id:
                return None
            return _from_json(raw)
        except FileNotFoundError:
            return None
        except Exception as exc:
            _log.warning(
                "plugin %s: unreadable saved %s result, calling it again: %s: %s",
                plugin.name,
                hook_name,
                type(exc).__name__,
                exc,
            )
            return None

    def _results(self, hook_name: str, *artifacts: Mapping[str, Any]) -> dict[str, Any]:
        """Each handling plugin's result, saved or fresh, in hook order."""
        results: dict[str, HookResult] = {}
        for plugin in self._handlers(hook_name):
            result = self._saved(plugin, hook_name)
            if result is None:
                # Each plugin gets its own copy, so none can change what the
                # harness or the next plugin sees.
                args = [copy.deepcopy(dict(artifact)) for artifact in artifacts]
                ok, value = self.registry.invoke(
                    plugin, hook_name, self._context(plugin), *args
                )
                if not ok:
                    continue
                try:
                    result = _normalize(hook_name, value)
                    path = self._result_path(plugin, hook_name)
                    path.parent.mkdir(parents=True, exist_ok=True)
                    write_json(
                        path,
                        {
                            "hook": hook_name,
                            "inbox_id": self.task.inbox_id,
                            **_to_json(result),
                        },
                    )
                except Exception as exc:
                    _log.error(
                        "plugin %s: %s result dropped: %s: %s",
                        plugin.name,
                        hook_name,
                        type(exc).__name__,
                        exc,
                    )
                    continue
            results[plugin.name] = result
        return results


def _with_extensions(
    artifact: Mapping[str, Any], results: Mapping[str, HookResult]
) -> dict[str, Any]:
    merged = copy.deepcopy(dict(artifact))
    data = {name: r.data for name, r in results.items() if r.data is not None}
    if data:
        existing = merged.get(EXTENSIONS_KEY)
        merged[EXTENSIONS_KEY] = {
            **(existing if isinstance(existing, Mapping) else {}),
            **data,
        }
    return merged


def _append_pr_section(
    implementation: dict[str, Any], plugin_name: str, section: PrSection
) -> None:
    rendered = _render(section)
    for repo in implementation.get("repos") or []:
        if isinstance(repo, dict) and repo.get("name") == section.repo:
            body = repo.get("pr_body")
            body = body if isinstance(body, str) else ""
            if rendered not in body:
                repo["pr_body"] = f"{body.rstrip()}\n\n{rendered}".lstrip()
            return
    _log.warning(
        "plugin %s: pull request section %r names repository %r, "
        "which the implementation does not have; dropped",
        plugin_name,
        section.title,
        section.repo,
    )


def round_plugins(
    registry: PluginRegistry | None,
    *,
    task_key: str,
    inbox_id: str,
    run_id: str,
    events: RoundEvents | None,
) -> RoundPlugins | None:
    """The hooks of one round, or None when no plugin is loaded."""
    if not isinstance(registry, PluginRegistry) or not registry.plugins:
        return None
    return RoundPlugins(
        registry=registry,
        task=TaskInfo(task_key=task_key, inbox_id=inbox_id, run_id=run_id),
        events=events,
    )
