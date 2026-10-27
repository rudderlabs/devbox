"""Regression tests for the suite-wide isolation bootstrap.

``tests/__init__.py`` must have redirected ``harness.paths`` to a disposable
temp workspace before any harness module was imported. These assertions are
order-independent: ``harness.paths`` constants are frozen at import time, so
they reflect the env exactly as the bootstrap left it.
"""

from __future__ import annotations

import unittest
from pathlib import Path

from harness import paths
from tests import ISOLATED_HARNESS_DIR, ISOLATED_WORKSPACE


class TestSuiteIsolation(unittest.TestCase):
    """The test suite must never touch a real /workspace."""

    def test_workspace_is_isolated_temp_dir(self) -> None:
        self.assertEqual(paths.WORKSPACE, ISOLATED_WORKSPACE)
        self.assertNotEqual(paths.WORKSPACE, Path("/workspace"))

    def test_harness_dir_inside_isolated_workspace(self) -> None:
        self.assertEqual(paths.HARNESS_DIR, ISOLATED_HARNESS_DIR)
        self.assertTrue(paths.HARNESS_DIR.is_relative_to(ISOLATED_WORKSPACE))


if __name__ == "__main__":
    unittest.main()
