"""Tests for harness.implementation per-repo orchestration helpers."""

from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import httpx
from langchain.agents.structured_output import StructuredOutputValidationError
from langchain_core.messages import AIMessage
from langgraph.checkpoint.base import empty_checkpoint
from openai import (
    APIConnectionError,
    APIError,
    APITimeoutError,
    BadRequestError,
    InternalServerError,
    RateLimitError,
)

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from harness import implementation
from harness.deepagents.checkpointer import (
    _reset_checkpointer,
    get_checkpointer,
    init_checkpointer,
)
from harness.deepagents.retry import run_model_with_retries
from harness.implementation import (
    _canonical_repo_output,
    _is_transient_model_exception,
    _retry_sleep_seconds,
    _run_one_repo_with_retries,
    deterministic_thread_id,
    run_implementation,
    unique_plan_repos,
)
from harness.plan_utils import knowledge_subpaths_for_repo
from harness.schemas import Plan, PlanRepo, RepoImplementationOutput
from tests.progress_support import assert_agent_wired, round_events


def _init_repo(path: Path) -> None:
    path.mkdir()
    subprocess.run(["git", "init"], cwd=path, check=True, capture_output=True)
    subprocess.run(
        ["git", "config", "user.email", "test@example.com"], cwd=path, check=True
    )
    subprocess.run(["git", "config", "user.name", "Test"], cwd=path, check=True)
    (path / "README.md").write_text("hello\n", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=path, check=True)
    subprocess.run(
        ["git", "commit", "-m", "init"], cwd=path, check=True, capture_output=True
    )


def _request() -> httpx.Request:
    return httpx.Request("POST", "https://api.example.test/v1/responses")


def _response(status_code: int) -> httpx.Response:
    return httpx.Response(status_code, request=_request())


def _structured_output_error() -> StructuredOutputValidationError:
    return StructuredOutputValidationError(
        "RepoImplementationOutput",
        ValueError("schema mismatch"),
        AIMessage(content='{"summary": "missing required fields"}'),
    )


def _repo_output(repo_path: Path) -> RepoImplementationOutput:
    return RepoImplementationOutput(
        name="repo-a",
        path=str(repo_path),
        changed_files=[],
        summary="changed",
        commit_message="feat: change repo a",
        pr_title="feat: change repo a",
        pr_body="## Summary\n- changed\n\n## Validation\n- not run",
        exercise_hint="Run CLI command `repo-a change --dry-run`.",
        feature_baseline="Existing dry-run output should still include unchanged status fields.",
    )


class _FakeImplementationAgent:
    def __init__(
        self,
        *,
        progress_markers: list[object],
        run_side_effect: BaseException | None = None,
        run_return_value: RepoImplementationOutput | None = None,
        has_prior_state: bool = False,
    ) -> None:
        self._progress_markers = iter(progress_markers)
        self.has_prior_state = has_prior_state
        self.run = MagicMock()
        self.resume_from_restart = MagicMock()
        self.close = MagicMock()
        if run_side_effect is not None:
            self.run.side_effect = run_side_effect
        if run_return_value is not None:
            self.run.return_value = run_return_value
            self.resume_from_restart.return_value = run_return_value

    @property
    def progress_marker(self) -> object:
        return next(self._progress_markers)


