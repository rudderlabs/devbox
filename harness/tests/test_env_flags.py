"""Tests for shared environment feature-flag parsing."""

from __future__ import annotations

import os
import unittest
from pathlib import Path
from unittest.mock import patch

from harness.env_flags import (
    classifier_skip_orientation_enabled,
    deepagents_event_streaming_enabled,
    distillation_enabled,
    int_env,
    knowledge_dir_relative_path,
)


class TestClassifierSkipOrientationEnabled(unittest.TestCase):
    def test_defaults_off(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            self.assertFalse(classifier_skip_orientation_enabled())

    def test_truthy_values_enable(self) -> None:
        for value in ("1", "true", "yes", "on"):
            with (
                self.subTest(value=value),
                patch.dict(
                    os.environ,
                    {"HARNESS_EXP_CLASSIFIER_SKIP_ORIENTATION": value},
                    clear=True,
                ),
            ):
                self.assertTrue(classifier_skip_orientation_enabled())

    def test_falsy_values_disable(self) -> None:
        for value in ("0", "false", "no", "off", ""):
            with (
                self.subTest(value=value),
                patch.dict(
                    os.environ,
                    {"HARNESS_EXP_CLASSIFIER_SKIP_ORIENTATION": value},
                    clear=True,
                ),
            ):
                self.assertFalse(classifier_skip_orientation_enabled())


class TestDeepagentsEventStreamingEnabled(unittest.TestCase):
    def test_defaults_off(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            self.assertFalse(deepagents_event_streaming_enabled())

    def test_truthy_values_enable(self) -> None:
        for value in ("1", "true", "yes", "on"):
            with (
                self.subTest(value=value),
                patch.dict(
                    os.environ,
                    {"HARNESS_EXP_DEEPAGENTS_EVENT_STREAMING": value},
                    clear=True,
                ),
            ):
                self.assertTrue(deepagents_event_streaming_enabled())

    def test_falsy_values_disable(self) -> None:
        for value in ("0", "false", "no", "off", ""):
            with (
                self.subTest(value=value),
                patch.dict(
                    os.environ,
                    {"HARNESS_EXP_DEEPAGENTS_EVENT_STREAMING": value},
                    clear=True,
                ),
            ):
                self.assertFalse(deepagents_event_streaming_enabled())


class TestDistillationConfiguration(unittest.TestCase):
    def test_distillation_defaults_on_and_explicit_falsy_values_disable(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            self.assertTrue(distillation_enabled())
        with patch.dict(os.environ, {"HARNESS_DISTILLATION_ENABLED": ""}, clear=True):
            self.assertTrue(distillation_enabled())
        for value in ("0", "false", "no", "off"):
            with (
                self.subTest(value=value),
                patch.dict(
                    os.environ, {"HARNESS_DISTILLATION_ENABLED": value}, clear=True
                ),
            ):
                self.assertFalse(distillation_enabled())

    def test_knowledge_dir_defaults_and_accepts_safe_relative_path(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(knowledge_dir_relative_path(), Path(".agents/knowledge"))
        with patch.dict(
            os.environ, {"HARNESS_REPO_KNOWLEDGE_DIR": ".devbox/knowledge"}, clear=True
        ):
            self.assertEqual(knowledge_dir_relative_path(), Path(".devbox/knowledge"))

    def test_knowledge_dir_rejects_unsafe_values(self) -> None:
        for value in (
            "",
            "   ",
            ".",
            "./",
            "/tmp/knowledge",
            "../knowledge",
            "a/../b",
            r"a\b",
        ):
            with (
                self.subTest(value=value),
                patch.dict(
                    os.environ, {"HARNESS_REPO_KNOWLEDGE_DIR": value}, clear=True
                ),
                self.assertRaisesRegex(ValueError, "HARNESS_REPO_KNOWLEDGE_DIR"),
            ):
                knowledge_dir_relative_path()


class TestIntEnv(unittest.TestCase):
    def test_int_env_defaults_for_missing_empty_and_unparseable(self) -> None:
        cases: dict[str, str | None] = {
            "missing": None,
            "empty": "",
            "blank": "   ",
            "bad": "not-an-int",
        }
        for label, value in cases.items():
            env = {} if value is None else {"COUNT": value}
            with self.subTest(label=label), patch.dict(os.environ, env, clear=True):
                self.assertEqual(int_env("COUNT", default=5), 5)

    def test_int_env_parses_integer(self) -> None:
        with patch.dict(os.environ, {"COUNT": " 7 "}, clear=True):
            self.assertEqual(int_env("COUNT", default=5), 7)


if __name__ == "__main__":
    unittest.main()
