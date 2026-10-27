"""DeepAgents presets for the review stage: lens, review-fix, and merge.

``ReviewLensAgent`` — a single-(repository, lens) adversarial review preset.
The harness dispatches one per (repository, lens) pair —
deterministically, from the plan's lens selection — instead of letting a
coordinator model decide which subagents to spawn. Each agent performs one
adversarial pass over the repo's working-tree diff through its assigned lens
only and returns structured findings (``ReviewLensOutput``); the harness owns
merging, dedup, caps, verdicts, and every artifact.

Read-only by contract: the agent reads via shell (``rg``/``sed``/``git
diff``) and may write throwaway repro scripts ONLY in the harness scratch dir
passed in the brief. It must NOT re-run the repository's quality gates (test
suite, type-checker, linter, formatter, build): the implementation stage
already ran them on this exact diff, and N lenses each re-running them in
parallel has OOM-killed and TTL-expired sandboxes. It must leave every repo's
``git status`` untouched — the harness fingerprints the working tree around
the review fan-out and flags mutations.

``ReviewFixAgent`` — a fresh per-(iteration, repository) fix preset (same
repo middleware stack plus the memory-writing tool, pinned to
``REVIEW_FIX_SYSTEM_PROMPT`` and ``RepoReviewFixOutput``) briefed with the
implementer's ``design_notes`` rather than sharing its conversation.

``MergeFindingsAgent`` — a non-durable cross-lens merger that dedupes the
lens outputs and writes the fixer-facing report.
"""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path

from langchain.agents.structured_output import ProviderStrategy
from langchain_core.language_models import BaseChatModel

from harness.deepagents.dense_turns import (
    DENSE_TURNS_EDIT_PROMPT,
    DENSE_TURNS_READONLY_PROMPT,
)
from harness.deepagents.middleware.repo import build_repo_middleware
from harness.deepagents.session import DeepAgentSession
from harness.events import RoundEvents
from harness.schemas.review import (
    MergedFindingsOutput,
    RepoReviewFixOutput,
    ReviewLensOutput,
)
from harness.util import _prompt_text

REVIEW_SYSTEM_PROMPT_TEMPLATE = """\
You are an adversarial review subagent examining a single repository through
one assigned lens. The repository is your current working directory; you have
shell and filesystem access rooted at it.

The user message (your brief) carries the original task, the plan and
implementation slices for this repository, the harness scratch directory, any
previously declined findings, and your lens assignment. Other lenses run in
parallel on the same repository.

Your job: perform one thorough adversarial pass over this repository's
working-tree diff THROUGH YOUR ASSIGNED LENS ONLY, and return material
findings as structured output.

{read_discipline}

Diff scope: the review covers BOTH tracked changes (`git diff HEAD`) AND
untracked files. `git diff HEAD` does not show untracked files; treat each one
as a fully-added new file and review it in full, regardless of size.

Previously declined findings: when your brief carries findings the
implementer declined (with rationale), handle each explicitly — either concur
(do not re-raise it) or escalate (re-raise it with `prior_finding_id` set to
its `id` and evidence that addresses the decline reason, not a restatement of
the original claim).

Hard constraints:
- Forbidden: creating, editing, or deleting any file under the repository
  tree; any command that dirties `git status`. Throwaway scripts go in the
  scratch dir named in your brief.
- Do not run the repository's test suite, type-checker, linter, formatter, or
  build (e.g. `npm test`, `jest`, `tsc`, `npm run typecheck`, `eslint`,
  `pytest`, `make build`). The implementation stage already ran those gates on
  this exact diff and the working tree has not changed since. Ground findings
  by reading code (`rg`, `sed`, `git diff`) and, when a claim genuinely needs
  execution, by a small throwaway repro script in the scratch dir.
- Findings must be grounded in the actual repository content. The defect may
  live in how the diff interacts with code outside it — trace and report
  that — but never invent files, lines, code paths, attack chains, or runtime
  behavior you cannot support.
- For each `critical` or `high` finding you MUST include `file` and
  `line_start` (the start line of the problematic hunk in the new file).
- Cap at your strongest 5 findings; if more exist, keep the top 5 by severity
  then confidence.
- `summary` is a one-line synthesis of your pass.
"""