class TestImplementationHelpers(unittest.TestCase):
    def test_thread_id_is_deterministic(self) -> None:
        first = deterministic_thread_id(
            inbox_id="inbox-1", repo_name="a", repo_path="/tmp/a"
        )
        second = deterministic_thread_id(
            inbox_id="inbox-1", repo_name="a", repo_path="/tmp/a"
        )
        self.assertEqual(first, second)

    def test_knowledge_subpaths_are_unique_relative_components(self) -> None:
        repo = PlanRepo(
            name="mono",
            path="/wrong/legacy-path",
            goal="change",
            components=[
                {"name": "api", "path": "services/api"},
                {"name": "api-again", "path": "services/api"},
                {"name": "outside", "path": "/tmp/outside"},
            ],
        )
        self.assertEqual(knowledge_subpaths_for_repo(repo), ["services/api"])

    def test_unique_plan_repos_dedupes_by_name_not_legacy_path(self) -> None:
        plan = Plan.model_validate({
            "stage": "planning",
            "run_id": "r1",
            "task": "change",
            "task_key": "ABC-1",
            "status": "completed",
            "repos": [
                {"name": "repo-a", "path": "/wrong/one", "goal": "change"},
                {"name": "repo-b", "path": "/wrong/one", "goal": "change"},
                {"name": "repo-a", "path": "/different", "goal": "change"},
            ],
            "planning_notes": "notes",
            "generated_at": "2026-06-25T00:00:00Z",
        })

        self.assertEqual(
            [repo.name for repo in unique_plan_repos(plan)], ["repo-a", "repo-b"]
        )

    def test_openai_exception_classification_is_narrow(self) -> None:
        self.assertTrue(
            _is_transient_model_exception(
                APIConnectionError(message="connection", request=_request())
            )
        )
        self.assertTrue(
            _is_transient_model_exception(
                InternalServerError(
                    "server error", response=_response(502), body={"error": "bad"}
                )
            )
        )
        self.assertTrue(_is_transient_model_exception(_structured_output_error()))
        self.assertTrue(
            _is_transient_model_exception(
                httpx.RemoteProtocolError(
                    "peer closed connection without sending complete message body"
                )
            )
        )
        self.assertTrue(
            _is_transient_model_exception(httpx.ReadError("Connection reset by peer"))
        )
        self.assertTrue(
            _is_transient_model_exception(
                httpx.ReadTimeout("stream stalled", request=_request())
            )
        )
        self.assertTrue(
            _is_transient_model_exception(APITimeoutError(request=_request()))
        )
        self.assertFalse(
            _is_transient_model_exception(
                BadRequestError("bad", response=_response(400), body={"error": "bad"})
            )
        )
        self.assertFalse(_is_transient_model_exception(ValueError("bad schema")))

    @patch("harness.deepagents.retry.time.sleep")
    def test_read_timeout_mid_stream_is_retried(self, sleep: MagicMock) -> None:
        attempts = 0

        def operation() -> list[str]:
            nonlocal attempts
            attempts += 1

            def stream():
                yield "partial"
                if attempts == 1:
                    raise httpx.ReadTimeout("stream stalled", request=_request())
                yield "complete"

            return list(stream())

        result = run_model_with_retries(
            operation,
            max_retries=1,
            label="test model stream",
        )

        self.assertEqual(result, ["partial", "complete"])
        self.assertEqual(attempts, 2)
        sleep.assert_called_once()

    def test_stream_delivered_provider_errors_are_transient(self) -> None:
        """A rejection that arrives inside an SSE stream is a bare ``APIError``
        (no HTTP status); the rate-limit and 5xx forms must still retry, while
        a context-overflow ``APIError`` must not."""
        self.assertTrue(
            _is_transient_model_exception(
                APIError(
                    "Requests have exceeded the provider rate limit.",
                    _request(),
                    body={"code": "429"},
                )
            )
        )
        self.assertTrue(
            _is_transient_model_exception(
                APIError(
                    "The server had an error processing your request. Sorry "
                    "about that! You can retry your request.",
                    _request(),
                    body={"code": "server_error"},
                )
            )
        )
        self.assertFalse(
            _is_transient_model_exception(
                APIError(
                    "This model's maximum context length is 400000 tokens.",
                    _request(),
                    body={"code": "context_length_exceeded"},
                )
            )
        )

    def test_empty_stream_error_is_transient(self) -> None:
        """A Responses-API ``error`` event with no ``error`` wrapper never
        becomes an ``APIError``; langchain ends the stream with a bare
        ``ValueError``. That exact error retries; other ValueErrors and
        subclasses do not."""

        class _Sub(ValueError):
            pass

        self.assertTrue(
            _is_transient_model_exception(ValueError("No generations found in stream."))
        )
        self.assertTrue(
            _is_transient_model_exception(
                ValueError("No generation chunks were returned")
            )
        )
        self.assertFalse(_is_transient_model_exception(ValueError("bad input")))
        self.assertFalse(
            _is_transient_model_exception(_Sub("No generations found in stream."))
        )

    def test_rate_limit_classification_covers_both_forms(self) -> None:
        from harness.deepagents.retry import is_rate_limit_exception

        self.assertTrue(
            is_rate_limit_exception(
                RateLimitError("slow down", response=_response(429), body=None)
            )
        )
        self.assertTrue(
            is_rate_limit_exception(
                APIError("requests have exceeded rate limit.", _request(), body=None)
            )
        )
        self.assertFalse(
            is_rate_limit_exception(
                APIError(
                    "The server had an error processing your request.",
                    _request(),
                    body={"code": "server_error"},
                )
            )
        )
        # A real 4xx status wins over message text.
        self.assertFalse(
            is_rate_limit_exception(
                BadRequestError(
                    "rate limit mentioned in a 400",
                    response=_response(400),
                    body=None,
                )
            )
        )

    @patch("harness.deepagents.retry.time.sleep")
    @patch("harness.deepagents.retry.uniform", return_value=0.0)
    def test_run_model_with_retries_backs_off_on_stream_rate_limit(
        self, _uniform: MagicMock, sleep: MagicMock
    ) -> None:
        from harness.deepagents.retry import run_model_with_retries

        calls = {"n": 0}

        def operation() -> str:
            calls["n"] += 1
            if calls["n"] < 3:
                raise APIError(
                    "Your requests to gpt-5.5 have exceeded rate limit.",
                    _request(),
                    body=None,
                )
            return "ok"

        with patch.dict("os.environ", {}, clear=True):
            self.assertEqual(
                run_model_with_retries(operation, max_retries=3, label="t"), "ok"
            )
        self.assertEqual(calls["n"], 3)
        # Rate limits sleep at least the floor (30s), not the 10s/20s base curve.
        self.assertEqual([c.args[0] for c in sleep.call_args_list], [30.0, 30.0])


