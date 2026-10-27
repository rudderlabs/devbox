"""Orchestration tests for the DeepAgents-native review loop.

The loop dispatches one lens agent per (repo, lens) pair and one per-repo fix
agent per iteration — both through module-level seams (`_run_lens_agent`,
`_run_repo_fix_agent`, `_review_model`, `harness.git.changed_files`,
`self_review.changed_files`) that these tests monkeypatch to drive the loop
without a real model or git checkout. `working_tree_fingerprint` is stubbed
with per-repo version counters so each test controls whether a pass "changed"
each repo's tree — the loop's primary no-changes terminator.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import re
import sys
import tempfile
import time
import unittest
from collections.abc import Callable
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from harness import git as git_module
from harness import obs
from harness.schemas.review import (
    MergedFindingsOutput,
    RepoReviewFixOutput,
    ReviewLensOutput,
)

# Sentinel decisions value: the fix agent returns no usable decisions,
# exercising the synthesized-decisions fallback.
EMPTY_DECISIONS = "empty-decisions"
# Sentinel: the worker raises (worker failure) — a fix agent's decisions are
# synthesized, a lens degrades to an empty result.
RAISE_FIX = "raise-fix"
# Sentinel: the process dies inside this worker (pod reaped / OOM). Raised
# as a BaseException so the loop's per-worker `except Exception` does not
# degrade it into a synthesized decline — it must escape the stage entirely.
DIE_FIX = "die-fix"
# Sentinel: like DIE_FIX, but only once the named agent is no longer in flight
# — makes "one landed, one mid-flight" deterministic regardless of thread
# scheduling or `as_completed` order. In a fix script it names a repo (fires
# once that repo is in `fix["outputs"]` per review-state.json); in a
# lens_outputs entry it is {DIE_AFTER: "<repo>/<lens>"} and fires once that
# pair's output is in `review["outputs"]` OR its thread was forgotten after
# the pass was checkpointed (the failure path).
DIE_AFTER = "die-after"


class _PodDeath(BaseException):
    pass


def _load_with_workspace(workspace: Path):
    """(Re)import paths/util/review with WORKSPACE pointed at *workspace*."""
    env = {"WORKSPACE": str(workspace)}
    with patch.dict(os.environ, env, clear=False):
        for mod_name in (
            "harness.paths",
            "harness.util",
            "harness.memory",
            "harness.distillation",
            "harness.plan_utils",
            "harness.self_review",
            "harness.cli",
        ):
            sys.modules.pop(mod_name, None)
        from importlib import import_module

        paths = import_module("harness.paths")
        util = import_module("harness.util")
        review = import_module("harness.self_review")
        return paths, util, review


def _impl_data(repos: list[dict] | None = None) -> dict[str, object]:
    return {
        "stage": "implementation",
        "run_id": "r1",
        "task": "t",
        "task_key": "ABC-1",
        "status": "completed",
        "repos": repos
        if repos is not None
        else [
            {
                "name": "config-backend",
                "path": "/workspace/config-backend",
                "changed_files": ["src/x.ts"],
                "summary": "did the thing",
                "commit_message": "feat: thing",
                "pr_title": "feat: thing",
                "pr_body": "## Summary\n- thing",
            }
        ],
        "generated_at": "2026-01-01T00:00:00Z",
    }


def _plan_data(repos: list[dict] | None = None) -> dict[str, object]:
    return {
        "stage": "planning",
        "run_id": "r1",
        "task": "t",
        "task_key": "ABC-1",
        "status": "completed",
        "repos": repos
        if repos is not None
        else [
            {
                "name": "config-backend",
                "path": "/workspace/config-backend",
                "goal": "fix",
                "planned_files_or_areas": ["src/x.ts"],
                "implementation_steps": [],
                "validation_steps": [],
                "risks": [],
            }
        ],
        "planning_notes": "n",
        "generated_at": "2026-01-01T00:00:00Z",
    }


def _crit_finding(**overrides) -> dict[str, object]:
    finding: dict[str, object] = {
        "severity": "critical",
        "confidence": 0.9,
        "title": "boom",
        "body": "b",
        "recommendation": "r",
        "file": "src/x.ts",
        "line_start": 1,
    }
    finding.update(overrides)
    return finding


def _medium_finding(**overrides) -> dict[str, object]:
    finding: dict[str, object] = {
        "severity": "medium",
        "confidence": 0.7,
        "title": "small thing",
        "body": "b",
        "recommendation": "r",
    }
    finding.update(overrides)
    return finding


def _recording_events(bodies: list[str]) -> MagicMock:
    """A round client stand-in that records each harness thought's body."""
    from harness.events import RoundEvents

    events = MagicMock(spec=RoundEvents)
    events.thought.side_effect = bodies.append
    return events


