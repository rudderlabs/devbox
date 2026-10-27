"""Unit tests for deepagents.middleware.skills helpers."""

from __future__ import annotations

import importlib
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from deepagents.middleware.skills import SkillsMiddleware

from harness.deepagents.middleware.skills import (
    build_skills_middleware,
    discover_skill_sources,
)


class TestDiscoverSkillSources(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name).resolve()
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.shared = self.root / "shared-skills" / "skills"

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _mkdir(self, path: Path) -> None:
        path.mkdir(parents=True, exist_ok=True)

    def test_order_shared_repo_root_then_component_sources(self) -> None:
        self._mkdir(self.shared)
        self._mkdir(self.repo / "skills")
        self._mkdir(self.repo / ".claude" / "skills")
        self._mkdir(self.repo / ".agents" / "skills")
        self._mkdir(self.repo / "packages" / "api" / "skills")
        self._mkdir(self.repo / "packages" / "api" / ".agents" / "skills")

        result = discover_skill_sources([
            self.shared,
            self.repo,
            self.repo / "packages" / "api",
        ])

        self.assertEqual(
            result,
            [
                (str(self.shared.resolve()), "shared-skills"),
                (str((self.repo / "skills").resolve()), "skills"),
                (str((self.repo / ".claude" / "skills").resolve()), ".claude/skills"),
                (str((self.repo / ".agents" / "skills").resolve()), ".agents/skills"),
                (
                    str((self.repo / "packages" / "api" / "skills").resolve()),
                    "skills",
                ),
                (
                    str(
                        (
                            self.repo / "packages" / "api" / ".agents" / "skills"
                        ).resolve()
                    ),
                    ".agents/skills",
                ),
            ],
        )

    def test_missing_shared_and_local_sources_are_skipped(self) -> None:
        self._mkdir(self.repo / ".agents" / "skills")

        result = discover_skill_sources([self.shared, self.repo])

        self.assertEqual(
            result,
            [(str((self.repo / ".agents" / "skills").resolve()), ".agents/skills")],
        )

    def test_paths_are_absolute(self) -> None:
        self._mkdir(self.shared)

        result = discover_skill_sources([self.shared])

        self.assertTrue(all(Path(path).is_absolute() for path, _label in result))

    def test_shared_skills_dir_env_override_on_reload(self) -> None:
        self._mkdir(self.shared)

        with patch.dict(os.environ, {"DEVBOX_SHARED_SKILLS_DIR": str(self.shared)}):
            harness_paths = importlib.import_module("harness.paths")
            importlib.reload(harness_paths)
            try:
                result = harness_paths.SHARED_SKILLS_DIR
            finally:
                harness_paths = importlib.import_module("harness.paths")
                importlib.reload(harness_paths)

        self.assertEqual(result, self.shared)


class TestBuildSkillsMiddleware(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name).resolve()
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.shared = self.root / "shared-skills" / "skills"

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_returns_none_when_no_sources(self) -> None:
        self.assertIsNone(build_skills_middleware([self.shared, self.repo]))

    def test_builds_middleware_with_ordered_sources(self) -> None:
        shared = self.shared
        repo_skills = self.repo / ".agents" / "skills"
        shared.mkdir(parents=True)
        repo_skills.mkdir(parents=True)

        mw = build_skills_middleware([shared, self.repo])

        self.assertIsInstance(mw, SkillsMiddleware)
        self.assertEqual(
            mw.sources,
            [str(shared.resolve()), str(repo_skills.resolve())],
        )
        self.assertEqual(mw.source_labels, ["shared-skills", ".agents/skills"])


class TestOrientationAgentSkills(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name).resolve()
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()
        self.shared = self.root / "shared-skills" / "skills"
        skill = self.shared / "release-sources"
        skill.mkdir(parents=True)
        (skill / "SKILL.md").write_text(
            "---\nname: release-sources\n---\nRelease sources.\n",
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        self._tmp.cleanup()

    @patch(
        "harness.deepagents.agents.orientation.DeepAgentSession.__init__",
        return_value=None,
    )
    def test_orientation_agent_builds_skills_middleware_from_shared_skills(
        self, init: MagicMock
    ) -> None:
        from harness.deepagents.agents import orientation

        with patch.object(orientation, "SHARED_SKILLS_DIR", self.shared):
            orientation.OrientationAgent(
                model=MagicMock(),
                workspace_dir=self.workspace,
                thread_id="t",
                events=None,
            )

        middleware = init.call_args.kwargs["middleware"]
        self.assertEqual(len(middleware), 1)
        self.assertIsInstance(middleware[0], SkillsMiddleware)
        self.assertEqual(middleware[0].sources, [str(self.shared.resolve())])
        self.assertEqual(middleware[0].source_labels, ["shared-skills"])


if __name__ == "__main__":
    unittest.main()
