"""The follow-up agents' static prompts."""

from __future__ import annotations

import re
import unittest

from harness.deepagents.agents import followup as fa
from harness.util import _prompt_text


class TestFollowUpPrompts(unittest.TestCase):
    def test_followup_system_prompt_is_assembled_in_order(self) -> None:
        self.assertEqual(
            fa.FOLLOWUP_SYSTEM_PROMPT,
            "\n\n".join([
                fa.ROLE_PROMPT,
                fa.FOLLOWUP_OBJECTIVE_PROMPT,
                fa.RUNTIME_PROMPT,
                fa.FOLLOWUP_ACTIONS_PROMPT,
                _prompt_text("read_discipline.md"),
                _prompt_text("merge_conflict_handling.md"),
                _prompt_text("git_safety.md"),
                fa.FOLLOWUP_CHECKLIST_PROMPT,
            ]),
        )

    def test_ci_system_prompt_is_assembled_in_order(self) -> None:
        self.assertEqual(
            fa.CI_SYSTEM_PROMPT,
            "\n\n".join([
                fa.ROLE_PROMPT,
                fa.CI_OBJECTIVE_PROMPT,
                fa.RUNTIME_PROMPT,
                fa.CI_ACTIONS_PROMPT,
                _prompt_text("merge_conflict_handling.md"),
                _prompt_text("git_safety.md"),
                fa.CI_CHECKLIST_PROMPT,
            ]),
        )

    def test_no_cli_mechanics_placeholders_or_internal_files(self) -> None:
        prompts = {
            "followup": fa.FOLLOWUP_SYSTEM_PROMPT,
            "ci": fa.CI_SYSTEM_PROMPT,
        }
        for name, prompt in prompts.items():
            with self.subTest(prompt=name):
                self.assertIsNone(re.search(r"\{[a-z_]+\}", prompt))
                for banned in (
                    "harness emit-event",
                    "harness memory",
                    "update_pr_script",
                    "rerun_workflow_script",
                    "update_pr.py",
                    "rerun_workflow.py",
                    "<<'",
                    "plan.json",
                    "implementation.json",
                    "subagent",
                    "spawn_agent",
                    "structured response",
                ):
                    self.assertNotIn(banned, prompt)

    def test_workflow_rules_name_the_tools(self) -> None:
        self.assertIn("`update_pull_request`", fa.CI_ACTIONS_PROMPT)
        self.assertIn("`rerun_failed_ci_jobs`", fa.CI_ACTIONS_PROMPT)
        self.assertIn("`record_memory` with type `mistake`", fa.CI_ACTIONS_PROMPT)
        self.assertIn(
            "`record_memory` with type `feedback`", fa.FOLLOWUP_ACTIONS_PROMPT
        )
        self.assertIn("`reply`", fa.FOLLOWUP_CHECKLIST_PROMPT)
        self.assertIn("`reply`", fa.CI_CHECKLIST_PROMPT)


if __name__ == "__main__":
    unittest.main()
