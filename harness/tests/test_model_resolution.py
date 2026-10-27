"""Unit tests for the DeepAgents model and reasoning-effort resolution point."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from harness.deepagents.model import ModelChoice, ModelStage, resolve_model

_TODAY = {
    ModelStage.ORIENTATION: ModelChoice("gpt-5.6-sol", "low"),
    ModelStage.PLANNING: ModelChoice("gpt-5.6-sol", "medium"),
    ModelStage.PLAN_REVIEW: ModelChoice("gpt-5.6-sol", "low"),
    ModelStage.IMPLEMENTATION: ModelChoice("gpt-5.6-sol", "medium"),
    ModelStage.DISTILLATION: ModelChoice("gpt-5.6-sol", "medium"),
    ModelStage.REVIEW: ModelChoice("gpt-5.6-sol", "high"),
    ModelStage.FOLLOWUP: ModelChoice("gpt-5.6-sol", "high"),
}

# A full production-style configuration.
_PRODUCTION = {
    "HARNESS_LLM_BASE_URL": "https://example.services.ai.azure.com/openai/v1",
    "HARNESS_MODEL": "gpt-5.6-sol",
    "HARNESS_REASONING_EFFORT": "high",
    "HARNESS_PLANNING_REASONING_EFFORT": "xhigh",
    "HARNESS_ORIENTATION_REASONING_EFFORT": "medium",
    "HARNESS_DISTILLATION_REASONING_EFFORT": "medium",
    "HARNESS_WEB_SEARCH": "false",
}


class TestCodeDefaults(unittest.TestCase):
    @patch.dict("os.environ", {}, clear=True)
    def test_unset_environment_keeps_todays_values(self) -> None:
        for stage, expected in _TODAY.items():
            with self.subTest(stage=stage):
                self.assertEqual(resolve_model(stage), expected)

    def test_every_stage_has_a_code_default(self) -> None:
        self.assertEqual(set(_TODAY), set(ModelStage))


class TestResolutionOrder(unittest.TestCase):
    @patch.dict(
        "os.environ",
        {
            "HARNESS_MODEL": "default-model",
            "HARNESS_REASONING_EFFORT": "high",
            "HARNESS_PLANNING_MODEL": "planning-model",
            "HARNESS_PLANNING_REASONING_EFFORT": "xhigh",
        },
        clear=True,
    )
    def test_stage_setting_beats_default_setting(self) -> None:
        self.assertEqual(
            resolve_model(ModelStage.PLANNING), ModelChoice("planning-model", "xhigh")
        )

    @patch.dict(
        "os.environ",
        {
            "HARNESS_MODEL": "default-model",
            "HARNESS_REASONING_EFFORT": "high",
        },
        clear=True,
    )
    def test_default_setting_beats_code_default(self) -> None:
        self.assertEqual(
            resolve_model(ModelStage.ORIENTATION), ModelChoice("default-model", "high")
        )

    @patch.dict(
        "os.environ",
        {
            "HARNESS_MODEL": "default-model",
            "HARNESS_REVIEW_REASONING_EFFORT": "medium",
        },
        clear=True,
    )
    def test_model_and_effort_resolve_independently(self) -> None:
        self.assertEqual(
            resolve_model(ModelStage.REVIEW), ModelChoice("default-model", "medium")
        )

    @patch.dict("os.environ", {"HARNESS_FOLLOWUP_MODEL": "f-model"}, clear=True)
    def test_new_stages_have_settings(self) -> None:
        self.assertEqual(
            resolve_model(ModelStage.FOLLOWUP), ModelChoice("f-model", "high")
        )


class TestValues(unittest.TestCase):
    @patch.dict(
        "os.environ",
        {
            "HARNESS_PLANNING_MODEL": "  gpt-5.6-sol ",
            "HARNESS_PLANNING_REASONING_EFFORT": " High ",
        },
        clear=True,
    )
    def test_whitespace_is_stripped_and_effort_lowercased(self) -> None:
        self.assertEqual(
            resolve_model(ModelStage.PLANNING), ModelChoice("gpt-5.6-sol", "high")
        )

    @patch.dict(
        "os.environ",
        {
            "HARNESS_PLANNING_MODEL": "",
            "HARNESS_PLANNING_REASONING_EFFORT": "  ",
        },
        clear=True,
    )
    def test_empty_counts_as_unset(self) -> None:
        self.assertEqual(
            resolve_model(ModelStage.PLANNING), _TODAY[ModelStage.PLANNING]
        )

    @patch.dict(
        "os.environ", {"HARNESS_REVIEW_REASONING_EFFORT": "extreme"}, clear=True
    )
    def test_invalid_effort_names_the_setting(self) -> None:
        with self.assertRaises(ValueError) as ctx:
            resolve_model(ModelStage.REVIEW)
        self.assertIn("HARNESS_REVIEW_REASONING_EFFORT", str(ctx.exception))
        self.assertIn("extreme", str(ctx.exception))

    @patch.dict(
        "os.environ", {"HARNESS_REVIEW_REASONING_EFFORT": "extreme"}, clear=True
    )
    def test_invalid_effort_does_not_affect_other_stages(self) -> None:
        self.assertEqual(
            resolve_model(ModelStage.PLANNING), _TODAY[ModelStage.PLANNING]
        )


class TestProductionValues(unittest.TestCase):
    """Production's combined environment resolves to the expected values."""

    @patch.dict("os.environ", _PRODUCTION, clear=True)
    def test_production_env_resolves_to_expected_values(self) -> None:
        expected = {
            ModelStage.ORIENTATION: "medium",
            ModelStage.PLANNING: "xhigh",
            ModelStage.PLAN_REVIEW: "high",
            ModelStage.IMPLEMENTATION: "high",
            ModelStage.DISTILLATION: "medium",
            ModelStage.REVIEW: "high",
            ModelStage.FOLLOWUP: "high",
        }
        for stage, effort in expected.items():
            with self.subTest(stage=stage):
                self.assertEqual(
                    resolve_model(stage), ModelChoice("gpt-5.6-sol", effort)
                )


if __name__ == "__main__":
    unittest.main()