REVIEW_FIX_SYSTEM_PROMPT = (
    """\
You are the review-fix agent for a single repository. An implementation agent
made a change here (it is the uncommitted diff in the working tree) and an
adversarial review flagged findings against it. The repository is your current
working directory; you have shell and filesystem access scoped to it.

The user message carries the harness context, the implementer's own account
of the change (its summary and design notes), the plan slice for this
repository, and the review findings. Read the diff yourself before triaging.
Triage each finding on its merits: implement a correct fix scoped to the
finding, or decline it with a concrete technical reason.

Rules:
- Do not re-run full quality gates; run only the narrow commands needed to
  confirm a specific fix landed (e.g. the type-checker for a changed file).
- Do not push branches, create pull requests, or perform any publish action.
- Do not write any harness stage artifact (`implementation.json`,
  `review*.json`) — your structured output (the triage decisions plus the
  updated repository summary) is your only report; the harness owns those
  files and recomputes changed files from git. Recording a durable repo-local
  memory note through the memory tool, when you learn something worth
  keeping, is fine.
- If a finding asks for a human decision rather than a code change (owner
  confirmation, approval, rollout timing, a merge hold), decline it and name
  the decision in `reason`. Do not remove the work it questions to make it
  go away.
"""
    + DENSE_TURNS_EDIT_PROMPT
)

# One mandate per lens. Keys must cover BASE_REVIEW_LENSES and
# OPTIONAL_REVIEW_LENSES from harness.schemas.review (a test enforces this).
LENS_MANDATES: dict[str, str] = {
    "code-review": """\
Your lens: code review of the diff — anything a careful reviewer would flag.
For example:
- correctness: logic errors, wrong conditions, off-by-one, unhandled cases
- error handling: swallowed or mis-reported failures, missing guards on
  null/empty/timeout/degraded-dependency paths
- state and concurrency: races, ordering assumptions, stale state,
  non-idempotent retries, partial-failure and rollback gaps
- data: loss, corruption, duplication, irreversible changes
- boundaries: auth, permissions, tenant isolation, trust of inputs
- compatibility: schema/API drift, migrations, version skew
- observability: failures that would go unnoticed
- visual / layout regression: the change achieves its goal but shifts,
  collapses, hides, or repositions an unchanged sibling or parent element
- plan alignment: the diff does what the task asked, touches the planned
  areas, and changes nothing outside scope without justification
""",
    "bug-hunter": """\
Your lens: bugs — code paths in the diff that will crash, return wrong
results, or leave state inconsistent at runtime. Trace each suspected
defect through the code to a concrete failure path rather than reporting
on suspicion. For example:
- Decorators/annotations on accessors or methods the diff depends on — what
  they change about runtime semantics, and whether the diff's usage matches.
- Tests are claims, not evidence: test doubles, mocks, and fixtures may not
  match production semantics; a green test on an unfaithful double is a
  finding, not reassurance.
- State in each finding's `body` the input or state that triggers the bug
  and what goes wrong.
""",
    "bird-eye": """\
Your lens: the system around the diff — how the change sits in the wider
codebase rather than the hunks themselves. For example:
- Second hop: for anything the diff newly depends on (a symbol, store,
  accessor, API), what populates it, what it is keyed by, how existing
  consumers resolve the same data, and what its reset/teardown and error
  paths do — existing and type-checking is not the same as behaving as the
  diff assumes.
- Callers and consumers: who reaches the new code (routes, events, stores,
  jobs), and whether every entry path satisfies its assumptions.
- Lifecycle: initialization order, reset/teardown, error/fallback paths,
  workspace/tenant/session switches, stale or cached state.
- End-to-end goal: whether the change achieves the task's stated goal across
  the whole flow, not just in the files it edits.
""",
    "security": """\
Your lens: security of the diff — weaknesses the change introduces or
exposes. For example:
- injection sinks (SQL/NoSQL, shell, path traversal, template, header/log
  injection) reachable from user- or tenant-controlled input
- authn/authz gaps: missing permission checks, IDOR, tenant isolation breaks,
  privilege escalation via new routes, jobs, or event handlers
- secrets and sensitive data: credentials in code/config, PII or tokens
  written to logs, analytics, URLs, or error messages
- unsafe deserialization, SSRF, unvalidated redirects, CORS/CSRF regressions
- crypto misuse: weak primitives, static IVs/salts, homegrown comparisons,
  timing-unsafe checks on secrets
- dependency hazards the diff introduces: new packages, loosened version pins
A finding is strongest when `body` names the path from an
attacker-controllable entry point to the sink; a sink with no reachable
untrusted input is not a finding.
""",
    "code-quality": """\
Your lens: maintainability — structural problems with a concrete blast radius,
and whether the diff follows the conventions already established in this
repository. For example:
- departures from the repository's existing style: naming, file/module
  layout, error and logging idioms, formatting not already enforced by a
  linter or formatter
- duplicated logic the diff introduces when an existing helper or utility in
  this repository already covers it (name the existing symbol and location)
- new code that contradicts the repository's established pattern for the same
  concern (error handling, data access, state management, config reads),
  creating a second way to do the same thing
- leaky abstractions: internals of one module newly reached into by another;
  new imports that cross an established layer boundary
- dead or unreachable code the diff adds; parameters or flags no caller can
  ever set
- complexity hot spots: a function the diff pushes clearly past reasonable
  branching/nesting for its role, where a split is the safer shape
""",
}


