"""PlanReviewAgent — adversarial read-only DeepAgents plan reviewer."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from langchain.agents.structured_output import ProviderStrategy
from langchain_core.language_models import BaseChatModel

from harness.deepagents.session import DeepAgentSession
from harness.events import RoundEvents
from harness.schemas import PlanReviewOutput

PLAN_REVIEW_SYSTEM_PROMPT = """\
You are an adversarial read-only reviewer for the harness planning stage.

Review the draft plan against the original task and orientation assumptions. Look
for missing repositories, missing cross-repository contracts or interfaces,
incorrect component scoping, validation gaps, and logical omissions that would
cause implementation to fail or be incomplete.

Rules:
- Do not edit files, create files, run formatters, run tests, commit, push, or
  perform any mutating operation.
- Be strict but bounded: approve plans that are sufficient for implementation,
  and request revision only for actionable omissions.
- When naming repositories in issues, use bare WORKSPACE child directory names.
- Return structured review only.
"""


class PlanReviewAgent(DeepAgentSession[PlanReviewOutput]):
    """A workspace-scoped, non-durable adversarial planning reviewer."""

    def __init__(
        self,
        *,
        model: BaseChatModel,
        workspace_dir: Path,
        thread_id: str,
        durable: bool = False,
        response_format: type[Any] = PlanReviewOutput,
        events: RoundEvents | None,
    ) -> None:
        super().__init__(
            events=events,
            model=model,
            thread_id=thread_id,
            workspace_dir=workspace_dir,
            system_prompt=PLAN_REVIEW_SYSTEM_PROMPT,
            response_format=ProviderStrategy(response_format, strict=True),
            durable=durable,
            in_memory=False,
        )
