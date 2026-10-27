"""Unit tests for sessions.registry — thread_id conflict detection."""

from __future__ import annotations

import sys
import threading
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from harness.deepagents.registry import SessionConflictError, _reset, claim, release


class TestClaim(unittest.TestCase):
    def setUp(self) -> None:
        _reset()

    def test_claim_succeeds_on_fresh_id(self) -> None:
        claim("thread-1")  # should not raise

    def test_claim_raises_on_duplicate(self) -> None:
        claim("thread-1")
        with self.assertRaises(SessionConflictError) as ctx:
            claim("thread-1")
        self.assertIn("thread-1", str(ctx.exception))

    def test_claim_allows_different_ids(self) -> None:
        claim("thread-1")
        claim("thread-2")  # should not raise


class TestRelease(unittest.TestCase):
    def setUp(self) -> None:
        _reset()

    def test_release_allows_reclaim(self) -> None:
        claim("thread-1")
        release("thread-1")
        claim("thread-1")  # should not raise

    def test_release_noop_if_not_claimed(self) -> None:
        release("thread-1")  # should not raise


class TestThreadSafety(unittest.TestCase):
    def setUp(self) -> None:
        _reset()

    def test_concurrent_claims_one_wins(self) -> None:
        results: list[str] = []
        barrier = threading.Barrier(2)

        def try_claim(name: str) -> None:
            barrier.wait()
            try:
                claim("contested-id")
                results.append(f"{name}:ok")
            except SessionConflictError:
                results.append(f"{name}:conflict")

        t1 = threading.Thread(target=try_claim, args=("t1",))
        t2 = threading.Thread(target=try_claim, args=("t2",))
        t1.start()
        t2.start()
        t1.join()
        t2.join()

        ok_count = sum(1 for r in results if r.endswith(":ok"))
        conflict_count = sum(1 for r in results if r.endswith(":conflict"))
        self.assertEqual(ok_count, 1)
        self.assertEqual(conflict_count, 1)


if __name__ == "__main__":
    unittest.main()
