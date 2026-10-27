"""Unit tests for per-session GitHub PR discussion context deltas."""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from unittest import mock

from harness import discussion_context


class FakeGitHubClient:
    def __init__(
        self,
        *,
        issue_comments: list[dict[str, Any]] | None = None,
        review_comments: list[dict[str, Any]] | None = None,
        reviews: list[dict[str, Any]] | None = None,
        members: list[int] | None = None,
        members_error: bool = False,
        comments_error: bool = False,
        members_by_org: dict[str, list[int]] | None = None,
        users: dict[str, int] | None = None,
        users_error: bool = False,
    ) -> None:
        self.issue_comments = issue_comments or []
        self.review_comments = review_comments or []
        self.reviews = reviews or []
        # Default trusted set = {1}; the comment fixtures default to user_id=1 so
        # they pass the trust filter unless a test opts into an untrusted id.
        self.members = [1] if members is None else members
        self.members_error = members_error
        self.comments_error = comments_error
        self.calls: list[tuple[str, str, str, int]] = []
        self.member_calls = 0
        self.orgs_requested: list[str] = []
        self.members_by_org = members_by_org
        self.users = users or {}
        self.users_error = users_error
        self.user_calls: list[str] = []

    def list_issue_comments(
        self, owner: str, repo: str, issue_number: int
    ) -> list[dict[str, Any]]:
        self.calls.append(("issue", owner, repo, issue_number))
        if self.comments_error:
            raise RuntimeError("comments API down")
        return self.issue_comments

    def list_pull_request_review_comments(
        self, owner: str, repo: str, pr_number: int
    ) -> list[dict[str, Any]]:
        self.calls.append(("review", owner, repo, pr_number))
        return self.review_comments

    def list_pull_request_reviews(
        self, owner: str, repo: str, pr_number: int
    ) -> list[dict[str, Any]]:
        self.calls.append(("review_body", owner, repo, pr_number))
        return self.reviews

    def list_org_members(self, org: str) -> list[dict[str, Any]]:
        self.member_calls += 1
        self.orgs_requested.append(org)
        if self.members_error:
            raise RuntimeError("members API down")
        ids = (
            self.members_by_org.get(org, [])
            if self.members_by_org is not None
            else self.members
        )
        return [{"id": i, "login": f"m{i}"} for i in ids]

    def get_user(self, login: str) -> dict[str, Any]:
        self.user_calls.append(login)
        if self.users_error:
            raise RuntimeError("users API down")
        if login not in self.users:
            raise RuntimeError("HTTP 404 Not Found")
        return {"login": login, "id": self.users[login]}


def _issue(
    comment_id: int, author: str, created_at: str, body: str, user_id: int = 1
) -> dict[str, Any]:
    return {
        "id": comment_id,
        "user": {"login": author, "id": user_id},
        "created_at": created_at,
        "body": body,
    }


def _review(
    comment_id: int,
    author: str,
    created_at: str,
    body: str,
    *,
    path: str = "src/app.py",
    line: int = 42,
    user_id: int = 1,
) -> dict[str, Any]:
    return {
        "id": comment_id,
        "user": {"login": author, "id": user_id},
        "created_at": created_at,
        "body": body,
        "path": path,
        "line": line,
    }


def _review_summary(
    review_id: int,
    author: str,
    submitted_at: str,
    body: str,
    *,
    user_id: int = 1,
    state: str = "COMMENTED",
) -> dict[str, Any]:
    """A submitted-review object from /pulls/{n}/reviews (the summary body)."""
    return {
        "id": review_id,
        "user": {"login": author, "id": user_id},
        "submitted_at": submitted_at,
        "state": state,
        "body": body,
    }


def _sole_session(data: dict[str, Any]) -> list[str]:
    """The single session's seen-set identity list from a one-PR/one-session cache."""
    (identities,) = data["sessions"].values()
    return identities