class TestReviewLoop(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.ws = Path(self._tmp.name)
        (self.ws / ".harness").mkdir(parents=True)
        self.paths, self.util, self.review = _load_with_workspace(self.ws)
        self.paths.IMPLEMENTATION_JSON.write_text(
            json.dumps(_impl_data()), encoding="utf-8"
        )

    def tearDown(self) -> None:
        for var in (
            "HARNESS_REVIEW_ENABLED",
            "HARNESS_REVIEW_MAX_ITERATIONS",
            "HARNESS_REVIEW_MAX_PARALLEL_LENSES",
        ):
            os.environ.pop(var, None)
        self._tmp.cleanup()

    # ------------------------------------------------------------------
    # Harness for driving the loop with stubbed DeepAgents dispatch
    # ------------------------------------------------------------------

    def _run(
        self,
        review_findings: list[list[dict]],
        fix_scripts: list[dict] | None = None,
        review_tree_mutations: list[bool] | None = None,
        inbox_id: str = "inbox-1",
        plan_data: dict | None = None,
        impl_data: dict | None = None,
        lens_outputs: dict | None = None,
        changed_files: list[str] | None = None,
        merge_outputs: dict | None = None,
        merge_raises: bool = False,
        changed_files_raises: bool = False,
        tree_versions: dict[str, int] | None = None,
        run_id: str = "r1",
        forget_raises_when: Callable[[str, dict], bool] | None = None,
        events: Any = None,
    ):
        """Invoke run_self_review_loop with stubbed DeepAgents workers.

        review_findings[i] is the findings list the `code-review` lens returns
        on iteration i+1 (other lenses return empty), unless `lens_outputs`
        maps (iteration, repo, lens) to a full output dict — or to RAISE_FIX
        (the lens worker raises), DIE_FIX (the process dies inside it), or
        {DIE_AFTER: "<repo>/<lens>"} (dies once that pair's output has landed
        in review-state.json, or its thread was forgotten after the pass was
        checkpointed — i.e. its worker failed).

        fix_scripts[i] configures the i-th fix pass, keyed by repo name (or
        "*" for every repo); each script is a dict with optional keys:
        - "decisions": literal decisions list, EMPTY_DECISIONS, or absent
          (absent → one all-"fixed" decision per finding id in the brief)
        - "tree_change": whether this repo's fingerprint advances (default
          True)
        - "summary": the updated repo summary the fix agent returns
        - RAISE_FIX: truthy → the fix worker raises
        - DIE_FIX: truthy → the process dies inside the worker (BaseException)
        - DIE_AFTER: repo name → as DIE_FIX, once that repo's output is
          checkpointed

        tree_versions is the fake working tree (per-repo version counters);
        pass the same dict to consecutive calls to model a PVC that survives a
        restart.

        review_tree_mutations[i] makes iteration i+1's review fan-out mutate
        the tree. Records lens calls in self.lens_calls (iteration, repo,
        lens, thread_id, brief) and fix calls in self.fix_calls (repo,
        thread_id, brief). Every thread the loop forgets (`_forget_thread`)
        is appended, in order, to self.forgotten; self.forget_phase maps each
        forgotten thread id to the (phase, iteration) review-state.json held
        at its LAST forget — a pre-dispatch forget precedes the pass's own
        checkpoint. Failure-path forgets (`_forget_failed_agent`) are also
        recorded, by identity, in self.failed_forgets. forget_raises_when(
        thread_id, state_on_disk) makes the fake forget raise.

        merge_outputs maps iteration → literal MergedFindingsOutput dict; when
        absent the fake merge agent passes every lens finding through
        unmerged (so harness-side clamping/cap is what tests observe) and writes
        a canned per-repo report. merge_raises makes the merge agent raise
        (the error propagates). Merge briefs are recorded in
        self.merge_calls (iteration, brief).
        """
        merge_outputs = merge_outputs or {}
        self.merge_calls: list[tuple[int, str]] = []
        lens_results: dict[int, dict[str, dict[str, dict]]] = {}
        fix_scripts = list(fix_scripts or [])
        review_tree_mutations = list(review_tree_mutations or [])
        lens_outputs = lens_outputs or {}
        if tree_versions is None:
            tree_versions = {}
        fix_pass_by_repo: dict[str, int] = {}
        self.lens_calls: list[tuple[int, str, str, str, str]] = []
        self.agent_threading: list[Any] = []
        self.fix_calls: list[tuple[str, str, str]] = []
        self.forgotten: list[str] = []
        self.forget_phase: dict[str, tuple[str | None, int | None]] = {}
        self.failed_forgets: list[str] = []
        real_forget_failed = self.review._forget_failed_agent

        def _state_on_disk() -> dict:
            try:
                return json.loads(
                    self.paths.REVIEW_STATE_JSON.read_text(encoding="utf-8")
                )
            except (OSError, ValueError):
                return {}

        def _poll_until(condition, what: str) -> None:
            deadline = time.monotonic() + 5.0
            while time.monotonic() < deadline:
                if condition():
                    return
                time.sleep(0.001)
            raise AssertionError(f"{what} never happened")

        def _fake_forget(thread_id):
            cached = _state_on_disk()
            if forget_raises_when is not None and forget_raises_when(thread_id, cached):
                raise RuntimeError("checkpointer unavailable")
            self.forgotten.append(thread_id)
            self.forget_phase[thread_id] = (
                cached.get("phase"),
                cached.get("iteration"),
            )

        def _fake_forget_failed(thread_id, scratch_dir, *, label):
            self.failed_forgets.append(thread_id)
            real_forget_failed(thread_id, scratch_dir, label=label)

        def _fake_fp(repo_paths):
            return "|".join(
                f"{p.name}:{tree_versions.get(p.name, 0)}"
                for p in sorted((Path(p) for p in repo_paths), key=str)
            )

        def _fake_model():
            return None, "fake-model"

        def _fake_lens(
            *,
            model,
            repo_name,
            repo_path,
            lens,
            thread_id,
            knowledge_subpaths,
            brief,
            events,
        ):
            self.agent_threading.append(events)
            m = re.search(r":iter-(\d+):", thread_id)
            iteration = int(m.group(1)) if m else 0
            self.lens_calls.append((iteration, repo_name, lens, thread_id, brief))
            if (
                iteration - 1 < len(review_tree_mutations)
                and review_tree_mutations[iteration - 1]
                and lens == "code-review"
            ):
                tree_versions[repo_name] = tree_versions.get(repo_name, 0) + 1
            key = (iteration, repo_name, lens)
            scripted = lens_outputs.get(key)
            if scripted == RAISE_FIX:
                raise RuntimeError("lens worker crashed")
            if scripted == DIE_FIX:
                raise _PodDeath()
            if isinstance(scripted, dict) and DIE_AFTER in scripted:
                wait_for = scripted[DIE_AFTER]
                pair_repo, pair_lens = wait_for.split("/", 1)
                wait_thread = (
                    f"review:{inbox_id}:iter-{iteration}:{pair_repo}:{pair_lens}"
                )

                def _landed_or_failed() -> bool:
                    cached = _state_on_disk()
                    landed = (
                        cached.get("phase") == "reviewing"
                        and cached.get("iteration") == iteration
                        and wait_for
                        in ((cached.get("review") or {}).get("outputs") or {})
                    )
                    return landed or wait_thread in self.failed_forgets

                _poll_until(_landed_or_failed, f"{wait_for} landing or failing")
                raise _PodDeath()
            if key in lens_outputs:
                out = dict(lens_outputs[key])
            elif lens == "code-review" and iteration - 1 < len(review_findings):
                out = {
                    "findings": [dict(f) for f in review_findings[iteration - 1]],
                    "summary": f"pass {iteration}",
                }
            else:
                out = {"findings": [], "summary": "clean"}
            # Route through the real schema so the fake can never drift from
            # the null-carrying shape `model_dump(mode="json")` produces.
            out = ReviewLensOutput.model_validate(out).model_dump(mode="json")
            lens_results.setdefault(iteration, {}).setdefault(repo_name, {})[lens] = out
            return out

        def _fake_fix(
            *,
            model,
            repo_name,
            repo_path,
            thread_id,
            knowledge_subpaths,
            brief,
            events,
        ):
            self.agent_threading.append(events)
            self.fix_calls.append((repo_name, thread_id, brief))
            idx = fix_pass_by_repo.get(repo_name, 0)
            fix_pass_by_repo[repo_name] = idx + 1
            script = fix_scripts[idx] if idx < len(fix_scripts) else {}
            repo_script = script.get(repo_name, script.get("*", {}))
            if repo_script.get(RAISE_FIX):
                raise RuntimeError("fix worker crashed")
            if repo_script.get(DIE_FIX):
                raise _PodDeath()
            if repo_script.get(DIE_AFTER):
                wait_for = repo_script[DIE_AFTER]
                _poll_until(
                    lambda: (
                        wait_for
                        in ((_state_on_disk().get("fix") or {}).get("outputs") or {})
                    ),
                    f"{wait_for} fix output landing",
                )
                raise _PodDeath()
            if repo_script.get("tree_change", True):
                tree_versions[repo_name] = tree_versions.get(repo_name, 0) + 1
            decisions = repo_script.get("decisions")
            if decisions == EMPTY_DECISIONS:
                decisions = []
            elif decisions is None:
                ids = re.findall(r'"id": "(iter\d+-f\d+)"', brief)
                decisions = [
                    {"finding_id": fid, "decision": "fixed", "reason": "fixed it"}
                    for fid in ids
                ]
            return RepoReviewFixOutput.model_validate({
                "decisions": decisions,
                "summary": repo_script.get("summary", ""),
            }).model_dump(mode="json")

        def _fake_changed_files(_repo_path):
            if changed_files_raises:
                raise RuntimeError("index.lock")
            return list(changed_files if changed_files is not None else ["src/x.ts"])

        def _fake_merge(*, model, run_id, iteration, brief, events):
            self.agent_threading.append(events)
            self.merge_calls.append((iteration, brief))
            if merge_raises:
                raise RuntimeError("merge agent crashed")
            if iteration in merge_outputs:
                # Literal outputs bypass the schema on purpose: several tests
                # feed the harness shapes the schema would reject.
                return dict(merge_outputs[iteration])
            # Pass-through: echo this iteration's recorded lens outputs
            # unmerged, so harness-side clamping/cap is what tests observe.
            by_repo = {
                name: dict(by_lens)
                for name, by_lens in lens_results.get(iteration, {}).items()
            }
            # Outputs a prior attempt checkpointed never pass through this
            # attempt's fake lens; the harness hands them to the merge from
            # review-state.json, so pick them up from there too.
            cached = _state_on_disk()
            if (
                cached.get("phase") == "reviewing"
                and cached.get("iteration") == iteration
            ):
                cached_outputs = (cached.get("review") or {}).get("outputs") or {}
                for key, out in cached_outputs.items():
                    repo_name, lens = key.split("/", 1)
                    by_repo.setdefault(repo_name, {}).setdefault(lens, out)
            repos = [
                {
                    "repo": repo_name,
                    "findings": [
                        {
                            **{k: v for k, v in f.items() if k != "lenses"},
                            "lenses": [lens],
                        }
                        for lens, out in by_lens.items()
                        for f in (out.get("findings") or [])
                    ],
                    "report": f"report for {repo_name}",
                }
                for repo_name, by_lens in by_repo.items()
            ]
            return MergedFindingsOutput.model_validate({
                "repos": repos,
                "summary": "merged",
            }).model_dump(mode="json")

        with (
            patch.object(self.review, "_review_model", side_effect=_fake_model),
            patch.object(self.review, "_run_merge_agent", side_effect=_fake_merge),
            patch.object(self.review, "_run_lens_agent", side_effect=_fake_lens),
            patch.object(self.review, "_run_repo_fix_agent", side_effect=_fake_fix),
            patch.object(self.review, "_forget_thread", side_effect=_fake_forget),
            patch.object(
                self.review, "_forget_failed_agent", side_effect=_fake_forget_failed
            ),
            patch.object(self.review, "working_tree_fingerprint", side_effect=_fake_fp),
            patch.object(
                git_module,
                "changed_files",
                side_effect=_fake_changed_files,
            ),
            patch.object(self.review, "changed_files", side_effect=_fake_changed_files),
        ):
            return self.review.run_self_review_loop(
                run_id=run_id,
                task="t",
                task_key="ABC-1",
                plan_data=plan_data or _plan_data(),
                impl_data=impl_data or _impl_data(),
                inbox_id=inbox_id,
                events=events,
            )

    # ------------------------------------------------------------------
    # Gate
    # ------------------------------------------------------------------

    def test_disabled_short_circuits(self) -> None:
        os.environ["HARNESS_REVIEW_ENABLED"] = "false"
        with (
            patch.object(self.review, "_review_model") as mock_model,
            patch.object(self.review, "_run_lens_agent") as mock_lens,
        ):
            review_data, impl = self.review.run_self_review_loop(
                run_id="r1",
                task="t",
                task_key="ABC-1",
                plan_data=_plan_data(),
                impl_data=_impl_data(),
                inbox_id="inbox-1",
                events=None,
            )
        self.assertEqual(review_data["final_verdict"], "disabled")
        self.assertEqual(review_data["termination_reason"], "disabled")
        self.assertEqual(review_data["iterations_run"], 0)
        self.assertEqual(review_data["inbox_id"], "inbox-1")
        mock_model.assert_not_called()
        mock_lens.assert_not_called()
        self.assertEqual(impl["repos"][0]["pr_body"], "## Summary\n- thing")
        self.assertTrue(self.paths.REVIEW_JSON.is_file())

    # ------------------------------------------------------------------
    # Deterministic lens dispatch
    # ------------------------------------------------------------------

    def test_lens_dispatch_code_review_only_by_default(self) -> None:
        """No planner flags → only the always-on generic sweep runs."""
        self._run([[]])
        lenses = [lens for (_i, _r, lens, _t, _b) in self.lens_calls]
        self.assertEqual(lenses, ["code-review"])

    def test_lens_dispatch_follows_planner_flags_in_canonical_order(self) -> None:
        plan = _plan_data()
        plan["repos"][0]["additional_review_lenses"] = [
            "code-quality",
            "bug-hunter",
            "security",
        ]
        self._run([[]], plan_data=plan)
        lenses = {lens for (_i, _r, lens, _t, _b) in self.lens_calls}
        self.assertEqual(
            lenses, {"code-review", "bug-hunter", "security", "code-quality"}
        )
        dispatch = json.loads(
            self.paths.review_iter_path(1).read_text(encoding="utf-8")
        )["lens_dispatch"]
        self.assertEqual(
            dispatch["config-backend"],
            ["code-review", "bug-hunter", "security", "code-quality"],
        )

    def test_lens_dispatch_is_per_repo(self) -> None:
        """Each repo gets exactly its own planner-flagged set."""
        impl = _impl_data(
            repos=[
                {
                    "name": "repo-a",
                    "path": "/workspace/repo-a",
                    "changed_files": ["a.ts"],
                    "summary": "a",
                    "commit_message": "m",
                    "pr_title": "t",
                    "pr_body": "b",
                },
                {
                    "name": "repo-b",
                    "path": "/workspace/repo-b",
                    "changed_files": ["b.ts"],
                    "summary": "b",
                    "commit_message": "m",
                    "pr_title": "t",
                    "pr_body": "b",
                },
            ]
        )
        plan = _plan_data(
            repos=[
                {
                    "name": "repo-a",
                    "path": "/workspace/repo-a",
                    "goal": "g",
                    "planned_files_or_areas": [],
                    "implementation_steps": [],
                    "validation_steps": [],
                    "risks": [],
                    "additional_review_lenses": ["bug-hunter", "bird-eye"],
                },
                {
                    "name": "repo-b",
                    "path": "/workspace/repo-b",
                    "goal": "g",
                    "planned_files_or_areas": [],
                    "implementation_steps": [],
                    "validation_steps": [],
                    "risks": [],
                },
            ]
        )
        self._run([[]], impl_data=impl, plan_data=plan)
        dispatch = json.loads(
            self.paths.review_iter_path(1).read_text(encoding="utf-8")
        )["lens_dispatch"]
        self.assertEqual(dispatch["repo-a"], ["code-review", "bug-hunter", "bird-eye"])
        self.assertEqual(dispatch["repo-b"], ["code-review"])

    def test_lens_and_fix_threads_are_fresh_per_iteration(self) -> None:
        self._run(
            [[_crit_finding()], []],
            fix_scripts=[{"config-backend": {}}],
            inbox_id="inbox-7",
        )
        lens_threads = [t for (_i, _r, _l, t, _b) in self.lens_calls]
        self.assertEqual(len(lens_threads), len(set(lens_threads)))
        iter1 = [t for t in lens_threads if ":iter-1:" in t]
        iter2 = [t for t in lens_threads if ":iter-2:" in t]
        self.assertTrue(iter1 and iter2)
        for t in lens_threads:
            self.assertTrue(t.startswith("review:inbox-7:"))
        # Fix pass runs on its own per-(assignment, iteration, repo) thread —
        # never the implementation thread.
        self.assertEqual(len(self.fix_calls), 1)
        self.assertEqual(
            self.fix_calls[0][1], "review-fix:inbox-7:iter-1:config-backend"
        )
        self.assertNotIn("implementation:", self.fix_calls[0][1])

    def test_fix_brief_carries_implementer_account_and_plan(self) -> None:
        impl = _impl_data()
        impl["repos"][0]["design_notes"] = "chose polling over websockets: infra"
        self._run(
            [[_crit_finding()], []],
            fix_scripts=[{"config-backend": {}}],
            impl_data=impl,
        )
        brief = self.fix_calls[0][2]
        self.assertIn("Implementer's account", brief)
        self.assertIn("chose polling over websockets", brief)
        self.assertIn("did the thing", brief)
        self.assertIn('"goal": "fix"', brief)
        self.assertNotIn("resuming the implementation session", brief)

    # ------------------------------------------------------------------
    # Verdicts and loop flow
    # ------------------------------------------------------------------

    def test_clean_first_iteration_approved(self) -> None:
        review_data, impl = self._run([[]])
        self.assertEqual(review_data["final_verdict"], "approved")
        self.assertEqual(review_data["termination_reason"], "approved")
        self.assertEqual(review_data["iterations_run"], 1)
        self.assertEqual(review_data["unresolved_findings"], [])
        self.assertEqual(review_data["fix_iterations"], [])
        self.assertEqual(impl["repos"][0]["pr_body"], "## Summary\n- thing")
        # The harness composed and persisted the iteration artifact itself.
        on_disk = json.loads(self.paths.review_iter_path(1).read_text(encoding="utf-8"))
        self.assertEqual(on_disk["verdict"], "approve")
        self.assertIn("lens dispatch:", on_disk["summary"])

    def test_medium_finding_triggers_fix_pass(self) -> None:
        """A medium finding is actionable: the fix pass runs (no severity or
        confidence gate), fixes it, and the re-review approves."""
        review_data, impl = self._run(
            [[_medium_finding()], []],
            fix_scripts=[{"config-backend": {}}],
        )
        self.assertEqual(review_data["final_verdict"], "approved")
        self.assertEqual(review_data["termination_reason"], "approved")
        self.assertEqual(review_data["iterations_run"], 2)
        self.assertEqual(len(review_data["fix_iterations"]), 1)
        self.assertTrue(review_data["fix_iterations"][0]["tree_changed"])
        self.assertEqual(review_data["unresolved_findings"], [])
        self.assertNotIn("Auto-review unresolved", impl["repos"][0]["pr_body"])

    def test_medium_finding_declined_ships_with_reason(self) -> None:
        """A declined medium finding ships as approved_with_warnings after a
        fix pass, with the decline reason included in the PR body."""
        review_data, impl = self._run(
            [[_medium_finding()]],
            fix_scripts=[
                {
                    "config-backend": {
                        "decisions": [
                            {
                                "finding_id": "iter1-f1",
                                "decision": "declined",
                                "reason": (
                                    "intended per plan; titles are section-only"
                                ),
                            }
                        ],
                        "tree_change": False,
                    }
                }
            ],
        )
        self.assertEqual(review_data["final_verdict"], "approved_with_warnings")
        self.assertEqual(review_data["termination_reason"], "declined_all")
        self.assertEqual(review_data["iterations_run"], 1)
        unresolved = review_data["unresolved_findings"]
        self.assertEqual(len(unresolved), 1)
        self.assertEqual(unresolved[0]["disposition"], "declined")
        self.assertEqual(
            unresolved[0]["decline_reason"],
            "intended per plan; titles are section-only",
        )
        body = impl["repos"][0]["pr_body"]
        self.assertIn("Auto-review unresolved", body)
        self.assertIn("implementer declined:", body)
        self.assertIn("intended per plan; titles are section-only", body)

    def test_low_confidence_finding_still_triaged(self) -> None:
        """No confidence floor: even a low-confidence finding reaches the fix
        pass, which judges it on its merits (here: fixed, then approved)."""
        review_data, _impl = self._run(
            [
                [_crit_finding(severity="high", confidence=0.3, title="wobbly")],
                [],
            ],
            fix_scripts=[{"config-backend": {}}],
        )
        self.assertEqual(review_data["final_verdict"], "approved")
        self.assertEqual(review_data["iterations_run"], 2)
        self.assertEqual(len(review_data["fix_iterations"]), 1)
        self.assertEqual(len(self.fix_calls), 1)

    # ------------------------------------------------------------------
    # Observability: stage duration event + harness-authored progress
    # ------------------------------------------------------------------

    def test_review_stage_duration_event_emitted(self) -> None:
        """The shared timer logs `harness.stage_duration` for review with run,
        task, and sandbox identifiers that structured log queries can filter."""
        with patch.object(obs, "log_event") as mock_log:
            self._run([[]])
        events = [
            c.kwargs
            for c in mock_log.call_args_list
            if c.args and c.args[0] == obs.STAGE_DURATION_EVENT
        ]
        self.assertEqual(len(events), 1)
        ev = events[0]
        self.assertEqual(ev["harness_stage"], "review")
        self.assertEqual(ev["outcome"], "ok")
        self.assertEqual(ev["harness_run_id"], "r1")
        self.assertEqual(ev["harness_task_key"], "ABC-1")
        self.assertIn("harness_sandbox_id", ev)
        self.assertGreaterEqual(ev["duration_ms"], 0)

    def test_review_stage_duration_marks_error_outcome(self) -> None:
        """A crash inside the loop still accounts for its elapsed time."""
        with (
            patch.object(obs, "log_event") as mock_log,
            patch.object(self.review, "_review_model", return_value=(None, "m")),
            patch.object(
                self.review,
                "_run_review_iterations",
                side_effect=RuntimeError("boom"),
            ),
            self.assertRaises(RuntimeError),
        ):
            self.review.run_self_review_loop(
                run_id="r1",
                task="t",
                task_key="ABC-1",
                plan_data=_plan_data(),
                impl_data=_impl_data(),
                inbox_id="inbox-1",
                events=None,
            )
        events = [
            c.kwargs
            for c in mock_log.call_args_list
            if c.args and c.args[0] == obs.STAGE_DURATION_EVENT
        ]
        self.assertEqual([e["outcome"] for e in events], ["error"])

    def test_review_disabled_emits_no_stage_duration(self) -> None:
        os.environ["HARNESS_REVIEW_ENABLED"] = "false"
        with (
            patch.object(obs, "log_event") as mock_log,
            patch.object(self.review, "_review_model"),
        ):
            self.review.run_self_review_loop(
                run_id="r1",
                task="t",
                task_key="ABC-1",
                plan_data=_plan_data(),
                impl_data=_impl_data(),
                inbox_id="inbox-1",
                events=None,
            )
        self.assertFalse(
            any(
                c.args and c.args[0] == obs.STAGE_DURATION_EVENT
                for c in mock_log.call_args_list
            )
        )

    def test_progress_thoughts_mark_loop_boundaries(self) -> None:
        """Harness-authored thoughts bracket each pass: dispatch, findings
        summary, fix outcome, and the final verdict — the agents' own
        `emit_progress` never says which pass it is or how it ended."""
        os.environ["HARNESS_REVIEW_MAX_ITERATIONS"] = "3"
        bodies: list[str] = []
        self._run(
            [[_crit_finding()], []],
            fix_scripts=[{"config-backend": {}}],
            events=_recording_events(bodies),
        )
        self.assertEqual(
            bodies,
            [
                "Review pass 1/3: 1 lens review(s) across `config-backend`.",
                "Review pass 1: 1 finding(s) (1 critical) — sending to the fix pass.",
                "Fix pass 1: 1 fixed, 0 declined.",
                "Review pass 2/3: 1 lens review(s) across `config-backend`.",
                "Review pass 2: no findings — approved.",
                "Review finished (no findings left); approved, "
                "0 unresolved finding(s).",
            ],
        )

    def test_review_finished_thought_reaches_the_event_log_without_env(self) -> None:
        """The harness's own thoughts go through the injected client, not env."""
        from harness.events import RoundEvents, iter_events

        os.environ["HARNESS_REVIEW_MAX_ITERATIONS"] = "3"
        with tempfile.TemporaryDirectory() as tmp:
            events_file = Path(tmp) / "events.jsonl"
            events = RoundEvents(
                events_file=events_file,
                events_lock=Path(tmp) / "events.lock",
                inbox_id="inbox-1",
                target_id="t-9",
            )
            with patch.dict(os.environ, {}, clear=True):
                self._run(
                    [[_crit_finding()], []],
                    fix_scripts=[{"config-backend": {}}],
                    events=events,
                )
            logged = list(iter_events(events_file))
        thoughts = [e for e in logged if e.get("type") == "agent_thought"]
        self.assertTrue(thoughts)
        self.assertEqual({e["target_id"] for e in thoughts}, {"t-9"})
        self.assertEqual({e["inbox_id"] for e in thoughts}, {"inbox-1"})
        self.assertEqual(
            [e["body"] for e in thoughts][-1],
            "Review finished (no findings left); approved, 0 unresolved finding(s).",
        )
        self.assertTrue(self.agent_threading)
        self.assertTrue(all(t is events for t in self.agent_threading))

    def test_critical_fixed_by_iter_2_updates_summary_and_changed_files(
        self,
    ) -> None:
        review_data, impl = self._run(
            [[_crit_finding()], []],
            fix_scripts=[
                {
                    "config-backend": {
                        "summary": "did the thing (review-fix: addressed boom)"
                    }
                }
            ],
            changed_files=["src/x.ts", "src/y.ts"],
        )
        self.assertEqual(review_data["final_verdict"], "approved")
        self.assertEqual(review_data["iterations_run"], 2)
        self.assertEqual(review_data["unresolved_findings"], [])
        decisions = review_data["fix_iterations"][0]["decisions"]
        self.assertEqual(decisions[0]["decision"], "fixed")
        self.assertNotIn("Auto-review unresolved", impl["repos"][0]["pr_body"])
        # The harness folded the fix output back into implementation.json:
        # summary from structured output, changed_files recomputed from git.
        self.assertIn("review-fix: addressed boom", impl["repos"][0]["summary"])
        self.assertEqual(impl["repos"][0]["changed_files"], ["src/x.ts", "src/y.ts"])
        on_disk = json.loads(self.paths.IMPLEMENTATION_JSON.read_text(encoding="utf-8"))
        self.assertIn("review-fix: addressed boom", on_disk["repos"][0]["summary"])

    def test_persistent_critical_loop_exhausted(self) -> None:
        os.environ["HARNESS_REVIEW_MAX_ITERATIONS"] = "3"
        crit = _crit_finding()
        review_data, impl = self._run(
            [[crit], [crit], [crit]],
            fix_scripts=[{"config-backend": {}}, {"config-backend": {}}],
        )
        self.assertEqual(review_data["final_verdict"], "loop_exhausted")
        self.assertEqual(review_data["termination_reason"], "max_iterations")
        self.assertEqual(review_data["iterations_run"], 3)
        unresolved = review_data["unresolved_findings"]
        self.assertEqual(len(unresolved), 1)
        self.assertEqual(unresolved[0]["disposition"], "not_attempted")
        body = impl["repos"][0]["pr_body"]
        self.assertIn("Auto-review unresolved", body)
        self.assertIn("not auto-fixed (iteration budget exhausted)", body)
        on_disk = json.loads(self.paths.IMPLEMENTATION_JSON.read_text(encoding="utf-8"))
        self.assertIn("Auto-review unresolved", on_disk["repos"][0]["pr_body"])

    def test_fix_fold_invalid_impl_keeps_pre_fix_record(self) -> None:
        """If folding fix outputs produces an invalid implementation.json, the
        loop must keep the pre-fix record so the commit stage still has a
        usable artifact, surface the unresolved findings, and exit cleanly."""
        with patch.object(
            self.review,
            "_validate_implementation",
            side_effect=ValueError("broken"),
        ):
            review_data, impl = self._run(
                [[_crit_finding()]],
                fix_scripts=[{"config-backend": {}}],
            )
        self.assertEqual(review_data["iterations_run"], 1)
        self.assertEqual(review_data["final_verdict"], "loop_exhausted")
        self.assertEqual(
            review_data["termination_reason"], "fix_invalid_implementation"
        )
        unresolved = review_data["unresolved_findings"]
        self.assertEqual(len(unresolved), 1)
        self.assertEqual(unresolved[0]["disposition"], "fix_failed")
        self.assertEqual(impl["repos"][0]["name"], "config-backend")
        self.assertEqual(impl["repos"][0]["changed_files"], ["src/x.ts"])
        on_disk = json.loads(self.paths.IMPLEMENTATION_JSON.read_text(encoding="utf-8"))
        self.assertEqual(on_disk["repos"][0]["name"], "config-backend")
        body = impl["repos"][0]["pr_body"]
        self.assertIn("Auto-review unresolved", body)
        self.assertIn("auto-fix failed; implementation record restored", body)
        self.assertIn("edits remain in the working tree", body)

    def test_fix_declines_all_terminates_loop(self) -> None:
        """A fix pass that declines everything (no tree change) ends the loop
        immediately — no further review iteration is spent."""
        review_data, impl = self._run(
            [[_crit_finding()]],
            fix_scripts=[
                {
                    "config-backend": {
                        "decisions": [
                            {
                                "finding_id": "iter1-f1",
                                "decision": "declined",
                                "reason": (
                                    "reviewer misread the guard; input is sanitized"
                                ),
                            }
                        ],
                        "tree_change": False,
                    }
                }
            ],
        )
        self.assertEqual(review_data["final_verdict"], "approved_with_warnings")
        self.assertEqual(review_data["termination_reason"], "declined_all")
        self.assertEqual(review_data["iterations_run"], 1)
        review_iterations = {i for (i, _r, _l, _t, _b) in self.lens_calls}
        self.assertEqual(review_iterations, {1})
        fix_iter = review_data["fix_iterations"][0]
        self.assertFalse(fix_iter["tree_changed"])
        self.assertFalse(fix_iter["synthesized"])
        self.assertIn(
            "reviewer misread the guard; input is sanitized",
            impl["repos"][0]["pr_body"],
        )

    def test_fix_claims_fixed_but_tree_unchanged_terminates(self) -> None:
        """The working tree is ground truth: a 'fixed' claim with no tree
        change is overridden to declined and the loop terminates."""
        review_data, _impl = self._run(
            [[_crit_finding()]],
            fix_scripts=[
                {
                    "config-backend": {
                        "decisions": [
                            {
                                "finding_id": "iter1-f1",
                                "decision": "fixed",
                                "reason": "totally fixed it",
                            }
                        ],
                        "tree_change": False,
                    }
                }
            ],
        )
        self.assertEqual(review_data["termination_reason"], "declined_all")
        decision = review_data["fix_iterations"][0]["decisions"][0]
        self.assertEqual(decision["decision"], "declined")
        self.assertIn("no working-tree change", decision["reason"])
        unresolved = review_data["unresolved_findings"]
        self.assertEqual(unresolved[0]["disposition"], "declined")
        self.assertIn("no working-tree change", unresolved[0]["decline_reason"])

    def test_all_declined_but_tree_changed_continues_loop(self) -> None:
        """All-declined decisions with a changed tree cannot terminate the
        loop — changed code must be re-reviewed."""
        review_data, _impl = self._run(
            [[_crit_finding()], []],
            fix_scripts=[
                {
                    "config-backend": {
                        "decisions": [
                            {
                                "finding_id": "iter1-f1",
                                "decision": "declined",
                                "reason": "not a bug, but tidied adjacent code",
                            }
                        ],
                        "tree_change": True,
                    }
                }
            ],
        )
        self.assertEqual(review_data["final_verdict"], "approved")
        self.assertEqual(review_data["iterations_run"], 2)
        self.assertTrue(review_data["fix_iterations"][0]["tree_changed"])

    def test_partial_decline_passes_declines_to_next_review(self) -> None:
        """Declined findings + reasons are embedded in the next iteration's
        lens briefs so the reviewers can concur or escalate."""
        f1 = _medium_finding(title="fix me", confidence=0.9)
        f2 = _medium_finding(title="decline me", confidence=0.7)
        review_data, _impl = self._run(
            [[f1, f2], []],
            fix_scripts=[
                {
                    "config-backend": {
                        # Findings are strength-ordered at merge: f1 (0.9)
                        # becomes iter1-f1, f2 (0.7) becomes iter1-f2.
                        "decisions": [
                            {
                                "finding_id": "iter1-f1",
                                "decision": "fixed",
                                "reason": "fixed it",
                            },
                            {
                                "finding_id": "iter1-f2",
                                "decision": "declined",
                                "reason": "behavior is intended per plan",
                            },
                        ],
                        "tree_change": True,
                    }
                }
            ],
        )
        self.assertEqual(review_data["final_verdict"], "approved")
        iter1_briefs = [b for (i, _r, _l, _t, b) in self.lens_calls if i == 1]
        iter2_briefs = [b for (i, _r, _l, _t, b) in self.lens_calls if i == 2]
        self.assertTrue(iter2_briefs)
        for brief in iter1_briefs:
            self.assertNotIn("Previously declined findings", brief)
        for brief in iter2_briefs:
            self.assertIn("Previously declined findings", brief)
            self.assertIn("behavior is intended per plan", brief)
            self.assertIn("decline me", brief)
            self.assertNotIn("fix me", brief)

    def test_fix_decisions_empty_synthesized_tree_changed(self) -> None:
        """No usable decisions + changed tree → synthesized DECLINED decisions
        (a repo-wide tree change never proves a specific finding was fixed);
        the changed tree still sends the loop to a re-review."""
        review_data, _impl = self._run(
            [[_crit_finding()], []],
            fix_scripts=[
                {"config-backend": {"decisions": EMPTY_DECISIONS}},
            ],
        )
        self.assertEqual(review_data["final_verdict"], "approved")
        self.assertEqual(review_data["iterations_run"], 2)
        fix_iter = review_data["fix_iterations"][0]
        self.assertTrue(fix_iter["synthesized"])
        self.assertEqual(fix_iter["decisions"][0]["decision"], "declined")
        self.assertIn("tree changed", fix_iter["decisions"][0]["reason"])

    def test_fix_decisions_empty_synthesized_tree_unchanged(self) -> None:
        """No usable decisions + unchanged tree → synthesized all-declined
        decisions; the loop terminates as declined_all."""
        review_data, _impl = self._run(
            [[_crit_finding()]],
            fix_scripts=[
                {
                    "config-backend": {
                        "decisions": EMPTY_DECISIONS,
                        "tree_change": False,
                    }
                },
            ],
        )
        self.assertEqual(review_data["termination_reason"], "declined_all")
        self.assertEqual(review_data["iterations_run"], 1)
        fix_iter = review_data["fix_iterations"][0]
        self.assertTrue(fix_iter["synthesized"])
        self.assertEqual(fix_iter["decisions"][0]["decision"], "declined")
        unresolved = review_data["unresolved_findings"]
        self.assertEqual(unresolved[0]["disposition"], "declined")

    def test_fix_worker_failure_synthesizes_decisions(self) -> None:
        """A fix worker that dies after retries degrades to synthesized
        decisions instead of failing the loop — and a crash is NOT a decline:
        the loop continues and the repo is re-dispatched, so a persistent
        crash ends on the iteration budget (never `declined_all` /
        `approved_with_warnings`)."""
        os.environ["HARNESS_REVIEW_MAX_ITERATIONS"] = "3"
        review_data, _impl = self._run(
            [[_crit_finding()], [_crit_finding()], [_crit_finding()]],
            fix_scripts=[
                {"config-backend": {RAISE_FIX: True}},
                {"config-backend": {RAISE_FIX: True}},
            ],
        )
        self.assertEqual(review_data["termination_reason"], "max_iterations")
        self.assertEqual(review_data["final_verdict"], "loop_exhausted")
        self.assertEqual(len(self.fix_calls), 2)
        fix_iter = review_data["fix_iterations"][0]
        self.assertTrue(fix_iter["synthesized"])
        self.assertFalse(fix_iter["tree_changed"])
        self.assertEqual(fix_iter["decisions"][0]["decision"], "declined")
        self.assertTrue(fix_iter["decisions"][0]["harness_synthesized"])
        self.assertEqual(
            review_data["unresolved_findings"][0]["disposition"], "not_attempted"
        )

    def test_synthesized_declines_not_briefed_as_implementer_rationale(self) -> None:
        """Harness-synthesized declines (crashed worker, missing decision) must
        not reach the next iteration's lens brief as "implementer rationale"
        the reviewer is told to concur with."""
        self._run(
            [[_crit_finding()], [_crit_finding()]],
            fix_scripts=[{"config-backend": {RAISE_FIX: True}}],
        )
        iter2_briefs = [b for (it, _r, _l, _t, b) in self.lens_calls if it == 2]
        self.assertTrue(iter2_briefs)
        for brief in iter2_briefs:
            self.assertNotIn("synthesized:", brief)
            self.assertNotIn("Previously declined findings", brief)

    def test_scratch_sweep_removes_other_runs_and_keeps_own(self) -> None:
        """Entry sweep drops scratch left by other assignments but never
        this assignment's own directory."""
        import shutil

        root = self.paths.REVIEW_SCRATCH_DIR
        stale = root / "inbox-dead"
        own = root / "inbox-1" / "keep-me"
        stale.mkdir(parents=True)
        (stale / "repro.sh").write_text("echo", encoding="utf-8")
        own.mkdir(parents=True)
        removed: list[Path] = []
        real_rmtree = shutil.rmtree

        def _recording_rmtree(path, **kwargs):
            removed.append(Path(path))
            real_rmtree(path, **kwargs)

        with patch.object(self.review.shutil, "rmtree", side_effect=_recording_rmtree):
            self._run([[]])
        self.assertFalse(stale.exists())
        # Entry sweep: the stale run goes first; this run's own tree is never
        # targeted by the sweep (it is only removed by the exit cleanup).
        self.assertEqual(removed[0], stale)
        self.assertNotIn(own, removed)
        self.assertNotIn(root / "inbox-1", removed[:1])

    def test_review_scratch_dir_is_isolated_from_host_tmp(self) -> None:
        """The loop sweeps REVIEW_SCRATCH_DIR; the suite must never point it
        at the host's real /tmp (tests/__init__ exports DEVBOX_RUNTIME_DIR)."""
        runtime = os.environ["DEVBOX_RUNTIME_DIR"]
        self.assertNotEqual(runtime, "/tmp")
        self.assertTrue(
            str(self.paths.REVIEW_SCRATCH_DIR).startswith(runtime),
            self.paths.REVIEW_SCRATCH_DIR,
        )

    def test_reviewer_tree_mutation_flagged(self) -> None:
        """A review fan-out that mutates the working tree is flagged on the
        iteration record (loud signal; no auto-revert)."""
        review_data, _impl = self._run([[]], review_tree_mutations=[True])
        self.assertTrue(review_data["iterations"][0]["working_tree_mutated"])

    def test_finding_ids_stamped(self) -> None:
        review_data, _impl = self._run(
            [[_medium_finding()]],
            fix_scripts=[
                {
                    "config-backend": {
                        "decisions": [
                            {
                                "finding_id": "iter1-f1",
                                "decision": "declined",
                                "reason": "intended",
                            }
                        ],
                        "tree_change": False,
                    }
                }
            ],
        )
        self.assertEqual(review_data["iterations"][0]["findings"][0]["id"], "iter1-f1")
        self.assertEqual(review_data["unresolved_findings"][0]["id"], "iter1-f1")

    def test_review_json_stamped_with_inbox_id(self) -> None:
        review_data, _impl = self._run([[]], inbox_id="inbox-9")
        self.assertEqual(review_data["inbox_id"], "inbox-9")
        on_disk = json.loads(self.paths.REVIEW_JSON.read_text(encoding="utf-8"))
        self.assertEqual(on_disk["inbox_id"], "inbox-9")

    # ------------------------------------------------------------------
    # Briefs
    # ------------------------------------------------------------------

    def test_lens_brief_contains_scope_and_scratch(self) -> None:
        self._run([[]])
        _i, _r, _l, _t, brief = self.lens_calls[0]
        self.assertIn("<task>t</task>", brief)
        self.assertIn("scratch dir", brief)
        self.assertIn("review-scratch", brief)
        self.assertIn('"changed_files"', brief)
        self.assertIn('"goal": "fix"', brief)

    def test_fix_brief_contains_triage_contract(self) -> None:
        self._run(
            [[_crit_finding()], []],
            fix_scripts=[{"config-backend": {}}],
        )
        self.assertEqual(len(self.fix_calls), 1)
        brief = self.fix_calls[0][2]
        self.assertIn("Review findings to triage", brief)
        self.assertIn('"id": "iter1-f1"', brief)
        self.assertIn("Current summary:", brief)
        self.assertIn("did the thing", brief)

    def test_fix_brief_lists_human_decision_as_decline_reason(self) -> None:
        """The brief's decline reasons include "asks for a human decision" —
        without it the fixer's only listed exit was "fix", and a prod
        migration was once reverted to dodge an "unconfirmed denylist"
        finding, which the next pass then flagged as a HIGH."""
        self._run(
            [[_crit_finding()], []],
            fix_scripts=[{"config-backend": {}}],
        )
        brief = self.fix_calls[0][2]
        self.assertIn(
            "or it asks for a human decision rather than a code change", brief
        )

    def test_ungrounded_critical_demoted_not_fatal(self) -> None:
        """A critical/high finding without file+line is a legal strict-schema
        lens response; the harness demotes it to medium instead of letting the
        artifact validator kill the run."""
        review_data, _impl = self._run(
            [],
            lens_outputs={
                (1, "config-backend", "code-review"): {
                    "findings": [
                        {
                            "severity": "critical",
                            "confidence": 0.9,
                            "title": "vague boom",
                            "body": "b",
                            "recommendation": "r",
                            "file": None,
                            "line_start": None,
                        }
                    ],
                    "summary": "found something vague",
                },
            },
            fix_scripts=[{"config-backend": {"tree_change": False}}],
        )
        finding = review_data["iterations"][0]["findings"][0]
        self.assertEqual(finding["severity"], "medium")
        self.assertIn("demoted from critical", finding["body"])
        self.assertEqual(review_data["termination_reason"], "declined_all")

    def test_lens_worker_failure_degrades_not_fatal(self) -> None:
        """One lens worker dying must degrade coverage, not fail the run."""
        plan = _plan_data()
        plan["repos"][0]["additional_review_lenses"] = ["bug-hunter"]
        review_data, _impl = self._run(
            [[]],
            plan_data=plan,
            lens_outputs={
                (1, "config-backend", "bug-hunter"): RAISE_FIX,
            },
        )
        self.assertEqual(review_data["final_verdict"], "approved")
        self.assertEqual(review_data["iterations_run"], 1)
        self.assertIn("lens worker failed", review_data["iterations"][0]["summary"])

    def test_no_scope_terminates_without_review(self) -> None:
        """No repo with changed files → no lens dispatch, explicit no_scope
        termination instead of a fabricated adversarial approval."""
        impl = _impl_data()
        impl["repos"][0]["changed_files"] = []
        review_data, _impl = self._run([], impl_data=impl)
        self.assertEqual(review_data["termination_reason"], "no_scope")
        self.assertEqual(review_data["final_verdict"], "approved")
        self.assertEqual(review_data["iterations_run"], 0)
        self.assertEqual(self.lens_calls, [])

    # ------------------------------------------------------------------
    # Merge agent
    # ------------------------------------------------------------------

    def test_merge_agent_report_reaches_fix_brief(self) -> None:
        review_data, _impl = self._run(
            [[_crit_finding()], []],
            fix_scripts=[{"config-backend": {}}],
        )
        it = review_data["iterations"][0]
        self.assertEqual(it["merge_strategy"], "agent")
        self.assertEqual(it["reports"], {"config-backend": "report for config-backend"})
        self.assertEqual(it["findings"][0]["lenses"], ["code-review"])
        brief = self.fix_calls[0][2]
        self.assertIn("### Reviewer report for this repository", brief)
        self.assertIn("```markdown\nreport for config-backend\n```", brief)
        self.assertIn("scratch dir", brief)
        # Merge brief carried the raw lens output grouped by repo then lens.
        self.assertEqual(len(self.merge_calls), 1)
        self.assertIn('"config-backend"', self.merge_calls[0][1])
        self.assertIn('"code-review"', self.merge_calls[0][1])

    def test_merge_agent_skipped_when_no_findings(self) -> None:
        review_data, _impl = self._run([[]])
        self.assertEqual(self.merge_calls, [])
        self.assertEqual(
            review_data["iterations"][0]["merge_strategy"], "skipped-no-findings"
        )

    def test_merge_agent_failure_propagates(self) -> None:
        """The merge is part of the review contract: no silent fallback."""
        with self.assertRaises(RuntimeError):
            self._run(
                [[_crit_finding()]],
                fix_scripts=[{"config-backend": {"tree_change": False}}],
                merge_raises=True,
            )

    def test_merge_agent_output_clamped_by_harness(self) -> None:
        """Agent cannot invent repos, claim lenses that did not run, or keep
        an ungrounded critical; the harness normalizes its output."""
        review_data, _impl = self._run(
            [[_crit_finding()]],
            fix_scripts=[{"config-backend": {"tree_change": False}}],
            merge_outputs={
                1: {
                    "summary": "s",
                    "repos": [
                        {
                            "repo": "config-backend",
                            "report": "r",
                            "findings": [
                                {
                                    **_crit_finding(),
                                    "lenses": ["security", "code-review"],
                                },
                                {
                                    **_crit_finding(
                                        title="vague", file=None, line_start=None
                                    ),
                                    "lenses": ["code-review"],
                                },
                            ],
                        },
                        {
                            "repo": "made-up",
                            "report": "x",
                            "findings": [_crit_finding()],
                        },
                    ],
                }
            },
        )
        findings = review_data["iterations"][0]["findings"]
        self.assertEqual({f["repo"] for f in findings}, {"config-backend"})
        boom = next(f for f in findings if f["title"] == "boom")
        self.assertEqual(boom["lenses"], ["code-review"])  # security did not run
        self.assertNotIn("lens", boom)
        vague = next(f for f in findings if f["title"] == "vague")
        self.assertEqual(vague["severity"], "medium")

    def test_every_lens_failing_raises(self) -> None:
        """Zero adversarial coverage must never read as an approval."""
        with self.assertRaises(RuntimeError):
            self._run(
                [[]],
                lens_outputs={(1, "config-backend", "code-review"): RAISE_FIX},
            )

    def test_repo_with_every_lens_failed_raises_even_if_siblings_succeed(
        self,
    ) -> None:
        """The zero-coverage rule is per repo: one repo losing its whole lens
        set must not be carried to an approval by a clean sibling."""
        impl, plan = self._two_repo_fixture()
        with self.assertRaisesRegex(RuntimeError, r"\['repo-a'\]"):
            self._run(
                [],
                lens_outputs={
                    (1, "repo-a", "code-review"): RAISE_FIX,
                    (1, "repo-b", "code-review"): {"findings": [], "summary": "ok"},
                },
                impl_data=impl,
                plan_data=plan,
            )

    def test_merge_agent_dropping_one_repo_raises(self) -> None:
        """Per-repo reconciliation: a repo whose lenses reported findings must
        still have findings after the merge."""
        impl, plan = self._two_repo_fixture()
        with self.assertRaises(RuntimeError):
            self._run(
                [],
                lens_outputs={
                    (1, "repo-a", "code-review"): {
                        "findings": [_crit_finding(title="a", file="a.ts")],
                        "summary": "a",
                    },
                    (1, "repo-b", "code-review"): {
                        "findings": [_crit_finding(title="b", file="b.ts")],
                        "summary": "b",
                    },
                },
                merge_outputs={
                    1: {
                        "summary": "s",
                        "repos": [
                            {
                                "repo": "repo-a",
                                "report": "r",
                                "findings": [
                                    {
                                        **_crit_finding(title="a", file="a.ts"),
                                        "lenses": ["code-review"],
                                    }
                                ],
                            }
                        ],
                    }
                },
                impl_data=impl,
                plan_data=plan,
            )

    def test_merge_agent_dropping_all_findings_raises(self) -> None:
        """Lenses reported findings; the merge returned nothing usable → the
        stage fails loudly instead of approving."""
        with self.assertRaises(RuntimeError):
            self._run(
                [[_crit_finding()]],
                merge_outputs={1: {"repos": [], "summary": "nothing"}},
            )
        with self.assertRaises(RuntimeError):
            self._run(
                [[_crit_finding()]],
                merge_outputs={
                    1: {
                        "repos": [
                            {
                                "repo": "/workspace/config-backend",
                                "report": "r",
                                "findings": [{**_crit_finding(), "lenses": []}],
                            }
                        ],
                        "summary": "misnamed",
                    }
                },
                inbox_id="inbox-2",
            )

    def test_merge_agent_empty_lenses_stay_unattributed(self) -> None:
        review_data, _impl = self._run(
            [[_crit_finding()]],
            fix_scripts=[{"config-backend": {"tree_change": False}}],
            merge_outputs={
                1: {
                    "repos": [
                        {
                            "repo": "config-backend",
                            "report": "r",
                            "findings": [{**_crit_finding(), "lenses": []}],
                        }
                    ],
                    "summary": "s",
                }
            },
        )
        finding = review_data["iterations"][0]["findings"][0]
        self.assertEqual(finding["lenses"], [])
        self.assertNotIn("lens", finding)

    # ------------------------------------------------------------------
    # Fix-pass ground truth
    # ------------------------------------------------------------------

    def _two_repo_fixture(self) -> tuple[dict, dict]:
        impl = _impl_data(
            repos=[
                {
                    "name": "repo-a",
                    "path": "/workspace/repo-a",
                    "changed_files": ["a.ts"],
                    "summary": "A original",
                    "commit_message": "m",
                    "pr_title": "t",
                    "pr_body": "## Summary\nA",
                },
                {
                    "name": "repo-b",
                    "path": "/workspace/repo-b",
                    "changed_files": ["b.ts"],
                    "summary": "B original",
                    "commit_message": "m",
                    "pr_title": "t",
                    "pr_body": "## Summary\nB",
                },
            ]
        )
        plan = _plan_data(
            repos=[
                {
                    "name": n,
                    "path": f"/workspace/{n}",
                    "goal": "g",
                    "planned_files_or_areas": [],
                    "implementation_steps": [],
                    "validation_steps": [],
                    "risks": [],
                }
                for n in ("repo-a", "repo-b")
            ]
        )
        return impl, plan

    def test_summary_not_folded_for_repo_with_unchanged_tree(self) -> None:
        """A fix agent's self-authored summary must not ship when the harness
        proved its repo's tree never changed."""
        impl, plan = self._two_repo_fixture()
        _review_data, out_impl = self._run(
            [],
            lens_outputs={
                (1, "repo-a", "code-review"): {
                    "findings": [_crit_finding(title="a bug", file="a.ts")],
                    "summary": "a",
                },
                (1, "repo-b", "code-review"): {
                    "findings": [_crit_finding(title="b bug", file="b.ts")],
                    "summary": "b",
                },
                (2, "repo-a", "code-review"): {"findings": [], "summary": "clean"},
                (2, "repo-b", "code-review"): {"findings": [], "summary": "clean"},
            },
            fix_scripts=[
                {
                    "repo-a": {
                        "tree_change": True,
                        "summary": "A original + review-fix: fixed a bug",
                    },
                    "repo-b": {
                        "tree_change": False,
                        "summary": "B original + review-fix: fixed b bug",
                    },
                }
            ],
            impl_data=impl,
            plan_data=plan,
        )
        by_name = {r["name"]: r for r in out_impl["repos"]}
        self.assertIn("review-fix: fixed a bug", by_name["repo-a"]["summary"])
        self.assertEqual(by_name["repo-b"]["summary"], "B original")

    def test_settled_repo_is_not_redispatched(self) -> None:
        """A repo that declined everything with no tree change gets no fix
        agent in later iterations; its re-raised findings are auto-declined."""
        os.environ["HARNESS_REVIEW_MAX_ITERATIONS"] = "3"
        impl, plan = self._two_repo_fixture()
        a_bug = _crit_finding(title="a bug", file="a.ts")
        b_bug = _crit_finding(title="b bug", file="b.ts")
        b_reraise = {**b_bug, "prior_finding_id": "iter1-f2"}
        review_data, _impl = self._run(
            [],
            lens_outputs={
                (1, "repo-a", "code-review"): {"findings": [a_bug], "summary": "a"},
                (1, "repo-b", "code-review"): {"findings": [b_bug], "summary": "b"},
                (2, "repo-a", "code-review"): {"findings": [a_bug], "summary": "a"},
                (2, "repo-b", "code-review"): {
                    "findings": [b_reraise],
                    "summary": "b",
                },
                (3, "repo-a", "code-review"): {"findings": [], "summary": "clean"},
                (3, "repo-b", "code-review"): {"findings": [], "summary": "clean"},
            },
            fix_scripts=[
                {"repo-a": {"tree_change": True}, "repo-b": {"tree_change": False}},
                {"repo-a": {"tree_change": True}, "repo-b": {"tree_change": False}},
            ],
            impl_data=impl,
            plan_data=plan,
        )
        fix_repos_per_pass = [c[0] for c in self.fix_calls]
        self.assertEqual(fix_repos_per_pass.count("repo-a"), 2)
        self.assertEqual(fix_repos_per_pass.count("repo-b"), 1)
        iter2 = review_data["fix_iterations"][1]["decisions"]
        b_decision = next(d for d in iter2 if d["finding_id"] == "iter2-f2")
        self.assertEqual(b_decision["decision"], "declined")
        self.assertIn("not re-dispatched", b_decision["reason"])

    def test_crashed_fix_worker_does_not_settle_repo(self) -> None:
        """A worker that died never decided anything; the repo must get a fix
        agent again next iteration."""
        os.environ["HARNESS_REVIEW_MAX_ITERATIONS"] = "3"
        impl, plan = self._two_repo_fixture()
        a_bug = _crit_finding(title="a bug", file="a.ts")
        b_bug = _crit_finding(title="b bug", file="b.ts")
        review_data, _impl = self._run(
            [],
            lens_outputs={
                (1, "repo-a", "code-review"): {"findings": [a_bug], "summary": "a"},
                (1, "repo-b", "code-review"): {"findings": [b_bug], "summary": "b"},
                (2, "repo-a", "code-review"): {"findings": [], "summary": "clean"},
                (2, "repo-b", "code-review"): {"findings": [b_bug], "summary": "b"},
                (3, "repo-a", "code-review"): {"findings": [], "summary": "clean"},
                (3, "repo-b", "code-review"): {"findings": [], "summary": "clean"},
            },
            fix_scripts=[
                {"repo-a": {"tree_change": True}, "repo-b": {RAISE_FIX: True}},
                {"repo-b": {"tree_change": True}},
            ],
            impl_data=impl,
            plan_data=plan,
        )
        self.assertEqual(review_data["final_verdict"], "approved")
        self.assertEqual([c[0] for c in self.fix_calls].count("repo-b"), 2)

    def test_settled_repo_reraise_carries_reason_forward(self) -> None:
        os.environ["HARNESS_REVIEW_MAX_ITERATIONS"] = "3"
        impl, plan = self._two_repo_fixture()
        a_bug = _crit_finding(title="a bug", file="a.ts")
        b_bug = _crit_finding(title="b bug", file="b.ts")
        b_reraise = {**b_bug, "prior_finding_id": "iter1-f2"}
        review_data, out_impl = self._run(
            [],
            lens_outputs={
                (1, "repo-a", "code-review"): {"findings": [a_bug], "summary": "a"},
                (1, "repo-b", "code-review"): {"findings": [b_bug], "summary": "b"},
                (2, "repo-a", "code-review"): {"findings": [], "summary": "clean"},
                (2, "repo-b", "code-review"): {
                    "findings": [b_reraise],
                    "summary": "b",
                },
            },
            fix_scripts=[
                {
                    "repo-a": {"tree_change": True},
                    "repo-b": {
                        "tree_change": False,
                        "decisions": [
                            {
                                "finding_id": "iter1-f2",
                                "decision": "declined",
                                "reason": "guarded by the caller contract",
                            }
                        ],
                    },
                },
            ],
            impl_data=impl,
            plan_data=plan,
        )
        # Iteration 2: repo-b re-raised → auto-declined with the ORIGINAL reason.
        decision = review_data["fix_iterations"][1]["decisions"][0]
        self.assertEqual(decision["finding_id"], "iter2-f1")
        self.assertIn("guarded by the caller contract", decision["reason"])
        self.assertIn("carried forward", decision["reason"])
        self.assertTrue(decision["harness_synthesized"])
        self.assertEqual(review_data["termination_reason"], "declined_all")
        by_name = {r["name"]: r for r in out_impl["repos"]}
        self.assertIn("guarded by the caller contract", by_name["repo-b"]["pr_body"])
        # Bookkeeping declines never become "implementer rationale" for lenses.
        iter2_b_briefs = [
            b for (i, r, _l, _t, b) in self.lens_calls if i == 2 and r == "repo-b"
        ]
        self.assertIn("guarded by the caller contract", iter2_b_briefs[0])

    def test_settled_repo_new_finding_marked_not_triaged(self) -> None:
        os.environ["HARNESS_REVIEW_MAX_ITERATIONS"] = "3"
        impl, plan = self._two_repo_fixture()
        a_bug = _crit_finding(title="a bug", file="a.ts")
        b_bug = _crit_finding(title="b bug", file="b.ts")
        b_new = _crit_finding(title="totally different", file="other.ts", line_start=90)
        review_data, _impl = self._run(
            [],
            lens_outputs={
                (1, "repo-a", "code-review"): {"findings": [a_bug], "summary": "a"},
                (1, "repo-b", "code-review"): {"findings": [b_bug], "summary": "b"},
                (2, "repo-a", "code-review"): {"findings": [], "summary": "clean"},
                (2, "repo-b", "code-review"): {"findings": [b_new], "summary": "b"},
            },
            fix_scripts=[
                {"repo-a": {"tree_change": True}, "repo-b": {"tree_change": False}}
            ],
            impl_data=impl,
            plan_data=plan,
        )
        decision = review_data["fix_iterations"][1]["decisions"][0]
        self.assertIn("newly raised finding was not triaged", decision["reason"])

    def test_settled_repo_colocated_new_finding_not_given_old_reason(self) -> None:
        """A new finding on the SAME lines as a prior decline, but without
        `prior_finding_id`, must not inherit that decline's rationale — a
        human would read a plausible reason for something never triaged."""
        os.environ["HARNESS_REVIEW_MAX_ITERATIONS"] = "3"
        impl, plan = self._two_repo_fixture()
        a_bug = _crit_finding(title="a bug", file="a.ts")
        b_naming = _medium_finding(
            title="Naming could be clearer", file="b.ts", line_start=10, line_end=40
        )
        b_auth = _crit_finding(
            title="Auth bypass: permission check removed", file="b.ts", line_start=22
        )
        review_data, out_impl = self._run(
            [],
            lens_outputs={
                (1, "repo-a", "code-review"): {"findings": [a_bug], "summary": "a"},
                (1, "repo-b", "code-review"): {"findings": [b_naming], "summary": "b"},
                (2, "repo-a", "code-review"): {"findings": [], "summary": "clean"},
                (2, "repo-b", "code-review"): {"findings": [b_auth], "summary": "b"},
            },
            fix_scripts=[
                {
                    "repo-a": {"tree_change": True},
                    "repo-b": {
                        "tree_change": False,
                        "decisions": [
                            {
                                "finding_id": "iter1-f2",
                                "decision": "declined",
                                "reason": "naming is intentional, matches the API",
                            }
                        ],
                    },
                },
            ],
            impl_data=impl,
            plan_data=plan,
        )
        decision = review_data["fix_iterations"][1]["decisions"][0]
        self.assertIn("newly raised finding was not triaged", decision["reason"])
        self.assertNotIn("naming is intentional", decision["reason"])
        by_name = {r["name"]: r for r in out_impl["repos"]}
        self.assertIn("Auth bypass", by_name["repo-b"]["pr_body"])
        self.assertNotIn("naming is intentional", by_name["repo-b"]["pr_body"])

    def test_max_iterations_keeps_settled_declines(self) -> None:
        os.environ["HARNESS_REVIEW_MAX_ITERATIONS"] = "2"
        impl, plan = self._two_repo_fixture()
        a_bug = _crit_finding(title="a bug", file="a.ts")
        b_bug = _crit_finding(title="b bug", file="b.ts")
        b_reraise = {**b_bug, "prior_finding_id": "iter1-f2"}
        review_data, _impl = self._run(
            [],
            lens_outputs={
                (1, "repo-a", "code-review"): {"findings": [a_bug], "summary": "a"},
                (1, "repo-b", "code-review"): {"findings": [b_bug], "summary": "b"},
                (2, "repo-a", "code-review"): {"findings": [a_bug], "summary": "a"},
                (2, "repo-b", "code-review"): {
                    "findings": [b_reraise],
                    "summary": "b",
                },
            },
            fix_scripts=[
                {"repo-a": {"tree_change": True}, "repo-b": {"tree_change": False}}
            ],
            impl_data=impl,
            plan_data=plan,
        )
        self.assertEqual(review_data["termination_reason"], "max_iterations")
        by_repo = {f["repo"]: f for f in review_data["unresolved_findings"]}
        self.assertEqual(by_repo["repo-a"]["disposition"], "not_attempted")
        self.assertEqual(by_repo["repo-b"]["disposition"], "declined")
        self.assertIn("carried forward", by_repo["repo-b"]["decline_reason"])

    def test_scope_lost_keeps_previous_declines(self) -> None:
        f1 = _medium_finding(title="fix me", confidence=0.9)
        f2 = _medium_finding(title="decline me", confidence=0.7)
        review_data, _impl = self._run(
            [[f1, f2]],
            fix_scripts=[
                {
                    "config-backend": {
                        "decisions": [
                            {
                                "finding_id": "iter1-f1",
                                "decision": "fixed",
                                "reason": "ok",
                            },
                            {
                                "finding_id": "iter1-f2",
                                "decision": "declined",
                                "reason": "intended",
                            },
                        ],
                        "tree_change": True,
                    }
                }
            ],
            changed_files=[],
        )
        self.assertEqual(review_data["termination_reason"], "scope_lost")
        unresolved = review_data["unresolved_findings"]
        self.assertEqual([u["title"] for u in unresolved], ["decline me"])
        self.assertEqual(unresolved[0]["decline_reason"], "intended")

    def test_annotation_idempotent_with_heading_in_reason(self) -> None:
        body = "## Summary\n- thing\n\n## Test plan\n- run\n"
        finding = {
            **_crit_finding(),
            "repo": "config-backend",
            "id": "iter1-f1",
            "disposition": "declined",
            "decline_reason": "Intentional.\n## Rationale\nCallers guarantee non-null.",
        }
        impl = _impl_data()
        impl["repos"][0]["pr_body"] = body
        once = self.review._annotate_pr_bodies(impl, [finding])
        twice = self.review._annotate_pr_bodies(once, [finding])
        self.assertEqual(once["repos"][0]["pr_body"], twice["repos"][0]["pr_body"])
        out = twice["repos"][0]["pr_body"]
        self.assertEqual(out.count("Auto-review unresolved"), 1)
        self.assertNotIn("\n## Rationale", out)
        self.assertIn("Intentional. ## Rationale Callers guarantee non-null.", out)
        self.assertIn("## Test plan", out)
        cleared = self.review._annotate_pr_bodies(twice, [])
        self.assertEqual(cleared["repos"][0]["pr_body"], body)

    def test_annotation_survives_unclosed_html_comment(self) -> None:
        impl = _impl_data()
        impl["repos"][0]["pr_body"] = "## Summary\n- thing\n<!-- trailing"
        finding = {
            **_crit_finding(),
            "repo": "config-backend",
            "id": "iter1-f1",
            "disposition": "not_attempted",
        }
        out = self.review._annotate_pr_bodies(impl, [finding])["repos"][0]["pr_body"]
        # The agent's dangling `<!--` must be closed BEFORE the harness marker,
        # or GitHub swallows the whole annotation into the comment.
        closer = out.index("-->")
        marker = out.index(self.review._PR_BODY_ANNOTATION_START)
        self.assertLess(closer, marker)
        self.assertIn("<!-- trailing\n-->", out)

    def test_all_repos_settled_terminates_declined_all(self) -> None:
        impl, plan = self._two_repo_fixture()
        a_bug = _crit_finding(title="a bug", file="a.ts")
        b_bug = _crit_finding(title="b bug", file="b.ts")
        review_data, _impl = self._run(
            [],
            lens_outputs={
                (1, "repo-a", "code-review"): {"findings": [a_bug], "summary": "a"},
                (1, "repo-b", "code-review"): {"findings": [b_bug], "summary": "b"},
            },
            fix_scripts=[
                {"repo-a": {"tree_change": False}, "repo-b": {"tree_change": False}},
            ],
            impl_data=impl,
            plan_data=plan,
        )
        self.assertEqual(review_data["termination_reason"], "declined_all")
        self.assertEqual(review_data["iterations_run"], 1)

    def test_overridden_decision_drops_files_changed(self) -> None:
        review_data, _impl = self._run(
            [[_crit_finding()]],
            fix_scripts=[
                {
                    "config-backend": {
                        "decisions": [
                            {
                                "finding_id": "iter1-f1",
                                "decision": "fixed",
                                "reason": "fixed",
                                "files_changed": ["src/x.ts"],
                            }
                        ],
                        "tree_change": False,
                    }
                }
            ],
        )
        decision = review_data["fix_iterations"][0]["decisions"][0]
        self.assertEqual(decision["decision"], "declined")
        self.assertNotIn("files_changed", decision)

    def test_scope_lost_after_fix_erases_change(self) -> None:
        """A fix pass that empties changed_files must not read as approval."""
        review_data, impl = self._run(
            [[_crit_finding()]],
            fix_scripts=[{"config-backend": {"tree_change": True}}],
            changed_files=[],
        )
        self.assertEqual(review_data["termination_reason"], "scope_lost")
        self.assertEqual(review_data["final_verdict"], "loop_exhausted")
        self.assertIn("removed every change", impl["repos"][0]["pr_body"])

    def test_changed_files_git_failure_degrades(self) -> None:
        review_data, impl = self._run(
            [[_crit_finding()]],
            fix_scripts=[{"config-backend": {}}],
            changed_files_raises=True,
        )
        self.assertEqual(
            review_data["termination_reason"], "fix_invalid_implementation"
        )
        self.assertEqual(impl["repos"][0]["changed_files"], ["src/x.ts"])

    def test_stale_annotation_stripped_on_clean_rerun(self) -> None:
        """A restart that resolves everything must not ship a prior run's
        unresolved section."""
        impl = _impl_data()
        impl["repos"][0]["pr_body"] = (
            "## Summary\n- thing\n\n## ⚠️ Auto-review unresolved\n\n"
            "- **critical**: boom — `src/x.ts:1`\n\n## Test plan\n- run tests\n"
        )
        _review_data, out = self._run([[]], impl_data=impl)
        body = out["repos"][0]["pr_body"]
        self.assertNotIn("Auto-review unresolved", body)
        self.assertIn("## Test plan", body)
        self.assertIn("- thing", body)

    def test_tree_mutation_surfaces_in_pr_body(self) -> None:
        _review_data, impl = self._run([[]], review_tree_mutations=[True])
        body = impl["repos"][0]["pr_body"]
        self.assertIn("Auto-review unresolved", body)
        self.assertIn("modified the working tree in iteration(s) 1", body)

    # ------------------------------------------------------------------
    # Iteration-boundary checkpoint / resume
    # ------------------------------------------------------------------

    def _state(self) -> dict:
        return json.loads(self.paths.REVIEW_STATE_JSON.read_text(encoding="utf-8"))

    def test_checkpoint_phases_bracket_each_pass_and_clear_on_completion(self) -> None:
        """review-state.json advances reviewing → reviewed → fixing → done
        per iteration and is removed once review.json (the stage gate) exists."""
        phases: list[str] = []
        real_write_json = self.review.write_json

        def _spy(path, data):
            if path == self.paths.REVIEW_STATE_JSON:
                phases.append(data["phase"])
            real_write_json(path, data)

        with patch.object(self.review, "write_json", side_effect=_spy):
            self._run(
                [[_crit_finding()], []],
                fix_scripts=[{"config-backend": {}}],
                inbox_id="inbox-1",
            )
        # "reviewing" twice: at dispatch (baseline + dispatch set) and when
        # the lens output lands. "fixing" three times: at dispatch (baselines),
        # when the output lands, and when the fix-pass thought is posted.
        self.assertEqual(
            phases,
            [
                "reviewing",
                "reviewing",
                "reviewed",
                "fixing",
                "fixing",
                "fixing",
                "done",
                "reviewing",
                "reviewing",
                "reviewed",
            ],
        )
        self.assertFalse(self.paths.REVIEW_STATE_JSON.exists())
        self.assertTrue(self.paths.REVIEW_JSON.exists())

    def test_resume_after_completed_fix_pass_starts_at_next_review(self) -> None:
        """Died during review 2 → restart skips review 1 + fix 1 entirely,
        keeps their artifacts, and the restored declined context reaches the
        iteration-2 lens brief."""
        os.environ["HARNESS_REVIEW_MAX_ITERATIONS"] = "3"
        tree: dict[str, int] = {}
        declined = {
            "finding_id": "iter1-f1",
            "decision": "declined",
            "reason": "by design: the null check is upstream",
        }
        # Attempt 1: fix 1 declines with a tree change (so the loop continues),
        # then every lens dies on review 2 → the stage raises.
        with self.assertRaises(RuntimeError):
            self._run(
                [[_crit_finding()]],
                fix_scripts=[{"config-backend": {"decisions": [declined]}}],
                lens_outputs={(2, "config-backend", "code-review"): RAISE_FIX},
                inbox_id="inbox-1",
                tree_versions=tree,
            )
        # Review 2 was dispatched (its checkpoint is on disk) but its only
        # lens failed, so its thread was forgotten after the checkpoint: the
        # resume dispatches it fresh rather than re-entering that context.
        state = self._state()
        self.assertEqual((state["iteration"], state["phase"]), (2, "reviewing"))
        self.assertEqual(state["review"]["outputs"], {})
        self.assertEqual(state["review"]["pairs"], ["config-backend/code-review"])
        self.assertEqual(
            self.failed_forgets, ["review:inbox-1:iter-2:config-backend:code-review"]
        )
        self.assertTrue(self.paths.review_iter_path(1).exists())
        self.assertTrue(self.paths.review_fix_iter_path(1).exists())

        # Attempt 2: review 2 is clean. impl_data is what the handler loads
        # from disk — the post-fold record attempt 1 wrote.
        review_data, _impl = self._run(
            [[_crit_finding()], []],
            inbox_id="inbox-1",
            tree_versions=tree,
            impl_data=self.review.load_json_file(self.paths.IMPLEMENTATION_JSON),
            run_id="r2",
        )
        self.assertEqual([c[0] for c in self.lens_calls], [2])
        # Resumed pass: the pair is dispatched on its deterministic id and
        # nothing is forgotten — the dead attempt already did that.
        self.assertEqual(
            [c[3] for c in self.lens_calls],
            ["review:inbox-1:iter-2:config-backend:code-review"],
        )
        self.assertEqual(self.forgotten, [])
        self.assertEqual(self.fix_calls, [])
        self.assertIn("by design: the null check is upstream", self.lens_calls[0][4])
        self.assertEqual(review_data["iterations_run"], 2)
        self.assertEqual(review_data["final_verdict"], "approved")
        self.assertEqual(review_data["termination_reason"], "approved")
        self.assertEqual(
            [d["decision"] for d in review_data["fix_iterations"][0]["decisions"]],
            ["declined"],
        )
        self.assertTrue(self.paths.review_iter_path(1).exists())
        self.assertFalse(
            self.paths.review_iter_path(1).with_name("review-iter-1.json.prev").exists()
        )
        self.assertTrue(self.paths.review_fix_iter_path(1).exists())
        self.assertFalse(
            self.paths
            .review_fix_iter_path(1)
            .with_name("review-fix-iter-1.json.prev")
            .exists()
        )
        self.assertFalse(self.paths.REVIEW_STATE_JSON.exists())

    def test_resume_mid_fix_pass_reuses_baselines_and_landed_outputs(self) -> None:
        """Died with repo-a's fix agent finished (tree edited, output
        checkpointed) and repo-b's mid-flight → restart re-dispatches only
        repo-b, and repo-a is judged against the pre-dispatch baseline so its
        landed fix is folded rather than read as 'no change' and settled."""
        impl, plan = self._two_repo_fixture()
        self.paths.IMPLEMENTATION_JSON.write_text(json.dumps(impl), encoding="utf-8")
        a_bug = _crit_finding(title="a bug", file="a.ts")
        b_bug = _crit_finding(title="b bug", file="b.ts")
        lens_outputs = {
            (1, "repo-a", "code-review"): {"findings": [a_bug], "summary": "a"},
            (1, "repo-b", "code-review"): {"findings": [b_bug], "summary": "b"},
        }
        tree: dict[str, int] = {}
        with self.assertRaises(_PodDeath):
            self._run(
                [],
                lens_outputs=lens_outputs,
                fix_scripts=[
                    {
                        "repo-a": {"summary": "A after fix"},
                        "repo-b": {DIE_AFTER: "repo-a"},
                    }
                ],
                inbox_id="inbox-1",
                plan_data=plan,
                impl_data=json.loads(json.dumps(impl)),
                tree_versions=tree,
            )
        state = self._state()
        self.assertEqual((state["iteration"], state["phase"]), (1, "fixing"))
        self.assertEqual(sorted(state["fix"]["fix_repos"]), ["repo-a", "repo-b"])
        self.assertEqual(list(state["fix"]["outputs"]), ["repo-a"])
        self.assertEqual(state["fix"]["pre_fix_fps"]["repo-a"], "repo-a:0")
        self.assertEqual(tree, {"repo-a": 1})  # A's edits survive on the PVC
        self.assertFalse(self.paths.review_fix_iter_path(1).exists())
        # First dispatch: both fix threads forgotten before the fix checkpoint.
        self.assertEqual(
            [t for t in self.forgotten if t.startswith("review-fix:")],
            ["review-fix:inbox-1:iter-1:repo-a", "review-fix:inbox-1:iter-1:repo-b"],
        )
        self.assertEqual(
            self.forget_phase["review-fix:inbox-1:iter-1:repo-b"], ("reviewed", 1)
        )

        review_data, out_impl = self._run(
            [],
            lens_outputs=lens_outputs,
            fix_scripts=[{"repo-b": {"summary": "B after fix"}}],
            inbox_id="inbox-1",
            plan_data=plan,
            impl_data=self.review.load_json_file(self.paths.IMPLEMENTATION_JSON),
            tree_versions=tree,
            run_id="r2",
        )
        # Review 1 reused, only repo-b's fix agent ran, review 2 ran clean.
        self.assertEqual([c[0] for c in self.lens_calls], [2, 2])
        self.assertEqual([c[0] for c in self.fix_calls], ["repo-b"])
        # repo-b is dispatched on the same deterministic thread the dead
        # attempt used, and nothing is forgotten: the runner resumes it rather
        # than sending a fresh brief on top of its partial edits.
        self.assertEqual(self.fix_calls[0][1], "review-fix:inbox-1:iter-1:repo-b")
        self.assertEqual([t for t in self.forgotten if t.startswith("review-fix:")], [])
        decisions = {
            d["finding_id"]: d["decision"]
            for d in review_data["fix_iterations"][0]["decisions"]
        }
        self.assertEqual(decisions, {"iter1-f1": "fixed", "iter1-f2": "fixed"})
        by_name = {r["name"]: r for r in out_impl["repos"]}
        self.assertEqual(by_name["repo-a"]["summary"], "A after fix")
        self.assertEqual(by_name["repo-b"]["summary"], "B after fix")
        self.assertEqual(review_data["final_verdict"], "approved")
        self.assertFalse(self.paths.REVIEW_STATE_JSON.exists())

    def test_resume_after_reviewed_dispatches_fix_pass_with_fresh_baselines(
        self,
    ) -> None:
        """A 'reviewed' checkpoint (fix pass never dispatched) resumes straight
        into the fix pass: review 1 is not re-run, baselines are taken now."""
        tree: dict[str, int] = {}
        with self.assertRaises(_PodDeath):
            self._run(
                [[_crit_finding()]],
                fix_scripts=[{"config-backend": {DIE_FIX: True}}],
                inbox_id="inbox-1",
                tree_versions=tree,
            )
        state = self._state()
        state["phase"] = "reviewed"
        state["fix"] = None
        self.paths.REVIEW_STATE_JSON.write_text(json.dumps(state), encoding="utf-8")
        tree["config-backend"] = 5  # the tree moved on; baselines must see it

        baselines: list[dict] = []
        real_write_json = self.review.write_json

        def _spy(path, data):
            if path == self.paths.REVIEW_STATE_JSON and data["phase"] == "fixing":
                baselines.append(dict(data["fix"]["pre_fix_fps"]))
            real_write_json(path, data)

        with patch.object(self.review, "write_json", side_effect=_spy):
            review_data, _impl = self._run(
                [[_crit_finding()], []],
                fix_scripts=[{"config-backend": {}}],
                inbox_id="inbox-1",
                tree_versions=tree,
                run_id="r2",
            )
        self.assertEqual(baselines[0], {"config-backend": "config-backend:5"})
        self.assertEqual([c[0] for c in self.lens_calls], [2])
        self.assertEqual(len(self.fix_calls), 1)
        # Never dispatched before: forgotten (no stale thread can survive)
        # and dispatched on the deterministic id.
        self.assertEqual(
            self.fix_calls[0][1], "review-fix:inbox-1:iter-1:config-backend"
        )
        self.assertIn("review-fix:inbox-1:iter-1:config-backend", self.forgotten)
        self.assertEqual(review_data["iterations_run"], 2)
        self.assertEqual(review_data["final_verdict"], "approved")

    def test_resume_with_every_fix_output_cached_recomposes_without_agents(
        self,
    ) -> None:
        """Died between writing review-fix-iter-1.json (fold done) and the
        `done` checkpoint: the resume recomposes from cache alone, re-folds
        idempotently and dispatches nothing."""
        real_write_json = self.review.write_json

        def _die_before_done(path, data):
            if path == self.paths.REVIEW_STATE_JSON and data["phase"] == "done":
                raise _PodDeath()
            real_write_json(path, data)

        tree: dict[str, int] = {}
        with (
            patch.object(self.review, "write_json", side_effect=_die_before_done),
            self.assertRaises(_PodDeath),
        ):
            self._run(
                [[_crit_finding()]],
                fix_scripts=[{"config-backend": {"summary": "fixed summary"}}],
                inbox_id="inbox-1",
                tree_versions=tree,
            )
        state = self._state()
        self.assertEqual(state["phase"], "fixing")
        self.assertEqual(list(state["fix"]["outputs"]), ["config-backend"])
        self.assertTrue(self.paths.review_fix_iter_path(1).exists())
        first_artifact = self.review.load_json_file(self.paths.review_fix_iter_path(1))
        on_disk = self.review.load_json_file(self.paths.IMPLEMENTATION_JSON)
        self.assertEqual(on_disk["repos"][0]["summary"], "fixed summary")

        bodies: list[str] = []
        review_data, out_impl = self._run(
            [[_crit_finding()], []],
            inbox_id="inbox-1",
            tree_versions=tree,
            impl_data=on_disk,
            run_id="r2",
            events=_recording_events(bodies),
        )
        self.assertEqual(self.fix_calls, [])
        self.assertEqual([c[0] for c in self.lens_calls], [2])
        second_artifact = self.review.load_json_file(self.paths.review_fix_iter_path(1))
        self.assertEqual(second_artifact["decisions"], first_artifact["decisions"])
        self.assertEqual(out_impl["repos"][0]["summary"], "fixed summary")
        self.assertEqual(review_data["final_verdict"], "approved")
        # Nothing re-ran in iteration 1 → its thoughts are not re-posted.
        self.assertFalse(any(b.startswith("Fix pass 1") for b in bodies))
        self.assertFalse(any(b.startswith("Review pass 1") for b in bodies))
        self.assertTrue(any(b.startswith("Review pass 2/") for b in bodies))

    def test_resume_keeps_baselines_when_a_repo_leaves_scope(self) -> None:
        """A cached fix pass naming a repo that no longer has changed files
        drops that repo but keeps the others' pre-fix baselines — recomputing
        them would read repo-a's landed fix as 'no change' and settle it."""
        impl, plan = self._two_repo_fixture()
        a_bug = _crit_finding(title="a bug", file="a.ts")
        b_bug = _crit_finding(title="b bug", file="b.ts")
        lens_outputs = {
            (1, "repo-a", "code-review"): {"findings": [a_bug], "summary": "a"},
            (1, "repo-b", "code-review"): {"findings": [b_bug], "summary": "b"},
        }
        tree: dict[str, int] = {}
        with self.assertRaises(_PodDeath):
            self._run(
                [],
                lens_outputs=lens_outputs,
                fix_scripts=[
                    {
                        "repo-a": {"summary": "A after fix"},
                        "repo-b": {DIE_AFTER: "repo-a"},
                    }
                ],
                inbox_id="inbox-1",
                plan_data=plan,
                impl_data=json.loads(json.dumps(impl)),
                tree_versions=tree,
            )
        shrunk = json.loads(json.dumps(impl))
        shrunk["repos"][1]["changed_files"] = []
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            review_data, out_impl = self._run(
                [],
                lens_outputs=lens_outputs,
                inbox_id="inbox-1",
                plan_data=plan,
                impl_data=shrunk,
                tree_versions=tree,
                run_id="r2",
            )
        self.assertIn("repo(s) ['repo-b'] no longer in scope", stdout.getvalue())
        self.assertEqual(self.fix_calls, [])
        decisions = {
            d["finding_id"]: d["decision"]
            for d in review_data["fix_iterations"][0]["decisions"]
        }
        self.assertEqual(decisions, {"iter1-f1": "fixed", "iter1-f2": "declined"})
        by_name = {r["name"]: r for r in out_impl["repos"]}
        self.assertEqual(by_name["repo-a"]["summary"], "A after fix")

    def test_resume_into_iteration_one_with_empty_scope_is_scope_lost(self) -> None:
        """A resumed iteration 1 has already reviewed; an empty scope there
        means a fix pass erased the change, not that there was nothing to
        review — never `no_scope` → approved."""
        with self.assertRaises(_PodDeath):
            self._run(
                [[_crit_finding()]],
                fix_scripts=[{"config-backend": {DIE_FIX: True}}],
                inbox_id="inbox-1",
            )
        impl = _impl_data()
        impl["repos"][0]["changed_files"] = []
        review_data, _impl = self._run([[]], inbox_id="inbox-1", impl_data=impl)
        self.assertEqual(review_data["termination_reason"], "scope_lost")
        self.assertNotEqual(review_data["final_verdict"], "approved")
        # The already-written review record stays part of the run and its
        # finding is what went unresolved.
        self.assertEqual(review_data["iterations_run"], 1)
        self.assertEqual(
            [f["disposition"] for f in review_data["unresolved_findings"]],
            ["fix_failed"],
        )
        self.assertTrue(self.paths.review_iter_path(1).exists())

    def test_checkpoint_write_failure_never_loses_a_fix_output(self) -> None:
        """review-state.json failing to write is bookkeeping: the loop runs to
        completion and a landed fix output is still honoured."""
        real_write_json = self.review.write_json

        def _flaky(path, data):
            if path == self.paths.REVIEW_STATE_JSON:
                raise OSError("No space left on device")
            real_write_json(path, data)

        stdout = io.StringIO()
        with (
            patch.object(self.review, "write_json", side_effect=_flaky),
            contextlib.redirect_stdout(stdout),
        ):
            review_data, out_impl = self._run(
                [[_crit_finding()], []],
                fix_scripts=[{"config-backend": {"summary": "fixed summary"}}],
                inbox_id="inbox-1",
            )
        self.assertIn("could not write review-state.json", stdout.getvalue())
        self.assertIn("could not checkpoint the fix output", stdout.getvalue())
        self.assertNotIn(
            "review-fix agent for config-backend failed", stdout.getvalue()
        )
        self.assertEqual(
            [d["decision"] for d in review_data["fix_iterations"][0]["decisions"]],
            ["fixed"],
        )
        self.assertEqual(out_impl["repos"][0]["summary"], "fixed summary")
        self.assertEqual(review_data["final_verdict"], "approved")

    def test_resume_rejects_malformed_checkpoint_blobs(self) -> None:
        """Shape errors the loader does not re-read from disk must still
        degrade to a fresh run rather than surface in validate_self_review."""
        os.environ["HARNESS_REVIEW_MAX_ITERATIONS"] = "3"
        with self.assertRaises(RuntimeError):
            self._run(
                [[_crit_finding()]],
                fix_scripts=[{"config-backend": {}}],
                lens_outputs={(2, "config-backend", "code-review"): RAISE_FIX},
                inbox_id="inbox-1",
            )
        good = self._state()
        self.assertEqual((good["iteration"], good["phase"]), (2, "reviewing"))
        for mutate in (
            lambda s: s.__setitem__("fix_iterations", [1]),
            lambda s: s.__setitem__("declined_context", ["x"]),
            lambda s: s.__setitem__("settled_declines", {"config-backend": "x"}),
        ):
            state = json.loads(json.dumps(good))
            mutate(state)
            self.paths.REVIEW_STATE_JSON.write_text(json.dumps(state), encoding="utf-8")
            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                review_data, _impl = self._run([[]], inbox_id="inbox-1")
            self.assertIn("warning: ignoring review-state.json", stdout.getvalue())
            self.assertEqual(review_data["iterations_run"], 1)
            # Re-seed for the next variant: the fresh run archived the files.
            self.paths.review_iter_path(1).with_name("review-iter-1.json.prev").replace(
                self.paths.review_iter_path(1)
            )
            self.paths.review_fix_iter_path(1).with_name(
                "review-fix-iter-1.json.prev"
            ).replace(self.paths.review_fix_iter_path(1))

    def test_resume_rejects_malformed_fix_checkpoint(self) -> None:
        with self.assertRaises(_PodDeath):
            self._run(
                [[_crit_finding()]],
                fix_scripts=[{"config-backend": {DIE_FIX: True}}],
                inbox_id="inbox-1",
            )
        state = self._state()
        state["fix"]["outputs"]["ghost"] = {"decisions": [], "summary": ""}
        self.paths.REVIEW_STATE_JSON.write_text(json.dumps(state), encoding="utf-8")
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            self._run([[]], inbox_id="inbox-1")
        self.assertIn("fix checkpoint malformed", stdout.getvalue())
        self.assertEqual([c[0] for c in self.lens_calls], [1])

    def test_review_findings_thought_posted_once_across_reviewed_resume(
        self,
    ) -> None:
        """Died after the findings thought but before the fix pass was
        dispatched (phase `reviewed` on disk): the resume must not re-post it."""
        real_write_json = self.review.write_json

        def _die_at_fix_dispatch(path, data):
            if path == self.paths.REVIEW_STATE_JSON and data["phase"] == "fixing":
                raise _PodDeath()
            real_write_json(path, data)

        bodies: list[str] = []
        tree: dict[str, int] = {}
        with (
            patch.object(self.review, "write_json", side_effect=_die_at_fix_dispatch),
            self.assertRaises(_PodDeath),
        ):
            self._run(
                [[_crit_finding()]],
                fix_scripts=[{"config-backend": {}}],
                inbox_id="inbox-1",
                tree_versions=tree,
                events=_recording_events(bodies),
            )
        self.assertEqual(self._state()["phase"], "reviewed")
        self._run(
            [[_crit_finding()], []],
            fix_scripts=[{"config-backend": {}}],
            inbox_id="inbox-1",
            tree_versions=tree,
            run_id="r2",
            events=_recording_events(bodies),
        )
        self.assertEqual(len(self.fix_calls), 1)
        self.assertEqual(sum(b.startswith("Review pass 1: ") for b in bodies), 1)
        self.assertEqual(sum(b.startswith("Fix pass 1: ") for b in bodies), 1)

    def test_fix_thought_posted_once_when_death_follows_last_output(self) -> None:
        """Died after the last fix output was checkpointed but before the
        pass was composed (thought never posted): the resume — with nothing
        left to dispatch — must still post it, exactly once."""
        real_write_json = self.review.write_json

        def _die_after_output(path, data):
            real_write_json(path, data)
            if (
                path == self.paths.REVIEW_STATE_JSON
                and data["phase"] == "fixing"
                and data["fix"]["outputs"]
            ):
                raise _PodDeath()

        bodies: list[str] = []
        tree: dict[str, int] = {}
        with (
            patch.object(self.review, "write_json", side_effect=_die_after_output),
            self.assertRaises(_PodDeath),
        ):
            self._run(
                [[_crit_finding()]],
                fix_scripts=[{"config-backend": {}}],
                inbox_id="inbox-1",
                tree_versions=tree,
                events=_recording_events(bodies),
            )
        state = self._state()
        self.assertEqual(list(state["fix"]["outputs"]), ["config-backend"])
        self.assertFalse(state["fix"]["thought_posted"])
        self._run(
            [[_crit_finding()], []],
            inbox_id="inbox-1",
            tree_versions=tree,
            run_id="r2",
            events=_recording_events(bodies),
        )
        self.assertEqual(self.fix_calls, [])
        self.assertEqual(sum(b.startswith("Fix pass 1: ") for b in bodies), 1)

    def test_failed_fix_checkpoint_write_forces_fresh_restart(self) -> None:
        """If the `fixing` checkpoint (the only home of the pre-fix baselines)
        cannot be written, the older `reviewed` checkpoint must not survive:
        resuming from it would take baselines over the agents' edits."""
        real_write_json = self.review.write_json

        def _fix_write_fails(path, data):
            if path == self.paths.REVIEW_STATE_JSON and data["phase"] == "fixing":
                raise OSError("No space left on device")
            real_write_json(path, data)

        with (
            patch.object(self.review, "write_json", side_effect=_fix_write_fails),
            self.assertRaises(_PodDeath),
        ):
            self._run(
                [[_crit_finding()]],
                fix_scripts=[{"config-backend": {DIE_FIX: True}}],
                inbox_id="inbox-1",
            )
        self.assertFalse(self.paths.REVIEW_STATE_JSON.exists())
        self._run([[]], inbox_id="inbox-1")
        self.assertEqual([c[0] for c in self.lens_calls], [1])

    def test_resumed_fix_agent_keeps_its_scratch_dir(self) -> None:
        """A resumed thread never receives a new brief, so its scratch dir
        is the same deterministic path on every attempt: it must survive the
        entry sweep (other assignments) and never be cleared by the resumed
        pass."""
        impl, plan = self._two_repo_fixture()
        self.paths.IMPLEMENTATION_JSON.write_text(json.dumps(impl), encoding="utf-8")
        a_bug = _crit_finding(title="a bug", file="a.ts")
        b_bug = _crit_finding(title="b bug", file="b.ts")
        lens_outputs = {
            (1, "repo-a", "code-review"): {"findings": [a_bug], "summary": "a"},
            (1, "repo-b", "code-review"): {"findings": [b_bug], "summary": "b"},
        }
        tree: dict[str, int] = {}
        with self.assertRaises(_PodDeath):
            self._run(
                [],
                lens_outputs=lens_outputs,
                fix_scripts=[
                    {"repo-a": {}, "repo-b": {DIE_AFTER: "repo-a"}},
                ],
                inbox_id="inbox-1",
                plan_data=plan,
                impl_data=json.loads(json.dumps(impl)),
                tree_versions=tree,
            )
        old_root = self.paths.REVIEW_SCRATCH_DIR / "inbox-1"
        marker = old_root / "iter-1" / "repo-b--fix" / "repro.sh"
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text("#!/bin/sh\n", encoding="utf-8")
        stale = self.paths.REVIEW_SCRATCH_DIR / "inbox-0"
        stale.mkdir(parents=True, exist_ok=True)
        seen: list[tuple[bool, bool]] = []
        real_write_json = self.review.write_json

        def _spy(path, data):
            if path == self.paths.REVIEW_STATE_JSON and data["phase"] == "fixing":
                seen.append((marker.exists(), stale.exists()))
            real_write_json(path, data)

        with patch.object(self.review, "write_json", side_effect=_spy):
            self._run(
                [],
                lens_outputs=lens_outputs,
                fix_scripts=[{"repo-b": {}}],
                inbox_id="inbox-1",
                plan_data=plan,
                impl_data=self.review.load_json_file(self.paths.IMPLEMENTATION_JSON),
                tree_versions=tree,
                run_id="r2",
            )
        self.assertIn(str(marker.parent), self.fix_calls[0][2])
        self.assertTrue(seen and all(kept for kept, _ in seen))
        self.assertFalse(any(stale_kept for _, stale_kept in seen))
        # The assignment's scratch root is swept once the stage completes.
        self.assertFalse(old_root.exists())

    def test_resume_rejects_fix_checkpoint_at_new_terminal_iteration(self) -> None:
        """A `fixing` checkpoint at iteration N cannot resume once N is the
        budget: the loop never runs a fix pass at the terminal iteration and
        would silently abandon the in-flight one."""
        os.environ["HARNESS_REVIEW_MAX_ITERATIONS"] = "3"
        with self.assertRaises(_PodDeath):
            self._run(
                [[_crit_finding()], [_crit_finding()]],
                fix_scripts=[
                    {"config-backend": {}},
                    {"config-backend": {DIE_FIX: True}},
                ],
                inbox_id="inbox-1",
            )
        self.assertEqual(
            (self._state()["iteration"], self._state()["phase"]), (2, "fixing")
        )
        os.environ["HARNESS_REVIEW_MAX_ITERATIONS"] = "2"
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            review_data, _impl = self._run([[]], inbox_id="inbox-1")
        self.assertIn("fix checkpoint at iteration 2 cannot resume", stdout.getvalue())
        self.assertEqual([c[0] for c in self.lens_calls], [1])
        self.assertEqual(review_data["iterations_run"], 1)

    def test_fix_agent_runner_resumes_prior_state(self) -> None:
        """Deterministic thread: prior state is an interrupted turn, resumed."""
        with patch.object(self.review._retry, "run_agent_with_retries") as runner:
            runner.return_value = MagicMock(
                model_dump=lambda mode: {"decisions": [], "summary": ""}
            )
            self.review._run_repo_fix_agent(
                model=None,
                repo_name="r",
                repo_path=self.ws,
                thread_id="review-fix:inbox-1:iter-1:r",
                knowledge_subpaths=(),
                brief="b",
                events=None,
            )
        self.assertTrue(runner.call_args.kwargs["resume_prior_state"])

    # ------------------------------------------------------------------
    # Mid-review-pass checkpoint / resume
    # ------------------------------------------------------------------

    def _die_mid_review_pass(self, tree: dict[str, int]) -> tuple[dict, dict]:
        """Attempt 1 on the two-repo fixture: repo-a's lens lands (output
        checkpointed), repo-b's dies mid-flight. Returns (impl, plan)."""
        impl, plan = self._two_repo_fixture()
        self.paths.IMPLEMENTATION_JSON.write_text(json.dumps(impl), encoding="utf-8")
        a_bug = _crit_finding(title="a bug", file="a.ts")
        with self.assertRaises(_PodDeath):
            self._run(
                [],
                lens_outputs={
                    (1, "repo-a", "code-review"): {"findings": [a_bug], "summary": "a"},
                    (1, "repo-b", "code-review"): {DIE_AFTER: "repo-a/code-review"},
                },
                inbox_id="inbox-1",
                plan_data=plan,
                impl_data=json.loads(json.dumps(impl)),
                tree_versions=tree,
            )
        return impl, plan

    def test_resume_mid_review_pass_reuses_landed_outputs_and_threads(self) -> None:
        """Died with repo-a's lens finished (output checkpointed) and repo-b's
        mid-flight → restart re-dispatches only repo-b, resuming the thread
        the dead attempt dispatched, and merges it with repo-a's cached
        output; iteration 1 is never re-reviewed."""
        tree: dict[str, int] = {}
        _impl, plan = self._die_mid_review_pass(tree)
        state = self._state()
        self.assertEqual((state["iteration"], state["phase"]), (1, "reviewing"))
        self.assertEqual(list(state["review"]["outputs"]), ["repo-a/code-review"])
        self.assertEqual(
            state["review"]["pairs"], ["repo-a/code-review", "repo-b/code-review"]
        )
        self.assertEqual(state["review"]["pre_review_fp"], "repo-a:0|repo-b:0")
        self.assertFalse(self.paths.review_iter_path(1).exists())
        # Fresh pass: both threads forgotten before the checkpoint existed.
        self.assertEqual(
            self.forget_phase,
            {
                "review:inbox-1:iter-1:repo-a:code-review": (None, None),
                "review:inbox-1:iter-1:repo-b:code-review": (None, None),
            },
        )

        b_bug = _crit_finding(title="b bug", file="b.ts")
        bodies: list[str] = []
        review_data, _impl = self._run(
            [],
            lens_outputs={
                (1, "repo-b", "code-review"): {"findings": [b_bug], "summary": "b"},
            },
            fix_scripts=[{"*": {}}],
            inbox_id="inbox-1",
            plan_data=plan,
            impl_data=self.review.load_json_file(self.paths.IMPLEMENTATION_JSON),
            tree_versions=tree,
            run_id="r2",
            events=_recording_events(bodies),
        )
        # Iteration 1: only repo-b ran, on the thread the dead attempt
        # dispatched — not forgotten, so the runner resumes it. Iteration 2:
        # both repos, forgotten first (the pass is new), then dispatched.
        self.assertEqual(
            sorted((c[0], c[3]) for c in self.lens_calls),
            [
                (1, "review:inbox-1:iter-1:repo-b:code-review"),
                (2, "review:inbox-1:iter-2:repo-a:code-review"),
                (2, "review:inbox-1:iter-2:repo-b:code-review"),
            ],
        )
        self.assertEqual(
            sorted(t for t in self.forgotten if t.startswith("review:")),
            [
                "review:inbox-1:iter-2:repo-a:code-review",
                "review:inbox-1:iter-2:repo-b:code-review",
            ],
        )
        # The cached output reached the merge agent through its brief — the
        # only channel a real merge agent has — not just the fake's shortcut.
        iter1_merge_brief = next(b for (it, b) in self.merge_calls if it == 1)
        self.assertIn('"title": "a bug"', iter1_merge_brief)
        self.assertIn('"title": "b bug"', iter1_merge_brief)
        # Both findings — repo-a's cached, repo-b's just returned — reached
        # the fix pass.
        decisions = {
            d["finding_id"]: d["decision"]
            for d in review_data["fix_iterations"][0]["decisions"]
        }
        self.assertEqual(decisions, {"iter1-f1": "fixed", "iter1-f2": "fixed"})
        self.assertEqual(sorted(c[0] for c in self.fix_calls), ["repo-a", "repo-b"])
        self.assertEqual(review_data["iterations_run"], 2)
        self.assertEqual(review_data["final_verdict"], "approved")
        # The dispatch thought was posted by the dead attempt; never again.
        self.assertFalse(any(b.startswith("Review pass 1/") for b in bodies))
        self.assertTrue(any(b.startswith("Review pass 2/") for b in bodies))
        self.assertFalse(self.paths.REVIEW_STATE_JSON.exists())

    def test_resume_mid_review_pass_judges_mutation_against_cached_baseline(
        self,
    ) -> None:
        """A reviewer that dirtied the tree before the crash is still caught:
        the resume compares against the baseline the dead attempt captured,
        not a fresh fingerprint over the already-dirtied tree."""
        impl, plan = self._two_repo_fixture()
        self.paths.IMPLEMENTATION_JSON.write_text(json.dumps(impl), encoding="utf-8")
        tree: dict[str, int] = {}
        with self.assertRaises(_PodDeath):
            self._run(
                [],
                lens_outputs={
                    (1, "repo-b", "code-review"): {DIE_AFTER: "repo-a/code-review"},
                },
                review_tree_mutations=[True],
                inbox_id="inbox-1",
                plan_data=plan,
                impl_data=json.loads(json.dumps(impl)),
                tree_versions=tree,
            )
        self.assertEqual(self._state()["review"]["pre_review_fp"], "repo-a:0|repo-b:0")
        self.assertEqual(tree, {"repo-a": 1, "repo-b": 1})  # dirtied, on the PVC

        review_data, out_impl = self._run(
            [],
            inbox_id="inbox-1",
            plan_data=plan,
            impl_data=self.review.load_json_file(self.paths.IMPLEMENTATION_JSON),
            tree_versions=tree,
            run_id="r2",
        )
        self.assertEqual([(c[0], c[1]) for c in self.lens_calls], [(1, "repo-b")])
        self.assertTrue(review_data["iterations"][0].get("working_tree_mutated"))
        self.assertIn(
            "modified the working tree in iteration(s) 1",
            out_impl["repos"][0]["pr_body"],
        )

    def test_resume_with_every_lens_output_cached_runs_only_merge(self) -> None:
        """Died after the last lens output was checkpointed but before the
        record was written: the resume dispatches no lens agent, merges the
        cached outputs, and the dispatch thought is posted exactly once."""
        real_write_json = self.review.write_json

        def _die_at_record(path, data):
            if path == self.paths.review_iter_path(1):
                raise _PodDeath()
            real_write_json(path, data)

        bodies: list[str] = []
        tree: dict[str, int] = {}
        with (
            patch.object(self.review, "write_json", side_effect=_die_at_record),
            self.assertRaises(_PodDeath),
        ):
            self._run(
                [[_crit_finding()]],
                inbox_id="inbox-1",
                tree_versions=tree,
                events=_recording_events(bodies),
            )
        state = self._state()
        self.assertEqual((state["iteration"], state["phase"]), (1, "reviewing"))
        self.assertEqual(
            list(state["review"]["outputs"]), ["config-backend/code-review"]
        )
        self.assertEqual(state["review"]["pairs"], ["config-backend/code-review"])
        self.assertEqual([c[0] for c in self.merge_calls], [1])

        review_data, _impl = self._run(
            [[_crit_finding()], []],
            fix_scripts=[{"config-backend": {}}],
            inbox_id="inbox-1",
            tree_versions=tree,
            run_id="r2",
            events=_recording_events(bodies),
        )
        self.assertEqual([c[0] for c in self.lens_calls], [2])
        # Iteration 1 merged the cached output; a clean iteration 2 skips merge.
        self.assertEqual([c[0] for c in self.merge_calls], [1])
        # The cached output — not a re-run — is what the fix pass triaged.
        self.assertEqual(
            [d["decision"] for d in review_data["fix_iterations"][0]["decisions"]],
            ["fixed"],
        )
        self.assertEqual(review_data["iterations_run"], 2)
        self.assertEqual(review_data["final_verdict"], "approved")
        self.assertEqual(sum(b.startswith("Review pass 1/") for b in bodies), 1)
        self.assertEqual(sum(b.startswith("Review pass 1: ") for b in bodies), 1)

    def test_failed_lens_is_redispatched_fresh_on_resume(self) -> None:
        """A lens whose worker failed outright had its thread forgotten after
        the pass was checkpointed; the pair that was merely mid-flight kept
        its thread. The resume dispatches both on their deterministic ids and
        forgets nothing — the failed one is fresh because it has no state."""
        plan = _plan_data()
        plan["repos"][0]["additional_review_lenses"] = ["bug-hunter"]
        tree: dict[str, int] = {}
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout), self.assertRaises(_PodDeath):
            self._run(
                [],
                lens_outputs={
                    (1, "config-backend", "code-review"): RAISE_FIX,
                    (1, "config-backend", "bug-hunter"): {
                        DIE_AFTER: "config-backend/code-review"
                    },
                },
                inbox_id="inbox-1",
                plan_data=plan,
                tree_versions=tree,
            )
        self.assertIn(
            "review lens config-backend/code-review failed", stdout.getvalue()
        )
        state = self._state()
        self.assertEqual((state["iteration"], state["phase"]), (1, "reviewing"))
        self.assertEqual(state["review"]["outputs"], {})
        self.assertEqual(
            state["review"]["pairs"],
            ["config-backend/bug-hunter", "config-backend/code-review"],
        )
        # Both forgotten before dispatch (no checkpoint on disk yet); the
        # failed one once more, on the failure path, after the checkpoint.
        self.assertEqual(
            self.forgotten,
            [
                "review:inbox-1:iter-1:config-backend:code-review",
                "review:inbox-1:iter-1:config-backend:bug-hunter",
                "review:inbox-1:iter-1:config-backend:code-review",
            ],
        )
        self.assertEqual(
            self.forget_phase["review:inbox-1:iter-1:config-backend:bug-hunter"],
            (None, None),
        )
        self.assertEqual(
            self.failed_forgets, ["review:inbox-1:iter-1:config-backend:code-review"]
        )

        review_data, _impl = self._run(
            [],
            inbox_id="inbox-1",
            plan_data=plan,
            tree_versions=tree,
            run_id="r2",
        )
        self.assertEqual(
            sorted(c[3] for c in self.lens_calls),
            [
                "review:inbox-1:iter-1:config-backend:bug-hunter",
                "review:inbox-1:iter-1:config-backend:code-review",
            ],
        )
        self.assertEqual(self.forgotten, [])
        # Every brief's scratch dir is the deterministic per-assignment path.
        scratch_by_lens = {
            lens: re.search(r"scratch dir[^`]*`([^`]+)`", brief).group(1)
            for (_i, _r, lens, _t, brief) in self.lens_calls
        }
        for lens, leaf in (
            ("bug-hunter", "config-backend--bug-hunter"),
            ("code-review", "config-backend--code-review"),
        ):
            self.assertEqual(
                Path(scratch_by_lens[lens]),
                (self.paths.REVIEW_SCRATCH_DIR / "inbox-1" / "iter-1" / leaf).resolve(),
            )
        self.assertEqual(review_data["iterations_run"], 1)
        self.assertEqual(review_data["final_verdict"], "approved")

    def test_resumed_lens_agent_keeps_its_scratch_dir(self) -> None:
        """A resumed thread never receives a new brief, so its scratch dir
        is the same deterministic path on every attempt: it must survive the
        entry sweep (other assignments) and never be cleared by the resumed
        pass."""
        tree: dict[str, int] = {}
        _impl, plan = self._die_mid_review_pass(tree)
        old_root = self.paths.REVIEW_SCRATCH_DIR / "inbox-1"
        marker = old_root / "iter-1" / "repo-b--code-review" / "repro.sh"
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text("#!/bin/sh\n", encoding="utf-8")
        stale = self.paths.REVIEW_SCRATCH_DIR / "inbox-0"
        stale.mkdir(parents=True, exist_ok=True)
        seen: list[tuple[bool, bool]] = []
        real_write_json = self.review.write_json

        def _spy(path, data):
            if path == self.paths.REVIEW_STATE_JSON and data["phase"] == "reviewing":
                seen.append((marker.exists(), stale.exists()))
            real_write_json(path, data)

        with patch.object(self.review, "write_json", side_effect=_spy):
            self._run(
                [],
                inbox_id="inbox-1",
                plan_data=plan,
                impl_data=self.review.load_json_file(self.paths.IMPLEMENTATION_JSON),
                tree_versions=tree,
                run_id="r2",
            )
        repo_b_brief = next(
            brief
            for (i, repo, _l, _t, brief) in self.lens_calls
            if i == 1 and repo == "repo-b"
        )
        self.assertIn(str(marker.parent), repo_b_brief)
        self.assertTrue(seen and all(kept for kept, _ in seen))
        self.assertFalse(any(stale_kept for _, stale_kept in seen))
        # The assignment's scratch root is swept once the stage completes.
        self.assertFalse(old_root.exists())

    def test_resume_drops_cached_lens_for_repo_out_of_scope(self) -> None:
        """A cached review pass naming a repo that no longer has changed
        files drops that repo's entry but keeps the others' cached output —
        nothing is re-reviewed for it."""
        tree: dict[str, int] = {}
        impl, plan = self._die_mid_review_pass(tree)
        shrunk = json.loads(json.dumps(impl))
        shrunk["repos"][1]["changed_files"] = []
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            review_data, _impl = self._run(
                [],
                fix_scripts=[{"*": {}}],
                inbox_id="inbox-1",
                plan_data=plan,
                impl_data=shrunk,
                tree_versions=tree,
                run_id="r2",
            )
        self.assertIn(
            "lens(es) ['repo-b/code-review'] no longer in scope", stdout.getvalue()
        )
        # Iteration 1 dispatched nothing (repo-a cached, repo-b dropped);
        # iteration 2 reviewed repo-a alone.
        self.assertEqual([(c[0], c[1]) for c in self.lens_calls], [(2, "repo-a")])
        decisions = {
            d["finding_id"]: d["decision"]
            for d in review_data["fix_iterations"][0]["decisions"]
        }
        self.assertEqual(decisions, {"iter1-f1": "fixed"})
        self.assertEqual(review_data["final_verdict"], "approved")

    def test_malformed_review_checkpoint_degrades_to_previous_done(self) -> None:
        """An unusable in-flight review blob at iteration N>1 resumes from
        the completed iteration N-1 (everything it needs already validated)
        rather than throwing away every finished iteration."""
        os.environ["HARNESS_REVIEW_MAX_ITERATIONS"] = "3"
        tree: dict[str, int] = {}
        with self.assertRaises(_PodDeath):
            self._run(
                [[_crit_finding()]],
                fix_scripts=[{"config-backend": {}}],
                lens_outputs={(2, "config-backend", "code-review"): DIE_FIX},
                inbox_id="inbox-1",
                tree_versions=tree,
            )
        state = self._state()
        self.assertEqual((state["iteration"], state["phase"]), (2, "reviewing"))
        state["review"]["outputs"]["ghost"] = "not an output"
        self.paths.REVIEW_STATE_JSON.write_text(json.dumps(state), encoding="utf-8")
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            review_data, _impl = self._run(
                [[_crit_finding()], []],
                inbox_id="inbox-1",
                impl_data=self.review.load_json_file(self.paths.IMPLEMENTATION_JSON),
                tree_versions=tree,
                run_id="r2",
            )
        self.assertIn("review checkpoint at iteration 2 is unusable", stdout.getvalue())
        self.assertNotIn("ignoring review-state.json", stdout.getvalue())
        self.assertEqual([c[0] for c in self.lens_calls], [2])
        # Iteration 2 is re-run as a new pass: the dead attempt's thread under
        # the same id is forgotten before dispatch, never resumed.
        self.assertEqual(
            self.forgotten, ["review:inbox-1:iter-2:config-backend:code-review"]
        )
        self.assertEqual(self.fix_calls, [])
        self.assertEqual(review_data["iterations_run"], 2)
        self.assertTrue(self.paths.review_iter_path(1).exists())
        self.assertTrue(self.paths.review_fix_iter_path(1).exists())
        self.assertFalse(
            self.paths
            .review_fix_iter_path(1)
            .with_name("review-fix-iter-1.json.prev")
            .exists()
        )

    def test_malformed_review_checkpoint_at_iteration_one_starts_fresh(self) -> None:
        """An unusable in-flight review blob at iteration 1 has no completed
        iteration to fall back to: the whole checkpoint is discarded."""
        with self.assertRaises(_PodDeath):
            self._run(
                [[]],
                lens_outputs={(1, "config-backend", "code-review"): DIE_FIX},
                inbox_id="inbox-1",
            )
        state = self._state()
        self.assertEqual((state["iteration"], state["phase"]), (1, "reviewing"))
        state["review"]["pairs"] = "not a list"
        self.paths.REVIEW_STATE_JSON.write_text(json.dumps(state), encoding="utf-8")
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            self._run([[]], inbox_id="inbox-1", run_id="r2")
        self.assertIn("warning: ignoring review-state.json", stdout.getvalue())
        self.assertIn("review checkpoint malformed", stdout.getvalue())
        # Fresh run: the dead attempt's thread is forgotten, then dispatched.
        self.assertEqual(
            self.forgotten, ["review:inbox-1:iter-1:config-backend:code-review"]
        )
        self.assertEqual(
            [c[3] for c in self.lens_calls],
            ["review:inbox-1:iter-1:config-backend:code-review"],
        )

    def test_lost_review_checkpoint_leaves_previous_done_checkpoint(self) -> None:
        """If the `reviewing` checkpoint cannot be written, the older `done`
        checkpoint stays: resuming from it re-runs the pass on a fresh
        baseline, which is safe (unlike a stale `reviewed` before a fix pass)."""
        os.environ["HARNESS_REVIEW_MAX_ITERATIONS"] = "3"
        real_write_json = self.review.write_json

        def _review_write_fails(path, data):
            if (
                path == self.paths.REVIEW_STATE_JSON
                and data["phase"] == "reviewing"
                and data["iteration"] == 2
            ):
                raise OSError("No space left on device")
            real_write_json(path, data)

        tree: dict[str, int] = {}
        stdout = io.StringIO()
        with (
            patch.object(self.review, "write_json", side_effect=_review_write_fails),
            contextlib.redirect_stdout(stdout),
            self.assertRaises(_PodDeath),
        ):
            self._run(
                [[_crit_finding()]],
                fix_scripts=[{"config-backend": {}}],
                lens_outputs={(2, "config-backend", "code-review"): DIE_FIX},
                inbox_id="inbox-1",
                tree_versions=tree,
            )
        self.assertIn(
            "could not write review-state.json at reviewing/2", stdout.getvalue()
        )
        state = self._state()
        self.assertEqual((state["iteration"], state["phase"]), (1, "done"))

        review_data, _impl = self._run(
            [[_crit_finding()], []],
            inbox_id="inbox-1",
            impl_data=self.review.load_json_file(self.paths.IMPLEMENTATION_JSON),
            tree_versions=tree,
            run_id="r2",
        )
        self.assertEqual([c[0] for c in self.lens_calls], [2])
        self.assertEqual(self.fix_calls, [])
        self.assertEqual(review_data["iterations_run"], 2)
        self.assertEqual(review_data["final_verdict"], "approved")

    def test_checkpoint_write_failure_never_loses_a_lens_output(self) -> None:
        """review-state.json failing to write while a lens output lands is
        bookkeeping: the pass completes and the output is merged."""
        real_write_json = self.review.write_json

        def _flaky(path, data):
            if (
                path == self.paths.REVIEW_STATE_JSON
                and data["phase"] == "reviewing"
                and data["review"]["outputs"]
            ):
                raise OSError("No space left on device")
            real_write_json(path, data)

        stdout = io.StringIO()
        with (
            patch.object(self.review, "write_json", side_effect=_flaky),
            contextlib.redirect_stdout(stdout),
        ):
            review_data, _impl = self._run(
                [[_crit_finding()], []],
                fix_scripts=[{"config-backend": {}}],
                inbox_id="inbox-1",
            )
        self.assertIn(
            "could not checkpoint the lens output for config-backend/code-review",
            stdout.getvalue(),
        )
        self.assertIn("re-enter its thread", stdout.getvalue())
        self.assertNotIn(
            "review lens config-backend/code-review failed", stdout.getvalue()
        )
        self.assertEqual(
            [d["decision"] for d in review_data["fix_iterations"][0]["decisions"]],
            ["fixed"],
        )
        self.assertEqual(review_data["final_verdict"], "approved")

    def test_resume_review_checkpoint_at_terminal_iteration(self) -> None:
        """A `reviewing` checkpoint at the budget's last iteration resumes: the
        terminal review pass runs (no fix pass follows it) and its findings
        are recorded as never attempted."""
        os.environ["HARNESS_REVIEW_MAX_ITERATIONS"] = "2"
        tree: dict[str, int] = {}
        with self.assertRaises(_PodDeath):
            self._run(
                [[_crit_finding()], [_crit_finding()]],
                fix_scripts=[{"config-backend": {}}],
                lens_outputs={(2, "config-backend", "code-review"): DIE_FIX},
                inbox_id="inbox-1",
                tree_versions=tree,
            )
        state = self._state()
        self.assertEqual((state["iteration"], state["phase"]), (2, "reviewing"))
        review_data, _impl = self._run(
            [[_crit_finding()], [_crit_finding()]],
            inbox_id="inbox-1",
            impl_data=self.review.load_json_file(self.paths.IMPLEMENTATION_JSON),
            tree_versions=tree,
            run_id="r2",
        )
        self.assertEqual(
            [c[3] for c in self.lens_calls],
            ["review:inbox-1:iter-2:config-backend:code-review"],
        )
        self.assertEqual(self.forgotten, [])  # resumed, not re-dispatched
        self.assertEqual(self.fix_calls, [])
        self.assertEqual(review_data["iterations_run"], 2)
        self.assertEqual(review_data["termination_reason"], "max_iterations")
        self.assertEqual(
            [f["disposition"] for f in review_data["unresolved_findings"]],
            ["not_attempted"],
        )

    def test_resume_after_record_written_archives_and_rewrites_it(self) -> None:
        """Died after review-iter-1.json was written but before the `reviewed`
        checkpoint: the resume archives the dead attempt's record as .prev and
        rewrites it from the cached outputs."""
        real_write_json = self.review.write_json

        def _die_at_reviewed(path, data):
            if path == self.paths.REVIEW_STATE_JSON and data["phase"] == "reviewed":
                raise _PodDeath()
            real_write_json(path, data)

        tree: dict[str, int] = {}
        with (
            patch.object(self.review, "write_json", side_effect=_die_at_reviewed),
            self.assertRaises(_PodDeath),
        ):
            self._run([[_crit_finding()]], inbox_id="inbox-1", tree_versions=tree)
        self.assertTrue(self.paths.review_iter_path(1).exists())
        self.assertEqual(self._state()["phase"], "reviewing")
        prev = self.paths.review_iter_path(1).with_name("review-iter-1.json.prev")
        self.assertFalse(prev.exists())

        review_data, _impl = self._run(
            [[_crit_finding()], []],
            fix_scripts=[{"config-backend": {}}],
            inbox_id="inbox-1",
            tree_versions=tree,
            run_id="r2",
        )
        self.assertEqual([c[0] for c in self.lens_calls], [2])
        self.assertTrue(prev.exists())
        self.assertTrue(self.paths.review_iter_path(1).exists())
        self.assertEqual(review_data["iterations_run"], 2)
        self.assertEqual(review_data["final_verdict"], "approved")

    def test_in_flight_lens_scratch_survives_an_unwinding_abort(self) -> None:
        """An abort that unwinds the stage (SIGTERM's SystemExit, a reaped
        worker) must not sweep the scratch dir of a thread the checkpoint
        still lists in flight: the next attempt resumes that thread without
        re-sending the brief, so the path it was given has to survive."""
        leaf = (
            self.paths.REVIEW_SCRATCH_DIR / "inbox-1" / "iter-1" / "repo-b--code-review"
        )
        tree: dict[str, int] = {}
        _impl, plan = self._die_mid_review_pass(tree)
        state = self._state()
        self.assertEqual(
            state["review"]["pairs"], ["repo-a/code-review", "repo-b/code-review"]
        )
        self.assertEqual(list(state["review"]["outputs"]), ["repo-a/code-review"])
        # Created at dispatch, still there after the abort.
        self.assertTrue(leaf.is_dir())

        self._run(
            [],
            inbox_id="inbox-1",
            plan_data=plan,
            impl_data=self.review.load_json_file(self.paths.IMPLEMENTATION_JSON),
            tree_versions=tree,
            run_id="r2",
        )
        # Swept once the stage completed.
        self.assertFalse((self.paths.REVIEW_SCRATCH_DIR / "inbox-1").exists())

    def test_lens_agent_runner_resumes_prior_state(self) -> None:
        """Deterministic thread: prior state is an interrupted turn, resumed."""
        with patch.object(self.review._retry, "run_agent_with_retries") as runner:
            runner.return_value = MagicMock(
                model_dump=lambda mode: {"findings": [], "summary": ""}
            )
            self.review._run_lens_agent(
                model=None,
                repo_name="r",
                repo_path=self.ws,
                lens="code-review",
                thread_id="review:inbox-1:iter-1:r:code-review",
                knowledge_subpaths=(),
                brief="b",
                events=None,
            )
        self.assertTrue(runner.call_args.kwargs["resume_prior_state"])

    def _assert_stage_agent_wired(self, agent_name: str, call_stage: Any) -> None:
        """Run ``call_stage(events)`` and check the built agent got the client."""
        import harness.deepagents.agents.review as review_agents
        from tests.progress_support import assert_agent_wired, round_events

        def _build_and_return(build_agent: Any, *_a: Any, **_k: Any) -> Any:
            build_agent()
            return MagicMock(model_dump=lambda mode: {})

        with (
            patch.object(review_agents, agent_name) as agent_cls,
            patch.object(
                self.review._retry,
                "run_agent_with_retries",
                side_effect=_build_and_return,
            ),
            round_events() as events,
        ):
            call_stage(events)
            assert_agent_wired(self, agent_cls, events)

    def test_lens_agent_receives_round_events_client(self) -> None:
        self._assert_stage_agent_wired(
            "ReviewLensAgent",
            lambda events: self.review._run_lens_agent(
                model=None,
                repo_name="r",
                repo_path=self.ws,
                lens="code-review",
                thread_id="review:inbox-1:iter-1:r:code-review",
                knowledge_subpaths=(),
                brief="b",
                events=events,
            ),
        )

    def test_fix_agent_receives_round_events_client(self) -> None:
        self._assert_stage_agent_wired(
            "ReviewFixAgent",
            lambda events: self.review._run_repo_fix_agent(
                model=None,
                repo_name="r",
                repo_path=self.ws,
                thread_id="review-fix:inbox-1:iter-1:r",
                knowledge_subpaths=(),
                brief="b",
                events=events,
            ),
        )

    def test_merge_agent_receives_round_events_client(self) -> None:
        self._assert_stage_agent_wired(
            "MergeFindingsAgent",
            lambda events: self.review._run_merge_agent(
                model=None,
                run_id="r1",
                iteration=1,
                brief="b",
                events=events,
            ),
        )

    def test_scratch_scope_is_one_safe_path_component(self) -> None:
        """The scope is swept with rmtree, so no inbox id may escape the
        scratch root or name it."""
        self.assertEqual(self.review._scratch_scope("inbox-1"), "inbox-1")
        self.assertEqual(self.review._scratch_scope("in/box:..1"), "in-box---1")
        self.assertEqual(self.review._scratch_scope(".."), "--")
        self.assertEqual(self.review._scratch_scope(""), "inbox")
        self._run([[]], inbox_id="in/box:..1")
        _i, _r, _l, thread_id, brief = self.lens_calls[0]
        self.assertEqual(
            thread_id, "review:in/box:..1:iter-1:config-backend:code-review"
        )
        scratch = Path(re.search(r"scratch dir[^`]*`([^`]+)`", brief).group(1))
        self.assertEqual(
            scratch,
            (
                self.paths.REVIEW_SCRATCH_DIR
                / "in-box---1"
                / "iter-1"
                / "config-backend--code-review"
            ).resolve(),
        )

    def test_fresh_pass_forgets_every_thread_before_its_checkpoint(self) -> None:
        """Every pass dispatched anew forgets each agent's thread first — so a
        superseded attempt's thread under the same id can never be resumed —
        and does so BEFORE writing the checkpoint that would tell a restart
        to resume this pass."""
        self._run([[_crit_finding()], []], fix_scripts=[{"config-backend": {}}])
        self.assertEqual(
            self.forgotten,
            [
                "review:inbox-1:iter-1:config-backend:code-review",
                "review-fix:inbox-1:iter-1:config-backend",
                "review:inbox-1:iter-2:config-backend:code-review",
            ],
        )
        self.assertEqual(
            self.forget_phase,
            {
                "review:inbox-1:iter-1:config-backend:code-review": (None, None),
                "review-fix:inbox-1:iter-1:config-backend": ("reviewed", 1),
                "review:inbox-1:iter-2:config-backend:code-review": ("done", 1),
            },
        )

    def test_failed_fix_worker_forgets_its_thread(self) -> None:
        """A fix worker that failed outright has its thread forgotten after
        the fix checkpoint, so a restart re-briefs rather than resuming it."""
        self._run(
            [[_crit_finding()], []],
            fix_scripts=[{"config-backend": {RAISE_FIX: True}}],
        )
        self.assertEqual(
            self.failed_forgets, ["review-fix:inbox-1:iter-1:config-backend"]
        )
        self.assertEqual(
            self.forget_phase["review-fix:inbox-1:iter-1:config-backend"], ("fixing", 1)
        )

    def test_forget_thread_deletes_the_checkpointer_thread(self) -> None:
        """The one production call the "fresh = forget" design rests on."""
        from harness.deepagents import checkpointer

        saver = MagicMock()
        with patch.object(checkpointer, "get_checkpointer", return_value=saver):
            self.review._forget_thread("review:inbox-1:iter-1:r:code-review")
        saver.delete_thread.assert_called_once_with(
            "review:inbox-1:iter-1:r:code-review"
        )

    def test_fresh_pass_clears_a_stale_scratch_leaf(self) -> None:
        """Forgetting an agent also clears its scratch dir, so a fresh agent
        never finds a superseded attempt's repro scripts in it."""
        stale = (
            self.paths.REVIEW_SCRATCH_DIR
            / "inbox-1"
            / "iter-1"
            / "config-backend--code-review"
            / "repro.sh"
        )
        stale.parent.mkdir(parents=True)
        stale.write_text("echo", encoding="utf-8")
        seen: list[bool] = []
        real_write_json = self.review.write_json

        def _spy(path, data):
            if path == self.paths.REVIEW_STATE_JSON and data["phase"] == "reviewing":
                seen.append(stale.exists())
            real_write_json(path, data)

        with patch.object(self.review, "write_json", side_effect=_spy):
            self._run([[]])
        self.assertTrue(seen)
        self.assertFalse(any(seen))

    def test_fix_pre_dispatch_forget_failure_fails_the_stage(self) -> None:
        """The fix pass's pre-dispatch forget propagates like the lens pass's:
        the older `reviewed` checkpoint stays, no fix agent runs."""
        with self.assertRaises(RuntimeError):
            self._run(
                [[_crit_finding()], []],
                fix_scripts=[{"config-backend": {}}],
                forget_raises_when=lambda t, _s: t.startswith("review-fix:"),
            )
        self.assertEqual(self.fix_calls, [])
        self.assertEqual(
            (self._state()["iteration"], self._state()["phase"]), (1, "reviewed")
        )

    def test_pre_dispatch_forget_failure_fails_the_stage(self) -> None:
        """A forget that fails before dispatch propagates: the checkpoint
        must not reach disk claiming a pass whose stale threads survive."""
        with self.assertRaises(RuntimeError):
            self._run([[]], forget_raises_when=lambda _t, _s: True)
        self.assertEqual(self.lens_calls, [])
        self.assertFalse(self.paths.REVIEW_STATE_JSON.exists())

    def test_failure_path_forget_failure_degrades(self) -> None:
        """A forget that fails after a worker failed is a warning, not a
        pass failure: the degraded lens stays degraded."""
        plan = _plan_data()
        plan["repos"][0]["additional_review_lenses"] = ["bug-hunter"]
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            review_data, _impl = self._run(
                [],
                lens_outputs={(1, "config-backend", "code-review"): RAISE_FIX},
                plan_data=plan,
                forget_raises_when=lambda _t, s: s.get("phase") == "reviewing",
            )
        self.assertIn(
            "could not forget the failed thread for config-backend/code-review",
            stdout.getvalue(),
        )
        self.assertIn("a restart would resume it", stdout.getvalue())
        self.assertEqual(review_data["final_verdict"], "approved")
        self.assertEqual(
            self.forgotten,
            [
                "review:inbox-1:iter-1:config-backend:code-review",
                "review:inbox-1:iter-1:config-backend:bug-hunter",
            ],
        )

    # ------------------------------------------------------------------
    # Generic resume guards
    # ------------------------------------------------------------------

    def test_resume_ignores_checkpoint_from_another_inbox(self) -> None:
        with self.assertRaises(_PodDeath):
            self._run(
                [[_crit_finding()]],
                fix_scripts=[{"config-backend": {DIE_FIX: True}}],
                inbox_id="inbox-old",
            )
        self.assertTrue(self.paths.review_iter_path(1).exists())

        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            self._run([[]], inbox_id="inbox-new")
        self.assertIn(
            "ignoring review-state.json with inbox_id 'inbox-old'", stdout.getvalue()
        )
        self.assertEqual([c[0] for c in self.lens_calls], [1])
        self.assertTrue(
            self.paths.review_iter_path(1).with_name("review-iter-1.json.prev").exists()
        )

    def test_resume_falls_back_to_fresh_when_artifacts_are_missing(self) -> None:
        """A checkpoint whose referenced artifacts are gone (or corrupt) is
        ignored with a warning — a restart must never fail on bookkeeping."""
        with self.assertRaises(_PodDeath):
            self._run(
                [[_crit_finding()]],
                fix_scripts=[{"config-backend": {DIE_FIX: True}}],
                inbox_id="inbox-1",
            )
        self.paths.review_iter_path(1).unlink()

        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            review_data, _impl = self._run([[]], inbox_id="inbox-1")
        self.assertIn("warning: ignoring review-state.json", stdout.getvalue())
        self.assertEqual([c[0] for c in self.lens_calls], [1])
        self.assertEqual(review_data["iterations_run"], 1)

    def test_resume_falls_back_when_budget_no_longer_allows_it(self) -> None:
        """Iteration 1 done, but the budget is now 1 → nothing to resume into."""
        os.environ["HARNESS_REVIEW_MAX_ITERATIONS"] = "3"
        with self.assertRaises(RuntimeError):
            self._run(
                [[_crit_finding()]],
                fix_scripts=[{"config-backend": {}}],
                lens_outputs={(2, "config-backend", "code-review"): RAISE_FIX},
                inbox_id="inbox-1",
            )
        self.assertEqual(self._state()["phase"], "reviewing")
        os.environ["HARNESS_REVIEW_MAX_ITERATIONS"] = "1"
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            review_data, _impl = self._run([[]], inbox_id="inbox-1")
        self.assertIn("exceeds HARNESS_REVIEW_MAX_ITERATIONS=1", stdout.getvalue())
        self.assertEqual(review_data["iterations_run"], 1)

    def test_stale_iteration_artifacts_kept_as_prev_at_entry(self) -> None:
        self.paths.review_iter_path(7).write_text("{}", encoding="utf-8")
        self.paths.review_fix_iter_path(7).write_text("{}", encoding="utf-8")
        self._run([[]])
        self.assertFalse(self.paths.review_iter_path(7).exists())
        self.assertFalse(self.paths.review_fix_iter_path(7).exists())
        self.assertTrue(
            self.paths.review_iter_path(7).with_name("review-iter-7.json.prev").exists()
        )

    def test_disabled_review_strips_stale_annotation(self) -> None:
        os.environ["HARNESS_REVIEW_ENABLED"] = "false"
        impl = _impl_data()
        impl["repos"][0]["pr_body"] = (
            "## Summary\n- thing\n\n<!-- harness:auto-review:start -->\n"
            "## ⚠️ Auto-review unresolved\n\n- **critical**: boom\n"
            "<!-- harness:auto-review:end -->\n"
        )
        with patch.object(self.review, "_review_model") as mock_model:
            _review_data, out = self.review.run_self_review_loop(
                run_id="r1",
                task="t",
                task_key="ABC-1",
                plan_data=_plan_data(),
                impl_data=impl,
                inbox_id="inbox-1",
                events=None,
            )
        mock_model.assert_not_called()
        self.assertNotIn("Auto-review unresolved", out["repos"][0]["pr_body"])
        self.assertIn("- thing", out["repos"][0]["pr_body"])

    # ------------------------------------------------------------------
    # Merge / rank / cap
    # ------------------------------------------------------------------

    def test_harness_does_not_dedupe_across_lenses(self) -> None:
        """Dedupe is the merge agent's call. Whatever it returns (here the
        fake passes lens findings through unmerged) reaches the artifact
        ranked strongest-first and intact — the harness never folds two
        findings together on position or title."""
        strong = _crit_finding(title="Race in worker", line_start=10, line_end=20)
        echo = _crit_finding(
            title="race in worker",
            severity="high",
            confidence=0.6,
            line_start=15,
            line_end=25,
        )
        other = _crit_finding(
            title="Null dereference on empty result",
            severity="high",
            confidence=0.8,
            line_start=10,
            line_end=20,
        )
        plan = _plan_data()
        plan["repos"][0]["additional_review_lenses"] = ["bug-hunter", "bird-eye"]
        review_data, _impl = self._run(
            [],
            plan_data=plan,
            lens_outputs={
                (1, "config-backend", "code-review"): {
                    "findings": [strong],
                    "summary": "found race",
                },
                (1, "config-backend", "bug-hunter"): {
                    "findings": [echo],
                    "summary": "found race too",
                },
                (1, "config-backend", "bird-eye"): {
                    "findings": [other],
                    "summary": "found null deref on the same lines",
                },
            },
            fix_scripts=[{"config-backend": {"tree_change": False}}],
        )
        findings = review_data["iterations"][0]["findings"]
        self.assertEqual(
            [(f["title"], f["lenses"]) for f in findings],
            [
                ("Race in worker", ["code-review"]),
                ("Null dereference on empty result", ["bird-eye"]),
                ("race in worker", ["bug-hunter"]),
            ],
        )
        self.assertTrue(all("corroborated" not in f["body"] for f in findings))

    def test_findings_capped_per_repo(self) -> None:
        many = [
            _medium_finding(
                title=f"finding {k}",
                confidence=0.5 + k / 100.0,
                file=f"src/f{k}.ts",
                line_start=k,
            )
            for k in range(1, 11)
        ]
        review_data, _impl = self._run(
            [many],
            fix_scripts=[{"config-backend": {"tree_change": False}}],
        )
        findings = review_data["iterations"][0]["findings"]
        self.assertEqual(len(findings), 8)
        self.assertEqual(review_data["iterations"][0]["findings_truncated"], 2)
        self.assertIn(
            "dropped by per-repo cap", review_data["iterations"][0]["summary"]
        )
        # Strongest kept: highest-confidence titles survive the cap.
        titles = {f["title"] for f in findings}
        self.assertIn("finding 10", titles)
        self.assertNotIn("finding 1", titles)

    def test_multi_repo_per_repo_tree_override(self) -> None:
        """Repo A's fix lands (tree changed); repo B claims 'fixed' with no
        tree change → B's decisions are overridden to declined, the loop
        continues (global tree changed), and B's findings feed the next
        iteration's declined context."""
        impl = _impl_data(
            repos=[
                {
                    "name": "repo-a",
                    "path": "/workspace/repo-a",
                    "changed_files": ["a.ts"],
                    "summary": "a",
                    "commit_message": "m",
                    "pr_title": "t",
                    "pr_body": "b",
                },
                {
                    "name": "repo-b",
                    "path": "/workspace/repo-b",
                    "changed_files": ["b.ts"],
                    "summary": "b",
                    "commit_message": "m",
                    "pr_title": "t",
                    "pr_body": "b",
                },
            ]
        )
        plan = _plan_data(
            repos=[
                {
                    "name": "repo-a",
                    "path": "/workspace/repo-a",
                    "goal": "g",
                    "planned_files_or_areas": [],
                    "implementation_steps": [],
                    "validation_steps": [],
                    "risks": [],
                },
                {
                    "name": "repo-b",
                    "path": "/workspace/repo-b",
                    "goal": "g",
                    "planned_files_or_areas": [],
                    "implementation_steps": [],
                    "validation_steps": [],
                    "risks": [],
                },
            ]
        )
        finding_a = _crit_finding(title="a bug", file="a.ts")
        finding_b = _crit_finding(title="b bug", file="b.ts")
        review_data, _impl = self._run(
            [],
            lens_outputs={
                (1, "repo-a", "code-review"): {
                    "findings": [finding_a],
                    "summary": "a",
                },
                (1, "repo-b", "code-review"): {
                    "findings": [finding_b],
                    "summary": "b",
                },
                (2, "repo-a", "code-review"): {"findings": [], "summary": "clean"},
                (2, "repo-b", "code-review"): {"findings": [], "summary": "clean"},
            },
            fix_scripts=[
                {
                    "repo-a": {"tree_change": True},
                    "repo-b": {"tree_change": False},
                }
            ],
            impl_data=impl,
            plan_data=plan,
        )
        self.assertEqual(review_data["final_verdict"], "approved")
        self.assertEqual(review_data["iterations_run"], 2)
        decisions = {
            d["finding_id"]: d for d in review_data["fix_iterations"][0]["decisions"]
        }
        # Finding ids are stamped across the merged (repo-sorted) list:
        # repo-a's finding first, then repo-b's.
        self.assertEqual(decisions["iter1-f1"]["decision"], "fixed")
        self.assertEqual(decisions["iter1-f2"]["decision"], "declined")
        self.assertIn("no working-tree change", decisions["iter1-f2"]["reason"])
        # Iteration 2 briefs carry repo-b's declined finding only for repo-b.
        iter2_b_briefs = [
            b for (i, r, _l, _t, b) in self.lens_calls if i == 2 and r == "repo-b"
        ]
        self.assertTrue(iter2_b_briefs)
        self.assertIn("Previously declined findings", iter2_b_briefs[0])
        iter2_a_briefs = [
            b for (i, r, _l, _t, b) in self.lens_calls if i == 2 and r == "repo-a"
        ]
        self.assertNotIn("Previously declined findings", iter2_a_briefs[0])


