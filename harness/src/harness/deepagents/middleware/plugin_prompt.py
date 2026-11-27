"""The loaded plugins' text for one stage's system prompt.

``RoundPlugins.prompt_fragments`` asks the plugins once per stage and returns
one text; this middleware adds it to the system message of every agent of that
stage. It is added per model call and never stored in a thread, so a resumed
thread gets the text of the current run.
"""

from __future__ import annotations

from typing import Any

from harness.deepagents.middleware.system_prompt import SystemPromptMiddleware


class PluginPromptMiddleware(SystemPromptMiddleware):
    def __init__(self, text: str) -> None:
        self.system_prompt = text


def plugin_prompt_middleware(text: str | None) -> list[Any]:
    """The middleware that adds ``text``, or nothing when there is none."""
    return [PluginPromptMiddleware(text)] if text else []
