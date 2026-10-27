"""``rerun_failed_ci_jobs`` tool middleware: re-run the round's failed CI jobs."""

from __future__ import annotations

import http.client
from dataclasses import dataclass

from langchain_core.tools import BaseTool, StructuredTool, ToolException
from pydantic import BaseModel

from harness.deepagents.middleware.arguments import format_validation_error
from harness.deepagents.middleware.system_prompt import SystemPromptMiddleware
from harness.git import GitHubApiError, GitHubClient


@dataclass(frozen=True)
class WorkflowRunRef:
    owner: str
    repo: str
    run_id: int


class _NoArgs(BaseModel):
    pass


class CiRerunMiddleware(SystemPromptMiddleware):
    """Registers ``rerun_failed_ci_jobs`` for one workflow run."""

    def __init__(
        self,
        *,
        github: GitHubClient,
        run: WorkflowRunRef,
        system_prompt: str | None = None,
    ) -> None:
        self.github = github
        self.run = run
        self.system_prompt = system_prompt
        self.tools = [self._build_tool()]

    def _build_tool(self) -> BaseTool:
        return StructuredTool.from_function(
            func=self._rerun,
            name="rerun_failed_ci_jobs",
            description=(
                "Re-run the failed jobs of the CI run this conversation is about. "
                "Use it after a fix that creates no commit, such as a pull request "
                "title change; a pushed commit re-runs CI by itself."
            ),
            args_schema=_NoArgs,
            handle_tool_error=True,
            handle_validation_error=format_validation_error,
        )

    def _rerun(self) -> str:
        run = self.run
        try:
            self.github.rerun_failed_jobs(run.owner, run.repo, run.run_id)
        except GitHubApiError as exc:
            raise ToolException(str(exc)) from exc
        except (OSError, ValueError, http.client.HTTPException) as exc:
            raise ToolException(f"{exc.__class__.__name__}: {exc}") from exc
        return f"re-queued failed jobs for run {run.owner}/{run.repo}#{run.run_id}"