class TestDiscussionContext(unittest.TestCase):
    def setUp(self) -> None:
        # The behaviors below all assume one configured trusted org.
        patcher = mock.patch.dict(
            os.environ, {"HARNESS_TRUSTED_ORGS": "acme"}, clear=False
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_first_round_for_session_returns_full_discussion(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            cache_path = Path(td) / "discussion-context.json"
            client = FakeGitHubClient(
                issue_comments=[
                    _issue(10, "alice", "2026-04-23T10:01:45Z", "Please update docs.")
                ],
                review_comments=[
                    _review(
                        11,
                        "bob",
                        "2026-04-23T10:02:10Z",
                        "This should be guarded.",
                        path="src/harness/git.py",
                        line=12,
                    )
                ],
            )

            block = discussion_context.fetch_and_store_discussion(
                "acme",
                "widgets",
                7,
                "sess-a",
                client=client,  # type: ignore[arg-type]
                cache_path=cache_path,
            )

            data = json.loads(cache_path.read_text(encoding="utf-8"))
            self.assertNotIn("last_comment_id", data)
            # Coordinates live inside the session key, not at the top level, so
            # several PRs of one task can coexist in the single file.
            self.assertNotIn("owner", data)
            self.assertEqual(list(data["sessions"]), ["acme/widgets#7\x1fsess-a"])
            # The session has now seen both comments (identities recorded).
            self.assertEqual(len(_sole_session(data)), 2)
            self.assertIn("<discussion_context>", block)
            self.assertIn("**2026-04-23T10:01Z** — issue_comment — @alice", block)
            self.assertIn(
                "**2026-04-23T10:02Z** — review_comment (`src/harness/git.py:12`) — @bob",
                block,
            )

    def test_second_round_returns_only_new_comments_including_low_ids(self) -> None:
        # Regression: the old single cross-stream cursor dropped a genuinely-new
        # comment whose id was below the other stream's max. Here a NEW review
        # comment (id 5) arrives below the round-1 issue/review ids and MUST appear.
        with tempfile.TemporaryDirectory() as td:
            cache_path = Path(td) / "discussion-context.json"

            round1 = FakeGitHubClient(
                issue_comments=[_issue(10, "alice", "2026-04-23T10:01:00Z", "Docs.")],
                review_comments=[_review(11, "bob", "2026-04-23T10:02:00Z", "Guard.")],
            )
            first = discussion_context.fetch_and_store_discussion(
                "acme",
                "widgets",
                7,
                "sess-a",
                client=round1,  # type: ignore[arg-type]
                cache_path=cache_path,
            )
            self.assertIn("Docs.", first)
            self.assertIn("Guard.", first)

            round2 = FakeGitHubClient(
                issue_comments=[
                    _issue(10, "alice", "2026-04-23T10:01:00Z", "Docs."),
                    _issue(12, "carol", "2026-04-23T10:03:00Z", "New issue comment."),
                ],
                review_comments=[
                    _review(11, "bob", "2026-04-23T10:02:00Z", "Guard."),
                    _review(5, "dave", "2026-04-23T10:04:00Z", "Low-id new review."),
                ],
            )
            block = discussion_context.fetch_and_store_discussion(
                "acme",
                "widgets",
                7,
                "sess-a",
                client=round2,  # type: ignore[arg-type]
                cache_path=cache_path,
            )

            # Delta only: the two already-seen comments are NOT re-injected.
            self.assertNotIn("Docs.", block)
            self.assertNotIn("Guard.", block)
            # Both new comments appear, including the low-id one the old cursor dropped.
            self.assertIn("New issue comment.", block)
            self.assertIn("Low-id new review.", block)

            data = json.loads(cache_path.read_text(encoding="utf-8"))
            self.assertEqual(len(_sole_session(data)), 4)

    def test_edited_comment_is_reinjected(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            cache_path = Path(td) / "discussion-context.json"
            discussion_context.fetch_and_store_discussion(
                "acme",
                "widgets",
                7,
                "sess-a",
                client=FakeGitHubClient(
                    issue_comments=[_issue(10, "a", "2026-04-23T10:01:00Z", "old body")]
                ),  # type: ignore[arg-type]
                cache_path=cache_path,
            )

            block = discussion_context.fetch_and_store_discussion(
                "acme",
                "widgets",
                7,
                "sess-a",
                client=FakeGitHubClient(
                    issue_comments=[_issue(10, "a", "2026-04-23T10:01:00Z", "new body")]
                ),  # type: ignore[arg-type]
                cache_path=cache_path,
            )
            # Same id, different body → treated as new and re-injected with fresh text.
            self.assertIn("new body", block)
            self.assertNotIn("old body", block)

    def test_deleted_comment_not_reinjected_and_empty_delta_blank(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            cache_path = Path(td) / "discussion-context.json"
            discussion_context.fetch_and_store_discussion(
                "acme",
                "widgets",
                7,
                "sess-a",
                client=FakeGitHubClient(
                    issue_comments=[
                        _issue(10, "a", "2026-04-23T10:01:00Z", "gone soon")
                    ]
                ),  # type: ignore[arg-type]
                cache_path=cache_path,
            )

            # GitHub no longer returns the comment (deleted) → nothing new → blank.
            block = discussion_context.fetch_and_store_discussion(
                "acme",
                "widgets",
                7,
                "sess-a",
                client=FakeGitHubClient(issue_comments=[]),  # type: ignore[arg-type]
                cache_path=cache_path,
            )
            self.assertEqual(block, "")
            # The identity is RETAINED, not pruned: an absent comment may be a
            # transient partial read rather than a delete, so keeping it prevents a
            # spurious re-injection if it reappears. A genuine delete simply never
            # returns to the live fetch, so retaining it is harmless.
            data = json.loads(cache_path.read_text(encoding="utf-8"))
            self.assertEqual(len(_sole_session(data)), 1)

    def test_sessions_track_deltas_independently(self) -> None:
        # The ci session and interactivity session are distinct resumed agents; a
        # comment consumed by one must still reach the other on its first round.
        with tempfile.TemporaryDirectory() as td:
            cache_path = Path(td) / "discussion-context.json"
            client = FakeGitHubClient(
                issue_comments=[_issue(10, "a", "2026-04-23T10:01:00Z", "shared note")]
            )

            ci_block = discussion_context.fetch_and_store_discussion(
                "acme",
                "widgets",
                7,
                "sess-ci",
                client=client,  # type: ignore[arg-type]
                cache_path=cache_path,
            )
            inter_block = discussion_context.fetch_and_store_discussion(
                "acme",
                "widgets",
                7,
                "sess-interactivity",
                client=client,  # type: ignore[arg-type]
                cache_path=cache_path,
            )
            # Both sessions receive the comment on their own first round.
            self.assertIn("shared note", ci_block)
            self.assertIn("shared note", inter_block)

    def test_before_defers_comments_at_or_after_trigger(self) -> None:
        # Strict temporal scoping: a round triggered by a comment at T injects only
        # comments strictly older than T; a comment posted at/after T is deferred to
        # a later round, not dropped.
        with tempfile.TemporaryDirectory() as td:
            cache_path = Path(td) / "discussion-context.json"
            client = FakeGitHubClient(
                issue_comments=[
                    _issue(1, "a", "2026-04-23T10:00:00Z", "older A"),
                    _issue(2, "b", "2026-04-23T10:10:00Z", "newer B"),
                ]
            )

            block = discussion_context.fetch_and_store_discussion(
                "acme",
                "widgets",
                7,
                "sess-a",
                before="2026-04-23T10:05:00Z",
                client=client,  # type: ignore[arg-type]
                cache_path=cache_path,
            )
            self.assertIn("older A", block)
            self.assertNotIn("newer B", block)
            # B is newer than the trigger → not marked shown (still deferred).
            data = json.loads(cache_path.read_text(encoding="utf-8"))
            self.assertEqual(len(_sole_session(data)), 1)

            # A later round (trigger past B's time) now injects B, not A (A seen).
            block2 = discussion_context.fetch_and_store_discussion(
                "acme",
                "widgets",
                7,
                "sess-a",
                before="2026-04-23T10:20:00Z",
                client=client,  # type: ignore[arg-type]
                cache_path=cache_path,
            )
            self.assertNotIn("older A", block2)
            self.assertIn("newer B", block2)

    def test_missing_created_at_is_injected_despite_before(self) -> None:
        # A comment with no/unparseable timestamp must not be deferred forever.
        with tempfile.TemporaryDirectory() as td:
            cache_path = Path(td) / "discussion-context.json"
            client = FakeGitHubClient(
                issue_comments=[
                    {"id": 1, "user": {"login": "a", "id": 1}, "body": "no stamp"}
                ]
            )

            block = discussion_context.fetch_and_store_discussion(
                "acme",
                "widgets",
                7,
                "sess-a",
                before="2026-04-23T10:05:00Z",
                client=client,  # type: ignore[arg-type]
                cache_path=cache_path,
            )
            self.assertIn("no stamp", block)

    def test_two_prs_one_session_keep_independent_seen_sets(self) -> None:
        # One ticket's interactivity session spans multiple PRs (multi-repo task).
        # Alternating between them must NOT re-inject each PR's whole discussion:
        # the seen-set is keyed by PR coordinates, so each PR keeps its own.
        with tempfile.TemporaryDirectory() as td:
            cache_path = Path(td) / "discussion-context.json"
            pr_a = FakeGitHubClient(
                issue_comments=[_issue(1, "a", "2026-04-23T10:00:00Z", "on PR A")]
            )
            pr_b = FakeGitHubClient(
                issue_comments=[_issue(2, "b", "2026-04-23T11:00:00Z", "on PR B")]
            )

            # Round on PR A (10), then PR B (20), then back to PR A — same session.
            first_a = discussion_context.fetch_and_store_discussion(
                "acme",
                "repoA",
                10,
                "sess-a",
                client=pr_a,  # type: ignore[arg-type]
                cache_path=cache_path,
            )
            self.assertIn("on PR A", first_a)

            first_b = discussion_context.fetch_and_store_discussion(
                "acme",
                "repoB",
                20,
                "sess-a",
                client=pr_b,  # type: ignore[arg-type]
                cache_path=cache_path,
            )
            self.assertIn("on PR B", first_b)

            # Back to PR A: its comment is already seen for this session → nothing
            # re-injected (no thrash), and PR B's state is untouched.
            second_a = discussion_context.fetch_and_store_discussion(
                "acme",
                "repoA",
                10,
                "sess-a",
                client=pr_a,  # type: ignore[arg-type]
                cache_path=cache_path,
            )
            self.assertEqual(second_a, "")
            data = json.loads(cache_path.read_text(encoding="utf-8"))
            self.assertEqual(
                sorted(data["sessions"]),
                ["acme/repoA#10\x1fsess-a", "acme/repoB#20\x1fsess-a"],
            )

    def test_review_own_inline_comments_excluded_from_history(self) -> None:
        # A submitted review's own inline comments (drafted before submitted_at) must
        # NOT appear in <discussion_context> — the round already lists them as items
        # to address — and must be marked seen so they never resurface as history.
        with tempfile.TemporaryDirectory() as td:
            cache_path = Path(td) / "discussion-context.json"
            client = FakeGitHubClient(
                review_comments=[
                    _review(11, "rev", "2026-04-23T10:00:30Z", "own inline nit"),
                    _review(12, "rev", "2026-04-23T10:01:15Z", "own inline rename"),
                ]
            )

            block = discussion_context.fetch_and_store_discussion(
                "acme",
                "widgets",
                7,
                "sess-a",
                before="2026-04-23T10:02:00Z",  # the review's submitted_at
                own_items=[
                    {"type": "review_comment", "id": 11, "body": "own inline nit"},
                    {"type": "review_comment", "id": 12, "body": "own inline rename"},
                ],
                client=client,  # type: ignore[arg-type]
                cache_path=cache_path,
            )
            # Own inline comments are older than submitted_at but must be suppressed.
            self.assertEqual(block, "")
            # ...and recorded as seen so a later round never lists them as history.
            data = json.loads(cache_path.read_text(encoding="utf-8"))
            self.assertEqual(len(_sole_session(data)), 2)

            later = discussion_context.fetch_and_store_discussion(
                "acme",
                "widgets",
                7,
                "sess-a",
                before="2026-04-23T12:00:00Z",
                client=client,  # type: ignore[arg-type]
                cache_path=cache_path,
            )
            self.assertEqual(later, "")

    def test_review_summary_body_injected_as_history(self) -> None:
        # The core of the "reviewer left feedback with no @mention, author later
        # asks the bot to address the review" flow: the reviewer's summary body
        # (/pulls/{n}/reviews) is never enqueued by the control plane, so it must
        # reach the agent as injected discussion history.
        with tempfile.TemporaryDirectory() as td:
            cache_path = Path(td) / "discussion-context.json"
            client = FakeGitHubClient(
                reviews=[
                    _review_summary(
                        900,
                        "reviewer",
                        "2026-04-23T09:00:00Z",
                        "Please also handle the null case in the parser.",
                    )
                ],
            )

            block = discussion_context.fetch_and_store_discussion(
                "acme",
                "widgets",
                7,
                "sess-a",
                before="2026-04-23T10:00:00Z",  # a later author comment triggered
                client=client,  # type: ignore[arg-type]
                cache_path=cache_path,
            )

            self.assertIn("**2026-04-23T09:00Z** — review — @reviewer", block)
            self.assertIn("handle the null case", block)
            # The review-summary endpoint was actually consulted.
            self.assertIn(("review_body", "acme", "widgets", 7), client.calls)

    def test_empty_review_body_not_injected(self) -> None:
        # A bare approval (state APPROVED, no summary text) carries nothing to
        # inject and must be dropped, not surfaced as an empty history line.
        with tempfile.TemporaryDirectory() as td:
            cache_path = Path(td) / "discussion-context.json"
            client = FakeGitHubClient(
                reviews=[
                    _review_summary(
                        901, "reviewer", "2026-04-23T09:00:00Z", "", state="APPROVED"
                    ),
                    _review_summary(
                        902, "reviewer", "2026-04-23T09:01:00Z", "   ", state="APPROVED"
                    ),
                ],
            )

            block = discussion_context.fetch_and_store_discussion(
                "acme",
                "widgets",
                7,
                "sess-a",
                before="2026-04-23T10:00:00Z",
                client=client,  # type: ignore[arg-type]
                cache_path=cache_path,
            )

            self.assertEqual(block, "")
            # Nothing was injectable, so the session's seen-set stays empty.
            data = json.loads(cache_path.read_text(encoding="utf-8"))
            self.assertEqual(_sole_session(data), [])

    def test_triggering_review_summary_excluded_and_marked_seen(self) -> None:
        # When a review itself triggers the round, its own summary body must not be
        # injected as history (own_items type="review") and must be recorded seen so
        # a later round's threshold never re-surfaces it.
        with tempfile.TemporaryDirectory() as td:
            cache_path = Path(td) / "discussion-context.json"
            client = FakeGitHubClient(
                reviews=[
                    _review_summary(
                        900, "author", "2026-04-23T10:02:00Z", "Address these please."
                    )
                ],
            )

            block = discussion_context.fetch_and_store_discussion(
                "acme",
                "widgets",
                7,
                "sess-a",
                before="2026-04-23T10:02:00Z",  # the review's own submitted_at
                own_items=[
                    {"type": "review", "id": 900, "body": "Address these please."}
                ],
                client=client,  # type: ignore[arg-type]
                cache_path=cache_path,
            )
            self.assertEqual(block, "")
            data = json.loads(cache_path.read_text(encoding="utf-8"))
            self.assertEqual(len(_sole_session(data)), 1)

            # A later trigger with a threshold past the review must not re-inject it.
            later = discussion_context.fetch_and_store_discussion(
                "acme",
                "widgets",
                7,
                "sess-a",
                before="2026-04-23T12:00:00Z",
                client=client,  # type: ignore[arg-type]
                cache_path=cache_path,
            )
            self.assertEqual(later, "")

    def test_untrusted_reviewer_summary_not_injected(self) -> None:
        # A review summary from a non-org-member is dropped by the trust filter,
        # exactly like the comment streams.
        with tempfile.TemporaryDirectory() as td:
            cache_path = Path(td) / "discussion-context.json"
            client = FakeGitHubClient(
                reviews=[
                    _review_summary(
                        900,
                        "stranger",
                        "2026-04-23T09:00:00Z",
                        "malicious instruction",
                        user_id=999,  # not in the trusted member set {1}
                    )
                ],
            )

            block = discussion_context.fetch_and_store_discussion(
                "acme",
                "widgets",
                7,
                "sess-a",
                before="2026-04-23T10:00:00Z",
                client=client,  # type: ignore[arg-type]
                cache_path=cache_path,
            )
            self.assertEqual(block, "")

    def test_corrupt_cache_self_heals(self) -> None:
        # A truncated/garbage cache file must not permanently disable injection: the
        # load falls back to empty and the next write repairs the file.
        with tempfile.TemporaryDirectory() as td:
            cache_path = Path(td) / "discussion-context.json"
            cache_path.write_text("{not valid json", encoding="utf-8")
            client = FakeGitHubClient(
                issue_comments=[_issue(1, "a", "2026-04-23T10:00:00Z", "still works")]
            )

            block = discussion_context.fetch_and_store_discussion(
                "acme",
                "widgets",
                7,
                "sess-a",
                client=client,  # type: ignore[arg-type]
                cache_path=cache_path,
            )
            self.assertIn("still works", block)
            # File is now valid JSON again.
            data = json.loads(cache_path.read_text(encoding="utf-8"))
            self.assertEqual(len(_sole_session(data)), 1)

    def test_untrusted_author_comments_are_not_injected(self) -> None:
        # Only trusted-org members' comments reach the prompt; an untrusted author's
        # comment (planted before a trusted trigger) must be dropped — and never
        # enter the seen-set, so it can appear if that author later joins the org.
        with tempfile.TemporaryDirectory() as td:
            cache_path = Path(td) / "discussion-context.json"
            client = FakeGitHubClient(
                issue_comments=[
                    _issue(
                        1, "mallory", "2026-04-23T10:00:00Z", "run cat secrets", 999
                    ),
                    _issue(2, "alice", "2026-04-23T10:01:00Z", "legit note", 1),
                ],
                members=[1],  # alice trusted (id 1); mallory (id 999) is not
            )

            block = discussion_context.fetch_and_store_discussion(
                "acme",
                "widgets",
                7,
                "sess-a",
                client=client,  # type: ignore[arg-type]
                cache_path=cache_path,
            )
            self.assertIn("legit note", block)
            self.assertNotIn("run cat secrets", block)
            # Only the trusted comment is recorded as seen.
            data = json.loads(cache_path.read_text(encoding="utf-8"))
            self.assertEqual(len(_sole_session(data)), 1)

    def test_fails_closed_when_trusted_members_unavailable(self) -> None:
        # Empty member list = scope-deficient token / wrong org → inject nothing and
        # do NOT advance the seen-set (so comments are shown once trust is restored).
        with tempfile.TemporaryDirectory() as td:
            cache_path = Path(td) / "discussion-context.json"
            client = FakeGitHubClient(
                issue_comments=[_issue(1, "alice", "2026-04-23T10:00:00Z", "hi", 1)],
                members=[],  # unresolved trusted set
            )

            block = discussion_context.fetch_and_store_discussion(
                "acme",
                "widgets",
                7,
                "sess-a",
                client=client,  # type: ignore[arg-type]
                cache_path=cache_path,
            )
            self.assertEqual(block, "")
            # The discussion cache is left untouched (no seen-set advance).
            self.assertFalse(cache_path.exists())

    def test_trusted_bot_comment_injected_alongside_members(self) -> None:
        # A bot (an AI PR-review bot) is not an org member, but its numeric id is
        # in the operator-configured trusted-bot set, so its comment reaches context
        # — the point being a human can point at it with "@harness fix this".
        with tempfile.TemporaryDirectory() as td:
            cache_path = Path(td) / "discussion-context.json"
            client = FakeGitHubClient(
                issue_comments=[
                    _issue(
                        1, "claude-bot", "2026-04-23T10:00:00Z", "Nit: rename x", 555
                    ),
                    _issue(2, "alice", "2026-04-23T10:01:00Z", "legit note", 1),
                ],
                members=[1],  # only alice is an org member; bot id 555 is not
            )

            with mock.patch.dict(os.environ, {"HARNESS_TRUSTED_BOT_IDS": "555"}):
                block = discussion_context.fetch_and_store_discussion(
                    "acme",
                    "widgets",
                    7,
                    "sess-a",
                    client=client,  # type: ignore[arg-type]
                    cache_path=cache_path,
                )
            self.assertIn("Nit: rename x", block)
            self.assertIn("legit note", block)

    def test_fails_closed_when_members_unresolved_even_with_bots(self) -> None:
        # Resolving the org-member set is a HARD requirement: if it is unavailable the
        # round fails closed REGARDLESS of configured bot ids — a member-fetch outage
        # must not narrow trust down to the bot set alone.
        with tempfile.TemporaryDirectory() as td:
            cache_path = Path(td) / "discussion-context.json"
            client = FakeGitHubClient(
                issue_comments=[
                    _issue(1, "review-bot", "2026-04-23T10:00:00Z", "bot review", 555),
                    _issue(2, "alice", "2026-04-23T10:01:00Z", "human note", 1),
                ],
                members=[],  # org member set unresolved → members is None
            )

            # bot configured, but members unresolved → still fail closed
            with mock.patch.dict(os.environ, {"HARNESS_TRUSTED_BOT_IDS": "555"}):
                block = discussion_context.fetch_and_store_discussion(
                    "acme",
                    "widgets",
                    7,
                    "sess-a",
                    client=client,  # type: ignore[arg-type]
                    cache_path=cache_path,
                )
            self.assertEqual(block, "")  # fail closed despite the bot id
            self.assertFalse(cache_path.exists())

    def test_trusted_bot_ids_parses_env(self) -> None:
        with mock.patch.dict(
            os.environ, {"HARNESS_TRUSTED_BOT_IDS": "555, 777  888\tabc,"}
        ):
            self.assertEqual(discussion_context._trusted_bot_ids(), {555, 777, 888})
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(discussion_context._trusted_bot_ids(), set())

    def test_excluded_own_item_marked_seen_even_when_author_untrusted(self) -> None:
        # An own item (trigger/inline) is excluded AND must be marked seen even if
        # the harness member set lags the CP and would drop its author this round —
        # otherwise it resurfaces as history once that author becomes trusted.
        with tempfile.TemporaryDirectory() as td:
            cache_path = Path(td) / "discussion-context.json"
            comment = _issue(99, "x", "2026-04-23T10:00:00Z", "trigger body", 999)

            # Round 1: author 999 not yet trusted; comment is the round's own item.
            block1 = discussion_context.fetch_and_store_discussion(
                "acme",
                "widgets",
                7,
                "sess-a",
                own_items=[{"type": "issue_comment", "id": 99, "body": "trigger body"}],
                client=FakeGitHubClient(issue_comments=[comment], members=[1]),  # type: ignore[arg-type]
                cache_path=cache_path,
                members_cache_path=Path(td) / "m1.json",
            )
            self.assertEqual(block1, "")
            data = json.loads(cache_path.read_text(encoding="utf-8"))
            self.assertEqual(len(_sole_session(data)), 1)  # id 99 recorded as seen

            # Round 2: author 999 is now trusted and it is no longer excluded — it
            # must NOT resurface as history, because round 1 marked it seen.
            block2 = discussion_context.fetch_and_store_discussion(
                "acme",
                "widgets",
                7,
                "sess-a",
                client=FakeGitHubClient(issue_comments=[comment], members=[1, 999]),  # type: ignore[arg-type]
                cache_path=cache_path,
                members_cache_path=Path(td) / "m2.json",
            )
            self.assertEqual(block2, "")

    def test_transient_empty_fetch_does_not_reinject_history(self) -> None:
        # A degraded 200 (replica lag) that returns a SUBSET must not prune the
        # absent comments from the seen-set and re-inject them once they reappear.
        with tempfile.TemporaryDirectory() as td:
            cache_path = Path(td) / "discussion-context.json"
            mpath = Path(td) / "m.json"
            c1 = _issue(1, "a", "2026-04-23T10:00:00Z", "one")
            c2 = _issue(2, "a", "2026-04-23T10:01:00Z", "two")

            b1 = discussion_context.fetch_and_store_discussion(
                "acme",
                "widgets",
                7,
                "sess-a",
                client=FakeGitHubClient(issue_comments=[c1, c2]),  # type: ignore[arg-type]
                cache_path=cache_path,
                members_cache_path=mpath,
            )
            self.assertIn("one", b1)
            self.assertIn("two", b1)

            # Transient empty 200: nothing changes, and the seen-set is retained.
            b2 = discussion_context.fetch_and_store_discussion(
                "acme",
                "widgets",
                7,
                "sess-a",
                client=FakeGitHubClient(issue_comments=[]),  # type: ignore[arg-type]
                cache_path=cache_path,
                members_cache_path=mpath,
            )
            self.assertEqual(b2, "")
            data = json.loads(cache_path.read_text(encoding="utf-8"))
            self.assertEqual(len(_sole_session(data)), 2)

            # Comments reappear when the replica recovers → NOT re-injected.
            b3 = discussion_context.fetch_and_store_discussion(
                "acme",
                "widgets",
                7,
                "sess-a",
                client=FakeGitHubClient(issue_comments=[c1, c2]),  # type: ignore[arg-type]
                cache_path=cache_path,
                members_cache_path=mpath,
            )
            self.assertEqual(b3, "")

    def test_first_round_caps_injected_but_marks_all_seen(self) -> None:
        n = discussion_context._MAX_INJECTED_COMMENTS + 3
        comments = [
            _issue(i, "a", f"2026-04-23T10:{i:02d}:00Z", f"body{i:03d}")
            for i in range(n)
        ]
        with tempfile.TemporaryDirectory() as td:
            cache_path = Path(td) / "discussion-context.json"
            block = discussion_context.fetch_and_store_discussion(
                "acme",
                "widgets",
                7,
                "sess-a",
                client=FakeGitHubClient(issue_comments=comments),  # type: ignore[arg-type]
                cache_path=cache_path,
                members_cache_path=Path(td) / "m.json",
            )
            # Only the most-recent K are injected; the 3 oldest are suppressed...
            self.assertIn("body052", block)
            self.assertIn("body003", block)
            self.assertNotIn("body000", block)
            self.assertNotIn("body002", block)
            # ...but ALL are marked seen so they never resurface.
            data = json.loads(cache_path.read_text(encoding="utf-8"))
            self.assertEqual(len(_sole_session(data)), n)

    def test_fail_closed_still_marks_own_excluded_item_seen(self) -> None:
        # A trigger fired while trust is unavailable must be recorded seen so it does
        # not resurface as history once trust recovers.
        with tempfile.TemporaryDirectory() as td:
            cache_path = Path(td) / "discussion-context.json"
            mpath = Path(td) / "m.json"
            trigger = _issue(99, "a", "2026-04-23T10:00:00Z", "trigger body")

            # Round 1: trust unavailable (empty member list) → fail closed, but the
            # own excluded item is still recorded seen.
            b1 = discussion_context.fetch_and_store_discussion(
                "acme",
                "widgets",
                7,
                "sess-a",
                own_items=[{"type": "issue_comment", "id": 99, "body": "trigger body"}],
                client=FakeGitHubClient(issue_comments=[trigger], members=[]),  # type: ignore[arg-type]
                cache_path=cache_path,
                members_cache_path=mpath,
            )
            self.assertEqual(b1, "")
            data = json.loads(cache_path.read_text(encoding="utf-8"))
            self.assertEqual(len(_sole_session(data)), 1)

            # Round 2: trust available, no exclude → must NOT resurface as history.
            b2 = discussion_context.fetch_and_store_discussion(
                "acme",
                "widgets",
                7,
                "sess-a",
                client=FakeGitHubClient(issue_comments=[trigger], members=[1]),  # type: ignore[arg-type]
                cache_path=cache_path,
                members_cache_path=mpath,
            )
            self.assertEqual(b2, "")

    def test_own_item_marked_seen_when_fetch_throws(self) -> None:
        # If the trigger round's comment fetch throws (5xx/timeout), the own item is
        # STILL recorded seen so it cannot resurface as history on a later round.
        with tempfile.TemporaryDirectory() as td:
            cache_path = Path(td) / "discussion-context.json"
            mpath = Path(td) / "m.json"

            with self.assertRaises(RuntimeError):
                discussion_context.fetch_and_store_discussion(
                    "acme",
                    "widgets",
                    7,
                    "sess-a",
                    own_items=[
                        {"type": "issue_comment", "id": 99, "body": "trigger body"}
                    ],
                    client=FakeGitHubClient(comments_error=True),  # type: ignore[arg-type]
                    cache_path=cache_path,
                    members_cache_path=mpath,
                )
            # The own item was persisted as seen despite the failed fetch.
            data = json.loads(cache_path.read_text(encoding="utf-8"))
            self.assertEqual(len(_sole_session(data)), 1)

            # Later round: the trigger is now visible and trusted, but it must NOT be
            # injected as history because it was recorded seen on the failed round.
            block = discussion_context.fetch_and_store_discussion(
                "acme",
                "widgets",
                7,
                "sess-a",
                client=FakeGitHubClient(
                    issue_comments=[
                        _issue(99, "a", "2026-04-23T10:00:00Z", "trigger body")
                    ]
                ),  # type: ignore[arg-type]
                cache_path=cache_path,
                members_cache_path=mpath,
            )
            self.assertEqual(block, "")

    def test_trigger_body_mismatch_still_marked_seen(self) -> None:
        # The own-item body (from the webhook payload) may differ from the fetched
        # API body (an edit in the window, CRLF/normalization). The FETCHED identity
        # must still be recorded seen (by key), so the trigger does not resurface.
        with tempfile.TemporaryDirectory() as td:
            cache_path = Path(td) / "discussion-context.json"
            mpath = Path(td) / "m.json"

            block1 = discussion_context.fetch_and_store_discussion(
                "acme",
                "widgets",
                7,
                "sess-a",
                own_items=[{"type": "issue_comment", "id": 99, "body": "WEBHOOK body"}],
                client=FakeGitHubClient(
                    issue_comments=[_issue(99, "a", "2026-04-23T10:00:00Z", "API body")]
                ),  # type: ignore[arg-type]
                cache_path=cache_path,
                members_cache_path=mpath,
            )
            self.assertEqual(block1, "")  # trigger excluded from its own round

            block2 = discussion_context.fetch_and_store_discussion(
                "acme",
                "widgets",
                7,
                "sess-a",
                client=FakeGitHubClient(
                    issue_comments=[_issue(99, "a", "2026-04-23T10:00:00Z", "API body")]
                ),  # type: ignore[arg-type]
                cache_path=cache_path,
                members_cache_path=mpath,
            )
            # The fetched-body identity was recorded seen in round 1 → no resurface.
            self.assertEqual(block2, "")

    def test_pr_coordinates_use_url_when_explicit_coordinates_absent(self) -> None:
        self.assertEqual(
            discussion_context.pr_coordinates_from_payload({
                "repo": "widgets",
                "pr_url": "https://github.com/acme/widgets/pull/17/files",
            }),
            ("acme", "widgets", 17),
        )

    def test_pr_coordinates_handles_malformed_or_unavailable_payloads(self) -> None:
        self.assertIsNone(discussion_context.pr_coordinates_from_payload(None))
        self.assertIsNone(discussion_context.pr_coordinates_from_payload({}))
        self.assertIsNone(
            discussion_context.pr_coordinates_from_payload({
                "pr_url": "https://x/pull/1"
            })
        )

    def test_fetch_returns_nothing_when_coordinates_missing(self) -> None:
        self.assertEqual(
            discussion_context.fetch_discussion_context_for_pr(
                {"pr_url": "bad"}, "sess-a", None, None
            ),
            "",
        )


class TestTrustConfiguration(unittest.TestCase):
    """Orgs, users and bot ids come from HARNESS_TRUSTED_* with no default."""

    def _run(
        self,
        client: FakeGitHubClient,
        env: dict[str, str],
        *,
        td: str,
        **kwargs: Any,
    ) -> str:
        cache_path = Path(td) / "discussion-context.json"
        with mock.patch.dict(os.environ, env, clear=True):
            return discussion_context.fetch_and_store_discussion(
                "o",
                "r",
                7,
                "sess-a",
                client=client,  # type: ignore[arg-type]
                cache_path=cache_path,
                **kwargs,
            )

    def test_nothing_configured_injects_nothing_and_makes_no_calls(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            client = FakeGitHubClient(
                issue_comments=[_issue(1, "alice", "2026-04-23T10:00:00Z", "hi", 1)]
            )
            block = self._run(client, {}, td=td)
            self.assertEqual(block, "")
            self.assertEqual(client.member_calls, 0)
            self.assertEqual(client.user_calls, [])
            self.assertEqual(client.calls, [])
            self.assertFalse((Path(td) / "discussion-context.json").exists())

    def test_bot_ids_alone_inject_nothing_and_make_no_member_calls(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            client = FakeGitHubClient(
                issue_comments=[_issue(1, "bot", "2026-04-23T10:00:00Z", "hi", 555)]
            )
            block = self._run(client, {"HARNESS_TRUSTED_BOT_IDS": "555"}, td=td)
            self.assertEqual(block, "")
            self.assertEqual(client.member_calls, 0)
            self.assertEqual(client.user_calls, [])

    def test_singular_trusted_org_variable_is_ignored(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            client = FakeGitHubClient(
                issue_comments=[_issue(1, "alice", "2026-04-23T10:00:00Z", "hi", 1)]
            )
            block = self._run(client, {"HARNESS_TRUSTED_ORG": "acme"}, td=td)
            self.assertEqual(block, "")
            self.assertEqual(client.member_calls, 0)

    def test_trusted_users_alone_are_injected_and_strangers_are_not(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            client = FakeGitHubClient(
                issue_comments=[
                    _issue(1, "carol", "2026-04-23T10:00:00Z", "from carol", 50),
                    _issue(2, "mallory", "2026-04-23T10:01:00Z", "from mallory", 999),
                ],
                users={"carol": 50},
            )
            block = self._run(client, {"HARNESS_TRUSTED_USERS": "carol"}, td=td)
            self.assertIn("from carol", block)
            self.assertNotIn("from mallory", block)
            self.assertEqual(client.member_calls, 0)
            self.assertEqual(client.user_calls, ["carol"])

    def test_user_is_matched_on_numeric_id_not_login(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            client = FakeGitHubClient(
                issue_comments=[
                    _issue(1, "carol", "2026-04-23T10:00:00Z", "impostor", 51)
                ],
                users={"carol": 50},
            )
            block = self._run(client, {"HARNESS_TRUSTED_USERS": "carol"}, td=td)
            self.assertEqual(block, "")

    def test_orgs_and_users_are_a_union_across_all_orgs(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            client = FakeGitHubClient(
                issue_comments=[
                    _issue(1, "a", "2026-04-23T10:00:00Z", "from a", 1),
                    _issue(2, "b", "2026-04-23T10:01:00Z", "from b", 2),
                    _issue(3, "c", "2026-04-23T10:02:00Z", "from c", 50),
                    _issue(4, "x", "2026-04-23T10:03:00Z", "from x", 999),
                ],
                members_by_org={"acme": [1], "widgets": [2]},
                users={"c": 50},
            )
            block = self._run(
                client,
                {
                    "HARNESS_TRUSTED_ORGS": "acme, widgets",
                    "HARNESS_TRUSTED_USERS": "c",
                },
                td=td,
            )
            for who in ("from a", "from b", "from c"):
                self.assertIn(who, block)
            self.assertNotIn("from x", block)
            self.assertEqual(client.orgs_requested, ["acme", "widgets"])

    def test_an_org_that_cannot_be_resolved_fails_closed_even_with_users(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            client = FakeGitHubClient(
                issue_comments=[_issue(1, "carol", "2026-04-23T10:00:00Z", "hi", 50)],
                members_by_org={"acme": []},
                users={"carol": 50},
            )
            block = self._run(
                client,
                {"HARNESS_TRUSTED_ORGS": "acme", "HARNESS_TRUSTED_USERS": "carol"},
                td=td,
            )
            self.assertEqual(block, "")

    def test_users_only_fails_closed_when_no_login_resolves(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            client = FakeGitHubClient(
                issue_comments=[_issue(1, "carol", "2026-04-23T10:00:00Z", "hi", 50)],
                users_error=True,
            )
            block = self._run(client, {"HARNESS_TRUSTED_USERS": "carol"}, td=td)
            self.assertEqual(block, "")
            self.assertFalse((Path(td) / "discussion-context.json").exists())

    def test_explicit_arguments_override_the_environment(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            client = FakeGitHubClient(
                issue_comments=[_issue(1, "a", "2026-04-23T10:00:00Z", "hi", 1)],
                members_by_org={"other": [1]},
            )
            block = self._run(
                client,
                {"HARNESS_TRUSTED_ORGS": "acme"},
                td=td,
                trusted_orgs=["other"],
            )
            self.assertIn("hi", block)
            self.assertEqual(client.orgs_requested, ["other"])

    def test_trusted_lists_parse_commas_and_whitespace(self) -> None:
        with mock.patch.dict(
            os.environ,
            {"HARNESS_TRUSTED_ORGS": "a, b\tc,,", "HARNESS_TRUSTED_USERS": " x y"},
            clear=True,
        ):
            self.assertEqual(discussion_context._trusted_orgs(), ["a", "b", "c"])
            self.assertEqual(discussion_context._trusted_users(), ["x", "y"])
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(discussion_context._trusted_orgs(), [])
            self.assertEqual(discussion_context._trusted_users(), [])


class TestTrustedUserCache(unittest.TestCase):
    NOW = datetime(2026, 7, 7, 12, 0, tzinfo=UTC)

    def test_fresh_cache_is_served_without_a_lookup(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "trusted-users.json"
            client = FakeGitHubClient(users={"carol": 50})
            first = discussion_context._trusted_user_id(
                "carol",
                client=client,
                cache_path=path,
                now=self.NOW,  # type: ignore[arg-type]
            )
            second = discussion_context._trusted_user_id(
                "carol",
                client=client,  # type: ignore[arg-type]
                cache_path=path,
                now=self.NOW + timedelta(hours=5),
            )
            self.assertEqual((first, second), (50, 50))
            self.assertEqual(client.user_calls, ["carol"])

    def test_cache_expires_after_the_member_ttl(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "trusted-users.json"
            client = FakeGitHubClient(users={"carol": 50})
            discussion_context._trusted_user_id(
                "carol",
                client=client,
                cache_path=path,
                now=self.NOW,  # type: ignore[arg-type]
            )
            discussion_context._trusted_user_id(
                "carol",
                client=client,  # type: ignore[arg-type]
                cache_path=path,
                now=self.NOW + timedelta(hours=6, seconds=1),
            )
            self.assertEqual(client.user_calls, ["carol", "carol"])

    def test_logins_are_cached_independently(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "trusted-users.json"
            client = FakeGitHubClient(users={"carol": 50, "dave": 60})
            ids = [
                discussion_context._trusted_user_id(
                    login,
                    client=client,
                    cache_path=path,
                    now=self.NOW,  # type: ignore[arg-type]
                )
                for login in ("carol", "dave", "carol")
            ]
            self.assertEqual(ids, [50, 60, 50])
            self.assertEqual(client.user_calls, ["carol", "dave"])

    def test_failed_lookup_is_none_and_not_cached(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "trusted-users.json"
            client = FakeGitHubClient(users_error=True)
            out = discussion_context._trusted_user_id(
                "carol",
                client=client,
                cache_path=path,
                now=self.NOW,  # type: ignore[arg-type]
            )
            self.assertIsNone(out)
            self.assertFalse(path.exists())

    def test_stale_entry_is_served_within_grace_when_lookup_fails(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "trusted-users.json"
            ok = FakeGitHubClient(users={"carol": 50})
            discussion_context._trusted_user_id(
                "carol",
                client=ok,
                cache_path=path,
                now=self.NOW,  # type: ignore[arg-type]
            )
            down = FakeGitHubClient(users_error=True)
            within = discussion_context._trusted_user_id(
                "carol",
                client=down,  # type: ignore[arg-type]
                cache_path=path,
                now=self.NOW + timedelta(hours=10),
            )
            beyond = discussion_context._trusted_user_id(
                "carol",
                client=down,  # type: ignore[arg-type]
                cache_path=path,
                now=self.NOW + timedelta(hours=25),
            )
            self.assertEqual(within, 50)
            self.assertIsNone(beyond)


class TestTrustedMemberCache(unittest.TestCase):
    NOW = datetime(2026, 7, 7, 12, 0, tzinfo=UTC)

    def _write(self, path: Path, cache: dict[str, Any]) -> None:
        path.write_text(json.dumps(cache), encoding="utf-8")

    def test_fresh_cache_is_served_without_refetch(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            mpath = Path(td) / "trusted-members.json"
            self._write(
                mpath,
                {
                    "org": "acme",
                    "member_ids": [1, 2, 3],
                    "fetched_at": (self.NOW - timedelta(hours=1)).isoformat(),
                },
            )
            client = FakeGitHubClient(members=[7, 8, 9])
            ids = discussion_context._trusted_member_ids(
                "acme",
                client=client,
                cache_path=mpath,
                now=self.NOW,  # type: ignore[arg-type]
            )
            self.assertEqual(ids, {1, 2, 3})
            self.assertEqual(client.member_calls, 0)

    def test_missing_or_future_fetched_at_forces_refetch(self) -> None:
        # A missing/blank/non-ISO or future fetched_at must NOT pin the cache fresh
        # (the datetime.max sentinel would otherwise make `now - fetched_at` negative).
        for bad in (
            None,
            "",
            "not-a-date",
            (self.NOW + timedelta(days=3650)).isoformat(),
        ):
            with tempfile.TemporaryDirectory() as td:
                mpath = Path(td) / "trusted-members.json"
                cache: dict[str, Any] = {"org": "acme", "member_ids": [1, 2, 3]}
                if bad is not None:
                    cache["fetched_at"] = bad
                self._write(mpath, cache)
                client = FakeGitHubClient(members=[7, 8, 9])
                ids = discussion_context._trusted_member_ids(
                    "acme",
                    client=client,
                    cache_path=mpath,
                    now=self.NOW,  # type: ignore[arg-type]
                )
                self.assertEqual(ids, {7, 8, 9}, f"fetched_at={bad!r}")
                self.assertEqual(client.member_calls, 1, f"fetched_at={bad!r}")

    def test_stale_cache_served_within_grace_then_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            mpath = Path(td) / "trusted-members.json"
            # 10h old: past the 6h TTL but within the 24h stale grace → serve stale.
            self._write(
                mpath,
                {
                    "org": "acme",
                    "member_ids": [1, 2],
                    "fetched_at": (self.NOW - timedelta(hours=10)).isoformat(),
                },
            )
            failing = FakeGitHubClient(members_error=True)
            ids = discussion_context._trusted_member_ids(
                "acme",
                client=failing,
                cache_path=mpath,
                now=self.NOW,  # type: ignore[arg-type]
            )
            self.assertEqual(ids, {1, 2})

            # 30h old: past the grace window → fail closed (None) so a removed member
            # cannot stay trusted indefinitely while the fetch keeps failing.
            self._write(
                mpath,
                {
                    "org": "acme",
                    "member_ids": [1, 2],
                    "fetched_at": (self.NOW - timedelta(hours=30)).isoformat(),
                },
            )
            ids = discussion_context._trusted_member_ids(
                "acme",
                client=failing,
                cache_path=mpath,
                now=self.NOW,  # type: ignore[arg-type]
            )
            self.assertIsNone(ids)

    def test_non_list_member_ids_does_not_crash_and_refetches(self) -> None:
        for bad_ids in (None, 5, {"a": 1}):
            with tempfile.TemporaryDirectory() as td:
                mpath = Path(td) / "trusted-members.json"
                self._write(
                    mpath,
                    {
                        "org": "acme",
                        "member_ids": bad_ids,
                        "fetched_at": (self.NOW - timedelta(hours=1)).isoformat(),
                    },
                )
                client = FakeGitHubClient(members=[1])
                ids = discussion_context._trusted_member_ids(
                    "acme",
                    client=client,
                    cache_path=mpath,
                    now=self.NOW,  # type: ignore[arg-type]
                )
                self.assertEqual(ids, {1}, f"member_ids={bad_ids!r}")


if __name__ == "__main__":
    unittest.main()