class TestRunOneRepoWithRetries(unittest.TestCase):
    def _repo(self) -> PlanRepo:
        return PlanRepo(name="repo-a", path="/legacy", goal="change")

    def _transient_error(self) -> APIConnectionError:
        return APIConnectionError(message="connection", request=_request())

    @patch("harness.deepagents.retry.time.sleep")
    @patch("harness.implementation.ImplementationAgent")
    def test_checkpoint_progress_resets_consecutive_failure_budget(
        self,
        mock_agent: MagicMock,
        sleep: MagicMock,
    ) -> None:
        mock_agent.side_effect = [
            _FakeImplementationAgent(
                progress_markers=["a", "b"],
                run_side_effect=self._transient_error(),
            ),
            _FakeImplementationAgent(
                progress_markers=["b", "b"],
                run_side_effect=self._transient_error(),
            ),
            _FakeImplementationAgent(
                progress_markers=["b", "b"],
                run_side_effect=self._transient_error(),
            ),
            _FakeImplementationAgent(
                progress_markers=["b", "b"],
                run_side_effect=self._transient_error(),
            ),
        ]
        # Attempt 1 advances a checkpoint (a -> b), then max_retries + 1
        # consecutive no-progress failures (b -> b) exhaust the reset budget.

        with self.assertRaises(APIConnectionError):
            _run_one_repo_with_retries(
                model=object(),
                task="change",
                task_key="ABC-1",
                inbox_id="inbox-1",
                repo=self._repo(),
                markers_dir=Path("/tmp/markers"),
                max_retries=2,
                events=None,
            )

        self.assertEqual(mock_agent.call_count, 4)
        self.assertEqual(sleep.call_count, 3)

    @patch("harness.deepagents.retry.time.sleep")
    @patch("harness.implementation.ImplementationAgent")
    def test_no_progress_failures_exhaust_after_max_retries_plus_one_attempts(
        self,
        mock_agent: MagicMock,
        sleep: MagicMock,
    ) -> None:
        mock_agent.side_effect = [
            _FakeImplementationAgent(
                progress_markers=[None, None],
                run_side_effect=self._transient_error(),
            ),
            _FakeImplementationAgent(
                progress_markers=[None, None],
                run_side_effect=self._transient_error(),
            ),
            _FakeImplementationAgent(
                progress_markers=[None, None],
                run_side_effect=self._transient_error(),
            ),
        ]

        with self.assertRaises(APIConnectionError):
            _run_one_repo_with_retries(
                model=object(),
                task="change",
                task_key="ABC-1",
                inbox_id="inbox-1",
                repo=self._repo(),
                markers_dir=Path("/tmp/markers"),
                max_retries=2,
                events=None,
            )

        self.assertEqual(mock_agent.call_count, 3)
        self.assertEqual(sleep.call_count, 2)

    @patch("harness.deepagents.retry.time.sleep")
    @patch("harness.implementation.ImplementationAgent")
    def test_non_transient_failure_raises_immediately_without_sleep(
        self,
        mock_agent: MagicMock,
        sleep: MagicMock,
    ) -> None:
        mock_agent.return_value = _FakeImplementationAgent(
            progress_markers=["a", "a"],
            run_side_effect=ValueError("not retryable"),
        )

        with self.assertRaises(ValueError):
            _run_one_repo_with_retries(
                model=object(),
                task="change",
                task_key="ABC-1",
                inbox_id="inbox-1",
                repo=self._repo(),
                markers_dir=Path("/tmp/markers"),
                max_retries=2,
                events=None,
            )

        self.assertEqual(mock_agent.call_count, 1)
        sleep.assert_not_called()

    @patch("harness.deepagents.retry.uniform", return_value=0.0)
    def test_retry_sleep_defaults_use_outage_scale_backoff(
        self, _uniform: MagicMock
    ) -> None:
        with patch.dict("os.environ", {}, clear=True):
            self.assertEqual(_retry_sleep_seconds(1), 10.0)
            self.assertEqual(_retry_sleep_seconds(2), 20.0)
            self.assertEqual(_retry_sleep_seconds(3), 40.0)
            self.assertEqual(_retry_sleep_seconds(6), 300.0)

    @patch("harness.deepagents.retry.uniform", return_value=0.0)
    def test_retry_sleep_respects_base_and_cap_env_overrides(
        self, _uniform: MagicMock
    ) -> None:
        env = {
            "HARNESS_DEEPAGENTS_RETRY_BASE_SECONDS": "2",
            "HARNESS_DEEPAGENTS_RETRY_MAX_SECONDS": "30",
        }
        with patch.dict("os.environ", env, clear=False):
            self.assertEqual(_retry_sleep_seconds(1), 2.0)
            self.assertEqual(_retry_sleep_seconds(2), 4.0)
            self.assertEqual(_retry_sleep_seconds(3), 8.0)
            self.assertEqual(_retry_sleep_seconds(5), 30.0)

    @patch("harness.deepagents.retry.uniform", return_value=0.0)
    def test_retry_sleep_env_overrides_are_integer_seconds(
        self, _uniform: MagicMock
    ) -> None:
        env = {
            "HARNESS_DEEPAGENTS_RETRY_BASE_SECONDS": "2.5",
            "HARNESS_DEEPAGENTS_RETRY_MAX_SECONDS": "30.5",
        }
        with patch.dict("os.environ", env, clear=False):
            self.assertEqual(_retry_sleep_seconds(1), 10.0)
            self.assertEqual(_retry_sleep_seconds(6), 300.0)

    @patch("harness.deepagents.retry.uniform", return_value=0.0)
    def test_retry_sleep_rate_limit_floor(self, _uniform: MagicMock) -> None:
        from harness.deepagents.retry import retry_sleep_seconds

        with patch.dict("os.environ", {}, clear=True):
            self.assertEqual(retry_sleep_seconds(1, rate_limited=True), 30.0)
            self.assertEqual(retry_sleep_seconds(2, rate_limited=True), 30.0)
            # Once the exponential curve passes the floor, the curve wins.
            self.assertEqual(retry_sleep_seconds(3, rate_limited=True), 40.0)
            self.assertEqual(retry_sleep_seconds(6, rate_limited=True), 300.0)
        env = {"HARNESS_DEEPAGENTS_RATE_LIMIT_MIN_SECONDS": "45"}
        with patch.dict("os.environ", env, clear=True):
            self.assertEqual(retry_sleep_seconds(1, rate_limited=True), 45.0)

    @patch("harness.deepagents.retry.uniform", return_value=7.0)
    def test_rate_limit_jitter_survives_the_cap(self, uniform: MagicMock) -> None:
        """Jitter spans the full floor window and is added on top of the cap.
        Clamping after jitter made every worker at the cap sleep exactly the
        cap, i.e. retry in lockstep, which is the one thing the jitter is for.
        """
        from harness.deepagents.retry import retry_sleep_seconds

        with patch.dict("os.environ", {}, clear=True):
            self.assertEqual(retry_sleep_seconds(1, rate_limited=True), 37.0)
            self.assertEqual(retry_sleep_seconds(6, rate_limited=True), 307.0)
        uniform.assert_called_with(0.0, 30.0)
        env = {"HARNESS_DEEPAGENTS_RETRY_MAX_SECONDS": "30"}
        with patch.dict("os.environ", env, clear=True):
            self.assertEqual(retry_sleep_seconds(3, rate_limited=True), 37.0)


