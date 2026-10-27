"""Prompt fragments must not assume a task came from Linear."""

from __future__ import annotations

import unittest
from pathlib import Path

PROMPTS_DIR = Path(__file__).resolve().parents[1] / "src" / "harness" / "prompts"

# Phrases that describe the task's origin as Linear. A task can also come from
# the devbox API/CLI, so these mislead the agent (and, through it, the user).
LINEAR_ONLY_PHRASES = ("task from Linear", "Linear ID")


class TestPromptWordingIsChannelNeutral(unittest.TestCase):
    def test_no_linear_only_phrases(self) -> None:
        hits = {
            f"{path.name}: {phrase}"
            for path in sorted(PROMPTS_DIR.glob("*.md"))
            for phrase in LINEAR_ONLY_PHRASES
            if phrase in path.read_text(encoding="utf-8")
        }
        self.assertEqual(hits, set())


if __name__ == "__main__":
    unittest.main()
