"""Test-suite isolation bootstrap.

``harness.paths`` resolves every path constant (``WORKSPACE``,
``HARNESS_DIR``, ``PLAN_JSON``, ...) at import time from the environment.
Tests that don't patch every one of those globals therefore operate on
whatever the host env points at — on a dev laptop that's usually harmless,
but inside a live harness sandbox ``WORKSPACE=/workspace`` holds real daemon
session state, and an unpatched test can delete live artifacts (this has
happened: ``plan.json`` and its post-plan artifacts were unlinked by a
daemon test running in a sandbox).

This module runs before any test module in the ``tests`` package is
imported (package ``__init__``), so as long as the suite is invoked in
package mode (``make test`` or ``python -m unittest tests.test_foo``) it
executes before any ``harness`` import. It redirects the whole suite to a
disposable temp workspace regardless of host env. Stdlib-only by design.
"""

from __future__ import annotations

import atexit
import os
import shutil
import sys
import tempfile
from pathlib import Path

# Fail fast: if harness modules are already imported, their path constants
# are already frozen against the host env and isolation cannot be
# guaranteed.
_already_imported = sorted(
    name for name in sys.modules if name == "harness" or name.startswith("harness.")
)
if _already_imported:
    raise RuntimeError(
        "tests/__init__.py must run before any 'harness' import so that "
        "harness.paths resolves against the isolated test workspace, but "
        f"these modules are already imported: {_already_imported}. "
        "Run the suite in package mode (make test, or "
        "python -m unittest tests.test_foo)."
    )

# Scrub harness config from the host env so tests never inherit live
# HARNESS_* settings or runtime-only DEVBOX_* sandbox state.
for _name in [name for name in os.environ if name.startswith(("HARNESS_", "DEVBOX_"))]:
    del os.environ[_name]

# Point the suite at a disposable workspace. Only WORKSPACE is exported:
# harness.paths derives HARNESS_DIR as $WORKSPACE/.harness when DEVBOX_DIR
# is unset, and existing tests rely on that derivation when they patch
# WORKSPACE and reload harness.paths — exporting DEVBOX_DIR here would
# override their patched workspace.
ISOLATED_WORKSPACE: Path = Path(tempfile.mkdtemp(prefix="harness-tests-ws-"))
ISOLATED_HARNESS_DIR: Path = ISOLATED_WORKSPACE / ".harness"
ISOLATED_HARNESS_DIR.mkdir()
os.environ["WORKSPACE"] = str(ISOLATED_WORKSPACE)

# RUNTIME_DIR is independent of WORKSPACE (defaults to the literal /tmp) and
# roots REVIEW_SCRATCH_DIR, which the review loop sweeps with rmtree. Point it
# inside the disposable workspace so a test run can never delete a live
# review's scratch dirs on the host.
ISOLATED_RUNTIME_DIR: Path = ISOLATED_WORKSPACE / "runtime"
ISOLATED_RUNTIME_DIR.mkdir()
os.environ["DEVBOX_RUNTIME_DIR"] = str(ISOLATED_RUNTIME_DIR)

atexit.register(shutil.rmtree, ISOLATED_WORKSPACE, ignore_errors=True)