class TestLensSelectionUnit(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.ws = Path(self._tmp.name)
        (self.ws / ".harness").mkdir(parents=True)
        self.paths, _util, self.review = _load_with_workspace(self.ws)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_no_plan_repo_gives_base_lens_only(self) -> None:
        self.assertEqual(self.review.lens_set_for_repo(None), ["code-review"])
        self.assertEqual(self.review.lens_set_for_repo({}), ["code-review"])

    def test_optional_lenses_follow_canonical_order(self) -> None:
        lenses = self.review.lens_set_for_repo({
            "additional_review_lenses": [
                "code-quality",
                "security",
                "bird-eye",
                "bug-hunter",
            ]
        })
        self.assertEqual(
            lenses,
            ["code-review", "bug-hunter", "bird-eye", "security", "code-quality"],
        )

    def test_rank_and_cap_orders_strongest_first_without_folding(self) -> None:
        """Ranking is severity then confidence; nothing is merged, even
        same-file findings with matching titles — that call belongs to the
        merge agent, not a harness heuristic."""
        a = {
            "file": "src/x.ts",
            "title": "Race in cache init",
            "severity": "medium",
            "confidence": 0.7,
            "body": "A",
            "recommendation": "RA",
            "lenses": ["code-review"],
        }
        b = {
            "file": "src/x.ts",
            "title": "Missing null check",
            "severity": "high",
            "confidence": 0.6,
            "body": "B",
            "recommendation": "RB",
            "lenses": ["bug-hunter"],
        }
        same = {
            "file": "src/x.ts",
            "title": "race in cache init",
            "severity": "low",
            "confidence": 0.5,
            "body": "C",
            "recommendation": "RC",
            "lenses": ["bird-eye"],
        }
        kept, dropped = self.review._rank_and_cap([a, b, same])
        self.assertEqual(dropped, 0)
        self.assertEqual(
            [k["title"] for k in kept],
            ["Missing null check", "Race in cache init", "race in cache init"],
        )
        self.assertTrue(all("corroborated" not in k["body"] for k in kept))
        kept, dropped = self.review._rank_and_cap([a, b, same], cap=2)
        self.assertEqual(dropped, 1)
        self.assertEqual(
            [k["title"] for k in kept], ["Missing null check", "Race in cache init"]
        )

    def test_repair_valid_decision_survives_invalid_duplicate(self) -> None:
        """An invalid entry must not poison the duplicate check for a later
        well-formed decision on the same id."""
        decisions = [
            {"finding_id": "iter1-f1", "decision": "maybe", "reason": "x"},
            {
                "finding_id": "iter1-f1",
                "decision": "declined",
                "reason": "real rationale",
            },
        ]
        out, repaired = self.review._repair_repo_decisions(
            decisions, ["iter1-f1"], tree_changed=False
        )
        self.assertTrue(repaired)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["decision"], "declined")
        self.assertEqual(out[0]["reason"], "real rationale")

    def test_nonpositive_line_start_is_not_grounding(self) -> None:
        f = self.review._normalize_finding(
            {
                "severity": "critical",
                "confidence": 0.9,
                "title": "t",
                "body": "b",
                "recommendation": "r",
                "file": "f",
                "line_start": 0,
            },
            repo_name="r",
            lenses=["code-review"],
        )
        self.assertEqual(f["severity"], "medium")

    def test_strip_unresolved_section_keeps_following_headings(self) -> None:
        body = (
            "## Summary\nS\n\n## ⚠️ Auto-review unresolved\n\n- x\n\n## Test plan\nT\n"
        )
        out = self.review._strip_unresolved_section(body)
        self.assertEqual(out, "## Summary\nS\n\n## Test plan\nT\n")
        self.assertEqual(
            self.review._strip_unresolved_section("no section"), "no section"
        )

    def test_repo_root_rejects_unnamed_entry(self) -> None:
        with self.assertRaises(TypeError):
            self.review._repo_root({"path": "/x"})

    def test_worker_retries_are_hard_capped(self) -> None:
        """A durable thread reports checkpoint 'progress' on every failed
        attempt (input is checkpointed before the model runs); the hard cap
        must still end the loop."""
        import httpx

        calls = {"n": 0}

        class _Agent:
            def __init__(self):
                calls["n"] += 1
                self._marker = calls["n"]  # always "progress"

            @property
            def progress_marker(self):
                return self._marker

            @property
            def has_prior_state(self):
                return calls["n"] > 1

            def repair_dangling_tool_calls(self):
                pass

            def run(self, brief):
                self._marker += 1
                raise httpx.ConnectError("down")

            def resume_from_restart(self):
                self._marker += 1
                raise httpx.ConnectError("down")

            def close(self):
                pass

        with (
            patch.object(
                self.review._retry, "default_agent_max_retries", return_value=2
            ),
            patch.object(self.review._retry, "retry_sleep_seconds", return_value=0.0),
            self.assertRaises(httpx.ConnectError),
        ):
            self.review._retry.run_agent_with_retries(
                _Agent, "brief", label="t", resume_prior_state=False
            )
        self.assertEqual(calls["n"], 2 * 3 + 1)

    def test_fix_agent_is_review_fix_preset(self) -> None:
        """The fix pass builds a ``ReviewFixAgent``: review-fix persona and
        output contract, memory middleware with the default instructions."""
        import harness.deepagents.middleware.repo as repo_mw_module
        from harness.deepagents.agents.implementation import (
            IMPLEMENTATION_SYSTEM_PROMPT,
        )
        from harness.deepagents.agents.review import ReviewFixAgent
        from harness.deepagents.middleware.memory_writing import (
            MEMORY_INSTRUCTIONS,
            MemoryWritingMiddleware,
            RepoScope,
        )
        from harness.deepagents.session import DeepAgentSession

        captured = {}

        def _fake_build(**kwargs):
            captured.update(kwargs)
            return MemoryWritingMiddleware(**kwargs)

        with (
            patch.object(
                repo_mw_module,
                "MemoryWritingMiddleware",
                side_effect=_fake_build,
            ),
            patch.object(
                repo_mw_module, "build_knowledge_middleware", return_value=None
            ),
            patch.object(repo_mw_module, "build_skills_middleware", return_value=None),
            patch.object(
                DeepAgentSession, "__init__", return_value=None
            ) as session_init,
            patch.object(self.review._retry, "run_agent_with_retries") as runner,
        ):
            runner.return_value = MagicMock(
                model_dump=lambda mode: {"decisions": [], "summary": ""}
            )
            self.review._run_repo_fix_agent(
                model=None,
                repo_name="r",
                repo_path=self.ws,
                thread_id="review-fix:inbox-1:iter-1:r",
                knowledge_subpaths=(),
                brief="b",
                events=None,
            )
            # Force construction of the agent the runner was handed.
            build_agent = runner.call_args.args[0]
            agent = build_agent()
        self.assertIsInstance(agent, ReviewFixAgent)
        (memory_mw,) = session_init.call_args.kwargs["middleware"]
        self.assertEqual(memory_mw.system_prompt, MEMORY_INSTRUCTIONS)
        self.assertEqual(captured["stage"], "review-fix")
        self.assertEqual(captured["repos"], [RepoScope("r", ())])
        kwargs = session_init.call_args.kwargs
        self.assertEqual(kwargs["thread_id"], "review-fix:inbox-1:iter-1:r")
        self.assertEqual(kwargs["emit_identifier"], "r/review-fix")
        self.assertIn("review-fix agent", kwargs["system_prompt"])
        self.assertNotEqual(kwargs["system_prompt"], IMPLEMENTATION_SYSTEM_PROMPT)
        self.assertIs(kwargs["response_format"].schema, RepoReviewFixOutput)
        # Own thread per (assignment, iteration, repo), never the impl thread;
        # an interrupted turn on it is resumed, as implementation's are.
        self.assertTrue(runner.call_args.kwargs["resume_prior_state"])

    def test_lens_agent_has_no_memory_tool(self) -> None:
        """Read-only stage: no memory-writing middleware."""
        import harness.deepagents.middleware.repo as repo_mw_module
        from harness.deepagents.agents.review import ReviewLensAgent
        from harness.deepagents.session import DeepAgentSession

        with (
            patch.object(repo_mw_module, "MemoryWritingMiddleware") as mem,
            patch.object(
                repo_mw_module, "build_knowledge_middleware", return_value=None
            ),
            patch.object(repo_mw_module, "build_skills_middleware", return_value=None),
            patch.object(DeepAgentSession, "__init__", return_value=None) as init,
        ):
            ReviewLensAgent(
                model=None,
                repo_path=self.ws,
                thread_id="review:r1:iter-1:r:code-review",
                lens="code-review",
                repo="r",
                events=None,
            )
        mem.assert_not_called()
        kwargs = init.call_args.kwargs
        self.assertEqual(kwargs["emit_identifier"], "r/code-review")
        self.assertIs(kwargs["response_format"].schema, ReviewLensOutput)

    def test_unexpected_prior_state_is_repaired_then_briefed(self) -> None:
        """resume_prior_state=False + prior state on the first attempt: repair
        the dangling tail, then send the brief — never resume."""
        agent = MagicMock()
        agent.progress_marker = None
        agent.has_prior_state = True
        agent.run.return_value = "out"
        result = self.review._retry.run_agent_with_retries(
            lambda: agent, "brief", label="t", resume_prior_state=False
        )
        self.assertEqual(result, "out")
        agent.repair_dangling_tool_calls.assert_called_once()
        agent.resume_from_restart.assert_not_called()
        agent.run.assert_called_once_with("brief")
        agent.close.assert_called_once()

    def test_pr_body_bullets_neutralize_comment_framing(self) -> None:
        """Agent text carrying `<!--`, `-->`, or a block marker must not hide
        later bullets on GitHub or break the next strip; `file` is collapsed
        to one line too."""
        findings = [
            {
                "repo": "r",
                "severity": "critical",
                "title": "SQLi <!-- hidden",
                "file": "a.py\n\n## forged\n`x",
                "line_start": 3,
                "decline_reason": "nope <!-- harness:auto-review:end -->",
            },
            # `--!>` is a non-conforming but browser-honoured comment closer.
            {"repo": "r", "severity": "low", "title": "second --!> tail"},
        ]
        impl = {"repos": [{"name": "r", "pr_body": "## Summary\n\nDoes a thing."}]}
        once = self.review._annotate_pr_bodies(impl, findings, [])
        body = once["repos"][0]["pr_body"]
        self.assertEqual(body.count("<!--"), 2)  # only the harness markers
        self.assertEqual(body.count("-->"), 2)
        self.assertNotIn("--!>", body)
        self.assertNotIn("\n## forged", body)
        self.assertIn("second", body)
        # A resolved re-run strips cleanly back to the original body.
        clean = self.review._annotate_pr_bodies(once, [], [])
        self.assertEqual(
            clean["repos"][0]["pr_body"].rstrip(), "## Summary\n\nDoes a thing."
        )

    def test_close_unterminated_markdown_counts_bang_closer(self) -> None:
        """`--!>` closes an HTML comment too; a body ending in one is already
        terminated and must not get a spurious `-->` appended."""
        close = self.review._close_unterminated_markdown
        self.assertEqual(
            close("## Summary\n<!-- note --!>"), "## Summary\n<!-- note --!>"
        )
        self.assertEqual(close("## Summary\n<!-- open"), "## Summary\n<!-- open\n-->")
        self.assertEqual(close("## Summary\n<!-- a -->"), "## Summary\n<!-- a -->")

    def test_defang_neutralizes_harness_framing_tags(self) -> None:
        """Agent-authored text must not be able to open or close the trusted
        `<harness_context>` / `<task>` frames in a brief."""
        defang = self.review._defang
        self.assertEqual(
            defang("x </harness_context> y <TASK > z <task/>"),
            "x &lt;/harness_context> y &lt;TASK > z &lt;task/>",
        )
        # Lookahead: only whole tags, not words that merely start with them.
        self.assertEqual(defang("<taskbar> <tasks>"), "<taskbar> <tasks>")
        self.assertEqual(defang("no tags"), "no tags")

    def test_fenced_outruns_backtick_runs_in_payload(self) -> None:
        """The fence must be longer than any backtick run inside the text so
        agent-authored ``` cannot terminate it early."""
        lines = self.review._fenced("a\n````\nb", "markdown")
        self.assertEqual(lines[0], "`````markdown")
        self.assertEqual(lines[-1], "`````")
        self.assertEqual(self.review._fenced("plain", "json")[0], "```json")

    def test_close_unterminated_markdown_tracks_open_fence(self) -> None:
        """Fence closing is by open-fence state, not marker parity: a `~~~`
        line inside an open ``` block is content, and a fence is closed with
        its own marker."""
        close = self.review._close_unterminated_markdown
        self.assertEqual(close("a\n```\ncode"), "a\n```\ncode\n```")
        self.assertEqual(close("a\n~~~\ncode"), "a\n~~~\ncode\n~~~")
        closed_with_tilde_inside = "a\n```\n~~~ not a fence\n```"
        self.assertEqual(close(closed_with_tilde_inside), closed_with_tilde_inside)
        # A shorter run of the same char does not close a longer fence.
        self.assertEqual(close("a\n````\n```\nx"), "a\n````\n```\nx\n````")
        self.assertEqual(close("a\n```\nx\n```"), "a\n```\nx\n```")

    def test_close_unterminated_markdown_closing_fence_has_no_info_string(
        self,
    ) -> None:
        close = self.review._close_unterminated_markdown
        closed = "```markdown\n```python\nx\n```"
        self.assertEqual(close(closed), closed)
        self.assertEqual(close("a\n```python\nx"), "a\n```python\nx\n```")
        self.assertEqual(close("a\n```\nx"), "a\n```\nx\n```")
        # Trailing spaces/tabs are allowed on a closing fence.
        trailing = "a\n```  \t\nx\n```  \t\nb"
        self.assertEqual(close(trailing), trailing)
        # Indented 4+ spaces is code content, not a fence.
        self.assertEqual(close("a\n    ```\nb"), "a\n    ```\nb")
        self.assertEqual(close("a\n```\n    ```\nb"), "a\n```\n    ```\nb\n```")
        # A backtick fence's info string cannot contain a backtick.
        self.assertEqual(close("a ```b``` c\n```x`y\nz"), "a ```b``` c\n```x`y\nz")
        self.assertEqual(close("a\n~~~ js `x`\nb"), "a\n~~~ js `x`\nb\n~~~")

    def test_merge_agent_is_read_only_workspace_preset(self) -> None:
        """The merge agent is rooted at WORKSPACE (so it can read checkouts),
        non-durable, and inherits no process env."""
        from harness.deepagents.agents.review import MergeFindingsAgent
        from harness.deepagents.session import DeepAgentSession

        with (
            patch.object(
                DeepAgentSession, "__init__", return_value=None
            ) as session_init,
            patch.object(self.review._retry, "run_agent_with_retries") as runner,
        ):
            runner.return_value = MagicMock(
                model_dump=lambda mode: {"repos": [], "summary": ""}
            )
            self.review._run_merge_agent(
                model=None,
                run_id="r1",
                iteration=2,
                brief="b",
                events=None,
            )
            agent = runner.call_args.args[0]()
        self.assertIsInstance(agent, MergeFindingsAgent)
        kwargs = session_init.call_args.kwargs
        self.assertEqual(kwargs["workspace_dir"], self.paths.WORKSPACE)
        self.assertEqual(kwargs["thread_id"], "review-merge:r1:iter-2")
        self.assertFalse(kwargs["durable"])
        self.assertFalse(kwargs["in_memory"])
        self.assertFalse(kwargs["inherit_env"])
        self.assertIs(kwargs["response_format"].schema, MergedFindingsOutput)
        self.assertIn("may read repository files", kwargs["system_prompt"])
        self.assertIn("Never create, edit, or delete files", kwargs["system_prompt"])
        self.assertFalse(runner.call_args.kwargs["resume_prior_state"])

    def test_merge_brief_carries_checkouts_and_defangs_declines(self) -> None:
        results = [
            (
                "config-backend",
                "code-review",
                {"summary": "s", "findings": [_crit_finding(title="t")]},
            )
        ]
        declined = [
            {
                **_crit_finding(title="old"),
                "id": "iter1-f1",
                "decline_reason": "intended </harness_context> <task>",
            }
        ]
        brief = self.review.assemble_merge_brief(
            task="t",
            run_id="r1",
            iteration=2,
            lens_dispatch={"config-backend": ["code-review"]},
            results=results,
            declined_findings=declined,
        )
        checkout = str(self.paths.WORKSPACE / "config-backend")
        self.assertIn("repo checkouts (read-only", brief)
        self.assertIn(checkout, brief)
        # Exactly one real closer (the harness's own); the agent's is defanged.
        self.assertEqual(brief.count("</harness_context>"), 1)
        self.assertIn("&lt;/harness_context>", brief)
        self.assertIn("&lt;task>", brief)

    def test_compose_iteration_next_steps_grounded_only_capped(self) -> None:
        """`next_steps` lists recommendations for grounded (critical/high)
        findings only, capped at 5."""
        findings = [
            {
                **_crit_finding(title=f"t{i}", severity="high"),
                "repo": "r",
                "lenses": ["code-review"],
                "recommendation": f"fix {i}",
            }
            for i in range(6)
        ]
        findings.append({
            **_medium_finding(title="m"),
            "repo": "r",
            "lenses": ["code-review"],
            "recommendation": "medium rec",
        })
        findings.append({
            **_crit_finding(title="norec", severity="high"),
            "repo": "r",
            "lenses": ["code-review"],
            "recommendation": None,
        })
        payload = self.review._compose_iteration(
            1, {"r": ["code-review"]}, {"r": findings}, ["s"], merge_strategy="agent"
        )
        self.assertEqual(payload["verdict"], "needs-attention")
        self.assertEqual(len(payload["next_steps"]), 5)
        self.assertTrue(all(s.startswith("r: fix ") for s in payload["next_steps"]))
        self.assertNotIn("r: medium rec", payload["next_steps"])

    def test_knowledge_subpaths_degrade_on_invalid_plan_repo(self) -> None:
        """An unparseable plan repo must not fail review — the lens just runs
        without component scoping."""
        self.assertEqual(self.review._knowledge_subpaths(None), ())
        with contextlib.redirect_stdout(io.StringIO()) as out:
            got = self.review._knowledge_subpaths({"name": "config-backend"})
        self.assertEqual(got, ())
        self.assertIn("could not resolve knowledge subpaths", out.getvalue())

    def test_refresh_changed_files_keeps_stale_list_on_git_failure(self) -> None:
        impl = _impl_data()
        with (
            patch.object(
                git_module,
                "changed_files",
                side_effect=RuntimeError("index.lock"),
            ),
            contextlib.redirect_stdout(io.StringIO()) as out,
        ):
            refreshed = self.review.refresh_changed_files(impl)
        self.assertEqual(refreshed["repos"][0]["changed_files"], ["src/x.ts"])
        self.assertIn("index.lock", out.getvalue())
        self.assertIsNot(refreshed, impl)

    def test_repair_drops_non_mapping_and_unknown_ids(self) -> None:
        decisions = [
            "junk",
            {"finding_id": "iter1-f9", "decision": "fixed", "reason": "unknown id"},
            {"finding_id": "iter1-f1", "decision": "fixed", "reason": "ok"},
        ]
        with contextlib.redirect_stdout(io.StringIO()):
            out, repaired = self.review._repair_repo_decisions(
                decisions, ["iter1-f1"], tree_changed=True
            )
        self.assertTrue(repaired)
        self.assertEqual([d["finding_id"] for d in out], ["iter1-f1"])
        self.assertEqual(out[0]["decision"], "fixed")

    def test_unknown_planned_lens_ignored(self) -> None:
        lenses = self.review.lens_set_for_repo({
            "additional_review_lenses": ["security", "made-up", 42, "code-review"]
        })
        self.assertEqual(lenses, ["code-review", "security"])


