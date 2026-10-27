"""``update_pull_request`` tool middleware: change a task PR's title or body."""

from __future__ import annotations

import http.client
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Literal

from langchain_core.tools import BaseTool, StructuredTool, ToolException
from pydantic import BaseModel, Field, create_model, model_validator

from harness.deepagents.middleware.arguments import (
    StrippedNonBlankStr,
    format_validation_error,
)
from harness.deepagents.middleware.system_prompt import SystemPromptMiddleware
from harness.git import GitHubApiError, GitHubClient, parse_pr_url


@dataclass(frozen=True)
class PullRequestRef:
    repo_name: str
    url: str


class _UpdateArgsBase(BaseModel):
    """Base of the argument model: at least one of title and body is required."""

    @model_validator(mode="after")
    def _require_a_field(self) -> _UpdateArgsBase:
        if getattr(self, "title", None) is None and getattr(self, "body", None) is None:
            raise ValueError("provide a title and/or a body")
        return self


class PullRequestMiddleware(SystemPromptMiddleware):
    """Registers ``update_pull_request`` for the task's pull requests."""

    def __init__(
        self,
        *,
        github: GitHubClient,
        prs: Sequence[PullRequestRef],
        system_prompt: str | None = None,
    ) -> None:
        if not prs:
            raise ValueError("PullRequestMiddleware requires at least one pull request")
        coords: dict[str, tuple[str, str, int]] = {}
        for ref in prs:
            parsed = parse_pr_url(ref.url)
            if parsed is None:
                raise ValueError(f"not a pull request URL: {ref.url!r}")
            if ref.repo_name in coords:
                raise ValueError(f"duplicate pull request repo: {ref.repo_name!r}")
            coords[ref.repo_name] = parsed
        self.github = github
        self.prs = tuple(prs)
        self._coords = coords
        self.system_prompt = system_prompt
        self.tools = [self._build_tool()]

    def _args_model(self) -> type[BaseModel]:
        fields: dict[str, Any] = {
            "title": (
                StrippedNonBlankStr | None,
                Field(
                    default=None,
                    description=(
                        "New PR title, or null to leave it unchanged. Must not be "
                        "blank; surrounding whitespace is removed."
                    ),
                ),
            ),
            "body": (
                str | None,
                Field(
                    default=None,
                    description=(
                        "New PR description, used exactly as given. An empty "
                        "string clears it; null leaves it unchanged."
                    ),
                ),
            ),
        }
        if len(self.prs) > 1:
            listed = "; ".join(f"{ref.repo_name}: {ref.url}" for ref in self.prs)
            fields["pr"] = (
                Literal[tuple(ref.repo_name for ref in self.prs)],
                Field(
                    description=f"Repository whose pull request to update. {listed}."
                ),
            )
        return create_model("UpdatePullRequestArgs", __base__=_UpdateArgsBase, **fields)

    def _build_tool(self) -> BaseTool:
        return StructuredTool.from_function(
            func=self._update,
            name="update_pull_request",
            description=(
                "Update the title and/or description of one of this task's pull "
                "requests. This is the only way to change pull request metadata; "
                "the gh CLI is not available. Only fields that differ are changed."
            ),
            args_schema=self._args_model(),
            handle_tool_error=True,
            handle_validation_error=format_validation_error,
        )

    def _update(self, **kwargs: Any) -> str:
        title: str | None = kwargs.get("title")
        body: str | None = kwargs.get("body")
        repo_name = kwargs.get("pr") or self.prs[0].repo_name
        owner, repo, number = self._coords[repo_name]

        requested: dict[str, str] = {}
        if title is not None:
            requested["title"] = title
        if body is not None:
            requested["body"] = body
        try:
            current = self.github.get_pull_request(owner, repo, number)
            current_title = str(current.get("title") or "")
            current_body = str(current.get("body") or "")
            changed: dict[str, str] = {}
            if title is not None and title != current_title:
                changed["title"] = title
            if body is not None and body != current_body:
                changed["body"] = body
            if not changed:
                return f"unchanged: {_status(requested)}"
            self.github.update_pull_request(
                owner,
                repo,
                number,
                title=changed.get("title"),
                body=changed.get("body"),
            )
        except GitHubApiError as exc:
            raise ToolException(str(exc)) from exc
        except (OSError, ValueError, http.client.HTTPException) as exc:
            raise ToolException(f"{exc.__class__.__name__}: {exc}") from exc
        return f"updated: {_status(changed)}"


def _status(fields: dict[str, str]) -> str:
    return ", ".join(f"{name}={value!r}" for name, value in fields.items())