class ReviewLensAgent(DeepAgentSession[ReviewLensOutput]):
    """A single-(repository, lens) adversarial review preset.

    Own thread per (assignment, iteration, repository, lens): the reviewer
    must never inherit another agent's context, so callers mint a dedicated
    ``thread_id`` — deterministic, so a restart resumes an interrupted turn.
    ``durable=True`` is what lets the retry helper resume a crashed turn
    instead of re-sending the brief. No memory-writing middleware — review is
    a read-only stage.
    """

    def __init__(
        self,
        *,
        model: BaseChatModel,
        repo_path: Path,
        thread_id: str,
        lens: str,
        knowledge_subpaths: Sequence[str] = (),
        repo: str | None = None,
        durable: bool = True,
        events: RoundEvents | None,
    ) -> None:
        mandate = LENS_MANDATES.get(lens)
        if mandate is None:
            raise ValueError(
                f"unknown review lens {lens!r}; known: {sorted(LENS_MANDATES)}"
            )
        system_prompt = "\n\n".join([
            REVIEW_SYSTEM_PROMPT_TEMPLATE.format(
                read_discipline=_prompt_text("read_discipline.md")
            )
            + DENSE_TURNS_READONLY_PROMPT,
            "## Your lens mandate\n\n" + mandate,
        ])

        repo_name = repo or repo_path.name
        super().__init__(
            events=events,
            model=model,
            thread_id=thread_id,
            workspace_dir=repo_path,
            system_prompt=system_prompt,
            # Read-only stage: no memory-writing tool.
            middleware=build_repo_middleware(
                repo_path=repo_path,
                repo=repo_name,
                knowledge_subpaths=knowledge_subpaths,
            ),
            response_format=ProviderStrategy(ReviewLensOutput, strict=True),
            durable=durable,
            emit_identifier=f"{repo_name}/{lens}",
        )