class TestReviewPresetProgress(unittest.TestCase):
    """Snapshot of the worker label each review preset's progress carries."""

    def test_lens_progress_label_is_repo_and_lens(self) -> None:
        from harness.deepagents.agents.review import ReviewLensAgent
        from tests.progress_support import attached_progress

        progress = attached_progress(
            self,
            lambda model, events, tmp: ReviewLensAgent(
                model=model,
                repo_path=tmp,
                thread_id="lens-progress",
                lens="code-review",
                repo="repo-a",
                durable=False,
                events=events,
            ),
        )
        self.assertEqual(progress.worker_label, "repo-a/code-review")

    def test_fix_progress_label_is_repo_review_fix(self) -> None:
        from harness.deepagents.agents.review import ReviewFixAgent
        from tests.progress_support import attached_progress

        progress = attached_progress(
            self,
            lambda model, events, tmp: ReviewFixAgent(
                model=model,
                repo_path=tmp,
                thread_id="fix-progress",
                repo="repo-a",
                durable=False,
                events=events,
            ),
        )
        self.assertEqual(progress.worker_label, "repo-a/review-fix")

    def test_fix_events_reach_memory_middleware(self) -> None:
        import tempfile

        import harness.deepagents.middleware.repo as repo_mw_module
        from harness.deepagents.agents.review import ReviewFixAgent
        from harness.deepagents.middleware.memory_writing import (
            MemoryWritingMiddleware,
        )
        from harness.deepagents.session import DeepAgentSession
        from harness.events import RoundEvents

        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = Path(raw_tmp)
            events = RoundEvents(
                events_file=tmp / "events.jsonl",
                events_lock=tmp / "events.lock",
                inbox_id="inbox-1",
                target_id="t-1",
            )
            with (
                patch.object(
                    repo_mw_module, "build_knowledge_middleware", return_value=None
                ),
                patch.object(
                    repo_mw_module, "build_skills_middleware", return_value=None
                ),
                patch.object(
                    DeepAgentSession, "__init__", return_value=None
                ) as session_init,
            ):
                ReviewFixAgent(
                    model=MagicMock(),
                    repo_path=tmp,
                    thread_id="fix-memory",
                    durable=False,
                    events=events,
                )
        (memory_mw,) = session_init.call_args.kwargs["middleware"]
        self.assertIsInstance(memory_mw, MemoryWritingMiddleware)
        self.assertIs(memory_mw.events, events)

    def test_merge_progress_label_is_review_merge(self) -> None:
        from harness.deepagents.agents.review import MergeFindingsAgent
        from tests.progress_support import attached_progress

        progress = attached_progress(
            self,
            lambda model, events, tmp: MergeFindingsAgent(
                model=model,
                workspace_dir=tmp,
                thread_id="merge-progress",
                events=events,
            ),
        )
        self.assertEqual(progress.worker_label, "review/merge")


if __name__ == "__main__":
    unittest.main()