class TestRunImplementation(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self._workspace_patch = patch("harness.implementation.WORKSPACE", self.tmp)
        self._workspace_patch.start()
        self.repo = self.tmp / "repo-a"
        _init_repo(self.repo)

    def tearDown(self) -> None:
        self._workspace_patch.stop()
        self._tmp.cleanup()

    def _plan(self, repos: list[dict[str, object]]) -> Plan:
        return Plan.model_validate({
            "stage": "planning",
            "run_id": "r1",
            "task": "change",
            "task_key": "ABC-1",
            "status": "completed",
            "repos": repos,
            "planning_notes": "notes",
            "generated_at": "2026-06-25T00:00:00Z",
        })

    @patch("harness.implementation.write_json")
    @patch("harness.implementation.build_model")
    @patch("harness.implementation.ImplementationAgent")
    def test_aggregates_worker_output_and_changed_files(
        self, mock_agent: MagicMock, mock_model: MagicMock, mock_write_json: MagicMock
    ) -> None:
        session = mock_agent.return_value
        session.progress_marker = None
        session.has_prior_state = False

        def _run(brief: str) -> RepoImplementationOutput:
            self.assertIn(f"repo_path: {self.repo.resolve()}", brief)
            self.assertNotIn("/wrong/place", brief)
            (self.repo / "changed.txt").write_text("changed\n", encoding="utf-8")
            return _repo_output(self.repo)

        session.run.side_effect = _run
        plan = self._plan([
            {
                "name": "repo-a",
                "path": "/wrong/place",
                "goal": "change",
                "components": [{"name": "component", "path": "component"}],
            }
        ])

        stale_markers = self.tmp / "outside" / "implementation"
        stale_markers.mkdir(parents=True)
        (stale_markers / "inbox-1-repo-a.json").write_text("not json", encoding="utf-8")

        with patch("harness.implementation.MARKERS_DIR", stale_markers):
            result = run_implementation(
                plan=plan,
                inbox_id="inbox-1",
                impl_out=self.tmp / "implementation.json",
                events=None,
            )

        self.assertEqual(result.status, "completed")
        self.assertEqual(result.repos[0].name, "repo-a")
        self.assertEqual(result.repos[0].path, str(self.repo.resolve()))
        self.assertEqual(result.repos[0].changed_files, ["changed.txt"])
        self.assertEqual(
            result.repos[0].exercise_hint,
            "Run CLI command `repo-a change --dry-run`.",
        )
        self.assertEqual(
            result.repos[0].feature_baseline,
            "Existing dry-run output should still include unchanged status fields.",
        )
        self.assertNotIn(
            "ready_to_commit",
            result.repos[0].model_dump(mode="json", exclude_none=True),
        )
        mock_agent.assert_called_once()
        self.assertEqual(
            mock_agent.call_args.kwargs["knowledge_subpaths"], ["component"]
        )
        self.assertEqual(mock_agent.call_args.kwargs["repo"], "repo-a")
        self.assertEqual(mock_agent.call_args.kwargs["stage"], "implementation")
        self.assertIn("inbox-1", mock_agent.call_args.kwargs["thread_id"])
        written_paths = {call.args[0] for call in mock_write_json.call_args_list}
        self.assertIn(
            self.tmp / "implementation" / "inbox-1-repo-a.json", written_paths
        )
        self.assertIn(self.tmp / "implementation.json", written_paths)

    @patch("harness.implementation.write_json")
    @patch("harness.implementation.build_model")
    @patch("harness.implementation.ImplementationAgent")
    def test_logging_middleware_is_left_to_session_default(
        self, mock_agent: MagicMock, _mock_model: MagicMock, _mock_write_json: MagicMock
    ) -> None:
        session = mock_agent.return_value
        session.progress_marker = None
        session.has_prior_state = False
        session.run.return_value = _repo_output(self.repo)
        plan = self._plan([
            {"name": "repo-a", "path": str(self.repo), "goal": "change"}
        ])

        run_implementation(
            plan=plan,
            inbox_id="inbox-1",
            impl_out=self.tmp / "implementation.json",
            events=None,
        )

        self.assertNotIn("middleware", mock_agent.call_args.kwargs)

    @patch("harness.implementation.write_json")
    @patch("harness.implementation.build_model")
    @patch("harness.implementation.ImplementationAgent")
    def test_uses_the_implementation_stage_settings(
        self, mock_agent: MagicMock, mock_model: MagicMock, _mock_write_json: MagicMock
    ) -> None:
        session = mock_agent.return_value
        session.progress_marker = None
        session.has_prior_state = False
        session.run.return_value = _repo_output(self.repo)
        plan = self._plan([
            {"name": "repo-a", "path": str(self.repo), "goal": "change"}
        ])

        with patch.dict(
            "os.environ",
            {
                "HARNESS_IMPLEMENTATION_MODEL": "impl-model",
                "HARNESS_IMPLEMENTATION_REASONING_EFFORT": "xhigh",
            },
        ):
            run_implementation(
                plan=plan,
                inbox_id="inbox-1",
                impl_out=self.tmp / "implementation.json",
                events=None,
            )

        mock_model.assert_called_once_with(model="impl-model", reasoning_effort="xhigh")

    @patch("harness.implementation.write_json")
    @patch("harness.implementation.build_model")
    @patch("harness.implementation.ImplementationAgent")
    def test_non_retryable_per_repo_failure_raises_without_failure_output(
        self, mock_agent: MagicMock, _mock_model: MagicMock, _mock_write_json: MagicMock
    ) -> None:
        mock_agent.side_effect = RuntimeError("boom")
        plan = self._plan([
            {"name": "repo-a", "path": str(self.repo), "goal": "change"}
        ])

        with self.assertRaises(RuntimeError):
            run_implementation(
                plan=plan,
                inbox_id="inbox-1",
                impl_out=self.tmp / "implementation.json",
                events=None,
            )

        _mock_write_json.assert_not_called()

    @patch.dict("os.environ", {"HARNESS_DEEPAGENTS_MAX_RETRIES": "2"}, clear=False)
    @patch("harness.deepagents.retry.time.sleep")
    @patch("harness.implementation.write_json")
    @patch("harness.implementation.build_model")
    @patch("harness.implementation.ImplementationAgent")
    def test_transient_failure_retries_and_resumes_existing_checkpoint(
        self,
        mock_agent: MagicMock,
        _mock_model: MagicMock,
        _mock_write_json: MagicMock,
        sleep: MagicMock,
    ) -> None:
        first = _FakeImplementationAgent(
            progress_markers=[None, None],
            run_side_effect=APIConnectionError(
                message="connection", request=_request()
            ),
        )
        second = _FakeImplementationAgent(
            progress_markers=[None],
            run_return_value=_repo_output(self.repo),
            has_prior_state=True,
        )
        mock_agent.side_effect = [first, second]
        plan = self._plan([
            {"name": "repo-a", "path": str(self.repo), "goal": "change"}
        ])

        result = run_implementation(
            plan=plan,
            inbox_id="inbox-1",
            impl_out=self.tmp / "implementation.json",
            events=None,
        )

        self.assertEqual(result.status, "completed")
        self.assertEqual(mock_agent.call_count, 2)
        first.run.assert_called_once()
        first.close.assert_called_once()
        second.resume_from_restart.assert_called_once()
        second.close.assert_called_once()
        sleep.assert_called_once()

    @patch.dict("os.environ", {"HARNESS_DEEPAGENTS_MAX_RETRIES": "2"}, clear=False)
    @patch("harness.deepagents.retry.time.sleep")
    @patch("harness.implementation.write_json")
    @patch("harness.implementation.build_model")
    @patch("harness.implementation.ImplementationAgent")
    def test_transient_failure_exhaustion_raises(
        self,
        mock_agent: MagicMock,
        _mock_model: MagicMock,
        mock_write_json: MagicMock,
        sleep: MagicMock,
    ) -> None:
        mock_agent.side_effect = APIConnectionError(
            message="connection", request=_request()
        )
        plan = self._plan([
            {"name": "repo-a", "path": str(self.repo), "goal": "change"}
        ])

        with self.assertRaises(APIConnectionError):
            run_implementation(
                plan=plan,
                inbox_id="inbox-1",
                impl_out=self.tmp / "implementation.json",
                events=None,
            )

        self.assertEqual(mock_agent.call_count, 3)
        self.assertEqual(sleep.call_count, 2)
        mock_write_json.assert_not_called()

    @patch("harness.implementation.write_json")
    @patch("harness.implementation.build_model")
    @patch("harness.implementation.ImplementationAgent")
    def test_agent_receives_round_events_client(
        self,
        mock_agent: MagicMock,
        _mock_model: MagicMock,
        _mock_write_json: MagicMock,
    ) -> None:
        mock_agent.return_value = _FakeImplementationAgent(
            progress_markers=[None], run_return_value=_repo_output(self.repo)
        )
        plan = self._plan([
            {"name": "repo-a", "path": str(self.repo), "goal": "change"}
        ])

        with round_events() as events:
            run_implementation(
                plan=plan,
                inbox_id="inbox-1",
                impl_out=self.tmp / "implementation.json",
                events=events,
            )
            assert_agent_wired(self, mock_agent, events)

    @patch("harness.implementation.ImplementationAgent")
    def test_retry_helper_resumes_prior_state(self, mock_agent: MagicMock) -> None:
        """A durable implementation thread with prior state is a crashed run:
        the shared helper must be told to resume it, not re-send the brief."""
        from harness.deepagents import retry as retry_module

        with (
            patch.object(
                retry_module,
                "run_agent_with_retries",
                return_value=_repo_output(self.repo),
            ) as runner,
            patch("harness.implementation.write_json"),
        ):
            _run_one_repo_with_retries(
                model=object(),
                task="change",
                task_key="ABC-1",
                inbox_id="inbox-1",
                repo=PlanRepo(name="repo-a", path=str(self.repo), goal="change"),
                markers_dir=self.tmp / "markers",
                max_retries=2,
                events=None,
            )
        self.assertTrue(runner.call_args.kwargs["resume_prior_state"])
        self.assertEqual(runner.call_args.kwargs["max_retries"], 2)
        mock_agent.assert_not_called()

    def test_canonical_repo_output_scrubs_legacy_ready_to_commit(self) -> None:
        repo = PlanRepo(name="repo-a", path=str(self.repo), goal="change")
        output = RepoImplementationOutput.model_validate({
            "name": "wrong-repo",
            "path": "/tmp/wrong-repo",
            "changed_files": [],
            "summary": "changed",
            "exercise_hint": "GET /settings and verify the changed control.",
            "feature_baseline": "Settings page layout remains unchanged.",
            "commit_message": "feat: change repo a",
            "pr_title": "feat: change repo a",
            "pr_body": "## Summary\n- changed\n\n## Validation\n- not run",
            "ready_to_commit": False,
        })

        result = _canonical_repo_output(repo=repo, repo_path=self.repo, output=output)

        dumped = result.model_dump(mode="json", exclude_none=True)
        self.assertEqual(dumped["name"], "repo-a")
        self.assertEqual(dumped["path"], str(self.repo))
        self.assertEqual(
            dumped["exercise_hint"], "GET /settings and verify the changed control."
        )
        self.assertEqual(
            dumped["feature_baseline"], "Settings page layout remains unchanged."
        )
        self.assertNotIn("ready_to_commit", dumped)


class TestImplementationStarted(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        _reset_checkpointer()
        init_checkpointer(self.tmp / "checkpoints.db")

    def tearDown(self) -> None:
        _reset_checkpointer()
        self._tmp.cleanup()

    def _started(self) -> bool:
        return implementation.implementation_started(
            inbox_id="inbox-1",
            repo_names=["repo-a", "repo-b"],
            markers_dir=self.tmp / "markers",
        )

    def test_false_when_nothing_exists(self) -> None:
        self.assertFalse(self._started())

    def test_true_with_a_worker_marker(self) -> None:
        marker = implementation._marker_path(self.tmp / "markers", "inbox-1", "repo-b")
        marker.parent.mkdir(parents=True)
        marker.write_text("{}")
        self.assertTrue(self._started())

    def test_true_with_a_worker_checkpoint(self) -> None:
        thread_id = implementation.deterministic_thread_id(
            inbox_id="inbox-1",
            repo_name="repo-a",
            repo_path=str(
                implementation.repo_checkout_path(
                    "repo-a", workspace=implementation.WORKSPACE
                )
            ),
        )
        saver = get_checkpointer()
        config = {"configurable": {"thread_id": thread_id, "checkpoint_ns": ""}}
        saver.put(config, empty_checkpoint(), {"source": "input", "step": -1}, {})
        self.assertTrue(self._started())

    def test_false_without_checkpointer(self) -> None:
        _reset_checkpointer()
        self.assertFalse(self._started())


if __name__ == "__main__":
    unittest.main()