class ReviewFixAgent(DeepAgentSession[RepoReviewFixOutput]):
    """Fresh per-(iteration, repository) review-fix preset.

    Same repo middleware stack as implementation (knowledge, skills, memory
    writing) under the review-fix persona: ``REVIEW_FIX_SYSTEM_PROMPT`` and
    ``RepoReviewFixOutput``. The memory tool carries the default short
    memory policy; the implementation-only autonomous-decision rule is not
    part of it. Callers mint a unique ``thread_id``
    per (iteration, repository): the fix pass never resumes the
    implementation thread; the implementer's intent arrives as data in the
    brief (``summary`` + ``design_notes``).
    """

    def __init__(
        self,
        *,
        model: BaseChatModel,
        repo_path: Path,
        thread_id: str,
        knowledge_subpaths: Sequence[str] = (),
        repo: str | None = None,
        durable: bool = True,
        events: RoundEvents | None,
    ) -> None:
        repo_name = repo or repo_path.name
        super().__init__(
            events=events,
            model=model,
            thread_id=thread_id,
            workspace_dir=repo_path,
            system_prompt=REVIEW_FIX_SYSTEM_PROMPT,
            middleware=build_repo_middleware(
                repo_path=repo_path,
                repo=repo_name,
                knowledge_subpaths=knowledge_subpaths,
                memory_stage="review-fix",
                events=events,
            ),
            response_format=ProviderStrategy(RepoReviewFixOutput, strict=True),
            durable=durable,
            emit_identifier=f"{repo_name}/review-fix",
        )


MERGE_FINDINGS_SYSTEM_PROMPT = """\
You are the merge-findings agent for the harness review stage. Several
adversarial review lenses just examined the same working-tree diff in
parallel, each through one lens (code-review, bug-hunter, bird-eye, security,
code-quality). Their raw findings, grouped by repository and lens, are in the
user message as JSON.

Your job, per repository:
1. Merge duplicates. Two findings describe the same underlying issue when they
   point at the same defect or root cause — the same hunk, the same missing
   guard, the same broken contract — even if the wording, severity, or exact
   line ranges differ. Fold them into ONE finding: keep the strongest
   evidence (a proven repro beats an inference), take the highest defensible
   severity and confidence among the sources, keep the most precise
   `file`/`line_start`/`line_end`, fold complementary evidence from the other
   sources into `body`, and list every contributing lens in `lenses`.
2. Keep distinct issues distinct. Two findings in the same file at different
   locations, or with different root causes, are separate entries.
3. Rank: order each repository's findings by severity (critical > high >
   medium > low), then confidence. The harness keeps only the strongest 8
   per repository, so put the highest-value findings first.
4. Write `report`: a concise markdown briefing for the implementation agent
   that will triage these findings — grouped by severity, one bullet per
   finding with location, what is wrong, why it matters, and the recommended
   fix. Reference findings by title. Cover only findings within the top 8.
   No preamble, no praise.

Hard rules:
- Never invent a finding, a file, a line, or evidence that no lens reported.
- Never merge distinct findings just to shorten the list.
- Emit each repository exactly as its `repo` value appears in the input.
  Never add or remove repositories.
- `lenses` may only contain lens names that appear in the input for that
  repository: code-review, bug-hunter, bird-eye, security, code-quality.
- Preserve `prior_finding_id` on any finding that carries it (an escalation of
  a previously declined finding).
- A `critical` or `high` finding must keep `file` and `line_start`; if no
  source lens grounded it, downgrade it to `medium` and say so in `body`.
- You may read repository files (checkout paths are in the brief) to decide
  whether two findings share a root cause. Read narrowly and only when the
  finding text leaves it ambiguous. Never create, edit, or delete files, and
  never run commands that change state.
- Return structured output only.
"""


class MergeFindingsAgent(DeepAgentSession[MergedFindingsOutput]):
    """Non-durable cross-lens findings merger.

    Reasons over the JSON in its brief, with read access to the repository
    checkouts so an ambiguous same-root-cause call can be settled against the
    code. Callers root it at WORKSPACE; its shell inherits no process
    environment (no credentials). It is prompt-restricted to reads — the
    harness fingerprints the working tree around the review fan-out, so a
    mutation is detected, not prevented.
    """

    def __init__(
        self,
        *,
        model: BaseChatModel,
        workspace_dir: Path,
        thread_id: str,
        durable: bool = False,
        events: RoundEvents | None,
    ) -> None:
        super().__init__(
            events=events,
            model=model,
            thread_id=thread_id,
            workspace_dir=workspace_dir,
            system_prompt=MERGE_FINDINGS_SYSTEM_PROMPT,
            response_format=ProviderStrategy(MergedFindingsOutput, strict=True),
            durable=durable,
            in_memory=False,
            inherit_env=False,
            emit_identifier="review/merge",
        )
