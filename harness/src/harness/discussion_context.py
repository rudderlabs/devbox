"""Fetch and format new GitHub PR discussion context per agent session.

The three GitHub list endpoints (issue comments, inline review comments, and
submitted-review summary bodies) each return their full set on every call, so
each fetch is authoritative. The agent runs as a long-lived, resumed session, so it
only needs the comments it has not seen yet; this helper tracks, per (PR, session)
key, which comments have already been injected and returns only the delta (the
whole discussion on a key's first round, then just what is new). Only comments
authored by a trusted-org member reach the prompt, mirroring the control-plane
trigger gate. The seen-set lives in a single workspace file keyed by PR
coordinates + session marker, so a task's several PRs coexist without wiping one
another.
"""

from __future__ import annotations

import hashlib
import os
import sys
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from harness.git import GitHubClient, parse_pr_url
from harness.paths import DISCUSSION_CONTEXT_JSON, TRUSTED_MEMBERS_JSON
from harness.util import load_json_file, write_json

Comment = dict[str, Any]

# Trust settings, all optional with no default. Comments reach the agent prompt only
# from members of ``HARNESS_TRUSTED_ORGS``, from the GitHub logins in
# ``HARNESS_TRUSTED_USERS``, or from ``HARNESS_TRUSTED_BOT_IDS``. Mirrors the
# control-plane trigger gate. With no org and no user configured, nothing is injected.
_TRUSTED_ORGS_ENV = "HARNESS_TRUSTED_ORGS"
_TRUSTED_USERS_ENV = "HARNESS_TRUSTED_USERS"
# Numeric GitHub user ids of bots (e.g. AI PR-review bots) whose PR
# comments are trusted as discussion context in addition to org members — so a
# human can point at a bot's review comment and just say "@harness fix this".
_TRUSTED_BOT_IDS_ENV = "HARNESS_TRUSTED_BOT_IDS"
# How long a fetched member list is trusted before a refetch (seconds).
_MEMBERS_TTL_SECONDS = 6 * 60 * 60
# File name of the resolved trusted-user cache, beside the member cache.
_TRUSTED_USERS_CACHE_NAME = "trusted-users.json"
# How long a stale member list may still be served while a refetch keeps failing,
# before the call fails closed. Bounds how long a removed member stays trusted.
_MEMBERS_STALE_GRACE_SECONDS = 24 * 60 * 60
# Max comments injected in one round. Bounds the first round on a large PR (empty
# seen-set → the whole trusted history) so the prompt cannot overflow the model
# context. Suppressed older comments are still marked seen (never resurface).
_MAX_INJECTED_COMMENTS = 50


def pr_coordinates_from_payload(
    pr: Mapping[str, Any] | None,
) -> tuple[str, str, int] | None:
    """Extract ``(owner, repo, pr_number)`` from an inbox PR payload.

    Current GitHub-sourced rows usually carry only ``repo`` and ``pr_url``. If a
    future payload adds explicit coordinates, prefer them; otherwise parse the
    GitHub PR URL. Malformed or incomplete payloads return ``None`` so callers can
    keep the round prompt unchanged instead of failing the inbox row.
    """
    if not isinstance(pr, Mapping):
        return None

    explicit = _explicit_coordinates(pr)
    if explicit is not None:
        return explicit

    pr_url = pr.get("pr_url")
    if isinstance(pr_url, str):
        return parse_pr_url(pr_url)
    return None


def fetch_and_store_discussion(
    owner: str,
    repo: str,
    pr_number: int,
    session_key: str,
    *,
    before: str | None = None,
    own_items: list[Comment] | None = None,
    trusted_orgs: Sequence[str] | None = None,
    trusted_users: Sequence[str] | None = None,
    client: GitHubClient | None = None,
    cache_path: Path = DISCUSSION_CONTEXT_JSON,
    members_cache_path: Path | None = None,
) -> str:
    """Fetch the PR discussion and format the comments new to ``session_key``.

    Only comments authored by a trusted actor (matched on the immutable numeric
    GitHub user id) are ever injected — this mirrors the control-plane trigger gate
    so a comment from an untrusted actor cannot reach the agent prompt as "discussion
    history". Trust is the union of the fetched members of ``trusted_orgs`` (default
    ``HARNESS_TRUSTED_ORGS``), the numeric ids of ``trusted_users`` (GitHub logins,
    default ``HARNESS_TRUSTED_USERS``, resolved with ``GET /users/{login}``) and the
    operator-configured bot ids (``HARNESS_TRUSTED_BOT_IDS``), the latter letting a
    bot reviewer's comment (an AI PR-review bot) be pointed at with a
    plain "@harness fix this". With no org and no user configured nothing is ever
    injected (and no GitHub call is made). Resolving the trusted set is required: when
    an org's members cannot be established, or no trusted id resolves at all, the
    round fails CLOSED (injects nothing) regardless of any bot ids, so an outage
    never narrows trust to the bot set alone.

    Three streams are read in full each call — issue comments
    (``/issues/{n}/comments``), inline review comments (``/pulls/{n}/comments``),
    and submitted-review summary bodies (``/pulls/{n}/reviews``) — so the fetch is
    authoritative. This lets a reviewer's un-``@mention``ed feedback (which the
    control plane never enqueues) reach the agent as history once the PR author
    later asks it to address the review. A comment's identity includes a body hash,
    so an edited comment counts as new and is re-injected, while a deleted comment
    simply drops out of the fetch and is never re-injected. Each stream's IDs come
    from an independent GitHub sequence, so comments are keyed on ``(type, id)`` for
    dedup and on ``(type, id, body)`` for the per-session seen-set — never on a
    single numeric cursor.

    The seen-set is keyed by PR coordinates *and* ``session_key``: the interactivity
    session marker is ticket-based and shared across every PR of a (possibly
    multi-repo) task, but each PR must keep its own seen-set or alternating between
    two PRs of one ticket would re-inject each PR's whole discussion every switch.

    When ``before`` (an ISO-8601 timestamp — typically the triggering comment's
    ``created_at``) is given, only comments strictly older than it are injected;
    a comment posted at or after the trigger is deferred to the round it belongs
    to. A comment with a missing/unparseable timestamp is treated as old so it is
    never silently dropped. ``own_items`` are the round's OWN items as ``{type, id,
    body}`` dicts (the triggering comment, or a submitted review's inline comments):
    they are never injected as history — the round already presents them as items to
    address — and their identities are recorded as seen. Their seen-marking is
    derived from ``own_items`` (which the handler always has), NOT from the fetch, so
    the trigger is recorded seen even when the fetch throws or a read replica has not
    yet surfaced the just-posted comment; otherwise it would resurface as history on
    a later round. When ``before`` is ``None`` there is no temporal bound. Returns an
    empty string when nothing is new, so the caller leaves the prompt unchanged.
    """
    orgs = list(trusted_orgs) if trusted_orgs is not None else _trusted_orgs()
    users = list(trusted_users) if trusted_users is not None else _trusted_users()
    if not orgs and not users:
        # Nothing is trusted, so nothing can be injected: skip every GitHub call.
        return ""
    github = client or GitHubClient()
    cache = _load_cache(cache_path)
    sessions = cache.get("sessions")
    if not isinstance(sessions, dict):
        sessions = {}
    scoped_key = f"{owner}/{repo}#{pr_number}\x1f{session_key}"
    shown = _identity_set(sessions.get(scoped_key))
    threshold = _parse_datetime(before) if isinstance(before, str) and before else None

    # Derive the round's own items' exclude keys AND seen identities from the
    # caller-supplied items — never from the fetch — so they are recorded seen even
    # when the fetch throws or a replica has not yet surfaced the just-posted trigger.
    own = own_items or []
    excluded = {_comment_key(oi) for oi in own}
    excluded_seen = [_comment_identity(oi) for oi in own]

    try:
        fetched = [
            *(
                _normalize_issue_comment(c)
                for c in github.list_issue_comments(owner, repo, pr_number)
            ),
            *(
                _normalize_review_comment(c)
                for c in github.list_pull_request_review_comments(
                    owner, repo, pr_number
                )
            ),
            *(
                _normalize_review(r)
                for r in github.list_pull_request_reviews(owner, repo, pr_number)
            ),
        ]
    except Exception:
        # Fetch failed: still persist the round's own items as seen so the trigger
        # cannot resurface as history later, then re-raise for the caller to log and
        # skip injection this round.
        if excluded_seen:
            sessions[scoped_key] = list(dict.fromkeys([*shown, *excluded_seen]))
            write_json(cache_path, {"sessions": sessions})
        raise

    deduped: dict[tuple[str, int], Comment] = {}
    for comment in fetched:
        if comment is None:
            continue
        deduped[_comment_key(comment)] = comment
    all_comments = sorted(deduped.values(), key=_sort_key)

    # Trust filter: drop comments whose author is not trusted BEFORE computing
    # injected/seen, so an untrusted author never enters the seen-set and a comment
    # is (re)considered if that author later becomes trusted. Trust = fetched
    # org-members ∪ operator-configured bot ids. Resolving the org-member set is a
    # HARD requirement: if it is unavailable we fail closed regardless of bot ids, so
    # a member-fetch outage never silently narrows trust to the bot set alone.
    members = _trusted_principal_ids(
        orgs,
        users,
        client=github,
        members_cache_path=members_cache_path
        or cache_path.parent / TRUSTED_MEMBERS_JSON.name,
    )

    if members is None:
        # Fail closed: inject nothing. Still persist the round's own excluded items
        # as seen so a trigger fired while trust was unavailable cannot resurface as
        # history once trust recovers. Do not mark any (untrusted) history comment.
        if excluded_seen:
            sessions[scoped_key] = list(dict.fromkeys([*shown, *excluded_seen]))
            write_json(cache_path, {"sessions": sessions})
        return ""
    # Bots supplement a resolved member set: static/immutable operator-set ids added
    # on top so a bot reviewer's comment is trusted alongside org members.
    trusted = members | _trusted_bot_ids()
    comments = [c for c in all_comments if c.get("author_id") in trusted]

    eligible = [
        c
        for c in comments
        if _comment_key(c) not in excluded
        and _comment_identity(c) not in shown
        and _older_than(c.get("created_at"), threshold)
    ]
    # Cap the round's volume: with an empty seen-set (first round, or first after a
    # workspace recreation) `eligible` is the whole trusted history, which can
    # overflow the model context. Inject only the most-recent K (comments are sorted
    # ascending). Suppressed older comments are still `_older_than` and so are marked
    # seen below — they never resurface.
    injected = eligible[-_MAX_INJECTED_COMMENTS:]

    # Advance the seen-set. A trusted comment is marked seen once it is already seen
    # or older than the trigger (so a capped-out older comment is still recorded);
    # comments newer than the trigger stay unseen so a later round injects them. A
    # previously-seen comment ABSENT from this fetch is retained, not pruned: a
    # transient partial/empty 200 (read-replica lag) must not drop it and cause a
    # re-injection next round. Only a live comment with the same (type, id) but a new
    # body supersedes the old identity (a genuine edit). The round's own items are
    # marked seen from `own_items` (fetch-independent).
    live_keys = {_comment_key(c) for c in comments}
    seen = [
        _comment_identity(c)
        for c in comments
        if _comment_identity(c) in shown
        or _older_than(c.get("created_at"), threshold)
        or _comment_key(c) in excluded
    ]
    seen += [s for s in shown if _key_from_identity(s) not in live_keys]
    seen += excluded_seen
    sessions[scoped_key] = list(dict.fromkeys(seen))
    write_json(cache_path, {"sessions": sessions})
    if not injected:
        return ""
    return format_discussion_context(injected)


def fetch_discussion_context_for_pr(
    pr: Mapping[str, Any] | None,
    session_key: str,
    before: str | None = None,
    own_items: list[Comment] | None = None,
) -> str:
    """Best-effort wrapper for handlers that have a raw inbox PR payload."""
    coordinates = pr_coordinates_from_payload(pr)
    if coordinates is None:
        return ""
    try:
        return fetch_and_store_discussion(
            *coordinates, session_key, before=before, own_items=own_items
        )
    except Exception as exc:
        print(
            "discussion_context: failed to fetch PR discussion "
            f"for {coordinates[0]}/{coordinates[1]}#{coordinates[2]} "
            f"(continuing without it): {type(exc).__name__}: {exc}",
            file=sys.stderr,
        )
        return ""


def format_discussion_context(comments: list[Comment]) -> str:
    lines = ["<discussion_context>", "### GitHub PR discussion history"]
    if not comments:
        lines.append("_(No GitHub PR discussion comments fetched yet.)_")
    for comment in sorted(comments, key=_sort_key):
        label = str(comment.get("type") or "comment")
        location = _comment_location(comment)
        if location:
            label = f"{label} (`{location}`)"
        author = str(comment.get("author") or "unknown")
        timestamp = _minute_timestamp(comment.get("created_at"))
        lines.append(f"- **{timestamp}** — {label} — @{author}")
        body = str(comment.get("body") or "_(no body)_")
        for body_line in body.splitlines() or ["_(no body)_"]:
            lines.append(f"  > {body_line}")
    lines.append("</discussion_context>")
    return "\n".join(lines)


def _explicit_coordinates(pr: Mapping[str, Any]) -> tuple[str, str, int] | None:
    owner = pr.get("owner")
    repo = pr.get("repo") or pr.get("repo_name")
    pr_number = pr.get("pr_number") or pr.get("number") or pr.get("pull_number")

    if not isinstance(owner, str) and isinstance(repo, str) and "/" in repo:
        owner, repo = repo.split("/", 1)
    if not isinstance(owner, str) or not isinstance(repo, str):
        return None
    number = _int_or_none(pr_number)
    if number is None:
        return None
    return owner, repo, number


def _load_cache(path: Path) -> dict[str, Any]:
    """Load the whole seen-set cache, self-healing on a missing or corrupt file.

    The file holds a single ``sessions`` map keyed by ``<coords>\\x1f<session_key>``
    (see :func:`fetch_and_store_discussion`); PR coordinates live in the key, not at
    the top level, so a task's several PRs coexist without wiping one another. A
    parse/read failure (truncated, non-UTF-8, partial write) falls back to the empty
    default — the caller's next ``write_json`` then repairs the file — instead of
    permanently disabling injection.
    """
    default: dict[str, Any] = {"sessions": {}}
    if not path.exists():
        return default
    try:
        data = load_json_file(path)
    except (OSError, ValueError):
        return default
    if not isinstance(data, dict):
        return default
    return data


def _trusted_bot_ids() -> set[int]:
    """Operator-configured numeric GitHub user ids trusted as discussion authors.

    Parsed from ``HARNESS_TRUSTED_BOT_IDS`` (comma/space-separated). These are for
    non-org bot accounts (AI PR-review bots) whose comments should reach the
    agent as context. They are static/immutable (no TTL), and supplement — never
    replace — the fetched org-member set: they are only consulted once org membership
    has been resolved (the round fails closed if it has not).
    """
    raw = os.environ.get(_TRUSTED_BOT_IDS_ENV, "")
    ids: set[int] = set()
    for tok in raw.replace(",", " ").split():
        member_id = _int_or_none(tok)
        if member_id is not None:
            ids.add(member_id)
    return ids


def _env_list(name: str) -> list[str]:
    """Comma/space-separated env var as a list; empty when unset."""
    return os.environ.get(name, "").replace(",", " ").split()


def _trusted_orgs() -> list[str]:
    """Orgs from ``HARNESS_TRUSTED_ORGS``; no default."""
    return _env_list(_TRUSTED_ORGS_ENV)


def _trusted_users() -> list[str]:
    """GitHub logins from ``HARNESS_TRUSTED_USERS``; no default."""
    return _env_list(_TRUSTED_USERS_ENV)


def _trusted_principal_ids(
    orgs: Sequence[str],
    users: Sequence[str],
    *,
    client: GitHubClient,
    members_cache_path: Path,
) -> set[int] | None:
    """Numeric ids of every member of ``orgs`` plus every resolvable ``users`` login.

    ``None`` (fail closed) when any org's member set cannot be established, or when
    nothing at all resolved. An unresolvable user login only leaves that user
    untrusted. Each org and the users have their own TTL cache beside
    ``members_cache_path``.
    """
    ids: set[int] = set()
    for org in orgs:
        org_ids = _trusted_member_ids(
            org,
            client=client,
            cache_path=_org_cache_path(members_cache_path, org),
        )
        if org_ids is None:
            return None
        ids |= org_ids
    users_cache_path = members_cache_path.with_name(_TRUSTED_USERS_CACHE_NAME)
    for login in users:
        user_id = _trusted_user_id(login, client=client, cache_path=users_cache_path)
        if user_id is not None:
            ids.add(user_id)
    if not ids:
        print(
            "discussion_context: no trusted user resolved — failing closed "
            "(injecting no PR discussion).",
            file=sys.stderr,
        )
        return None
    return ids


def _org_cache_path(base: Path, org: str) -> Path:
    """Per-org member cache file beside ``base`` (one org per file)."""
    safe = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in org)
    return base.with_name(f"{base.stem}.{safe}{base.suffix}")


def _trusted_user_id(
    login: str,
    *,
    client: GitHubClient,
    cache_path: Path,
    now: datetime | None = None,
) -> int | None:
    """Numeric id for a trusted GitHub login, cached with the org-member TTL.

    The cache file maps lower-cased login to ``{"id", "fetched_at"}``. A fresh entry
    is served without a lookup. When the lookup fails (unknown login, outage), a
    stale entry is served only within the same bounded grace window as the org
    members, then ``None`` is returned and the user stays untrusted.
    """
    now = now or datetime.now(UTC)
    key = login.lower()
    cached = _load_member_cache(cache_path) or {}
    users = cached.get("users")
    users = users if isinstance(users, dict) else {}
    entry = users.get(key)
    entry = entry if isinstance(entry, dict) else None
    entry_id = entry.get("id") if entry else None
    cached_id = entry_id if isinstance(entry_id, int) else None
    age = _cache_age(entry, now) if entry and cached_id is not None else None

    if (
        cached_id is not None
        and age is not None
        and age < timedelta(seconds=_MEMBERS_TTL_SECONDS)
    ):
        return cached_id

    try:
        user = client.get_user(login)
        user_id = _int_or_none(user.get("id"))
    except Exception as exc:
        print(
            f"discussion_context: could not resolve trusted user ({type(exc).__name__})",
            file=sys.stderr,
        )
        user_id = None

    if user_id is None:
        if (
            cached_id is not None
            and age is not None
            and age < timedelta(seconds=_MEMBERS_STALE_GRACE_SECONDS)
        ):
            return cached_id
        return None

    users[key] = {"id": user_id, "fetched_at": now.isoformat()}
    write_json(cache_path, {"users": users})
    return user_id


def _trusted_member_ids(
    org: str,
    *,
    client: GitHubClient,
    cache_path: Path,
    now: datetime | None = None,
) -> set[int] | None:
    """Numeric ids of ``org``'s members, cached in ``cache_path`` with a TTL.

    Returns ``None`` when the set cannot be established (fetch failed and no
    usable cache, or the fetch returned empty — a scope-deficient token or wrong
    org). Callers fail closed on ``None``: no comment is injected when trust
    cannot be verified. A rename-proof numeric-id set mirrors the control plane.

    A fresh cache (age within the TTL) is served without a refetch. When the fetch
    fails, a stale cache is served only within a bounded grace window and then the
    call fails closed, so a removed member cannot stay trusted indefinitely. A
    missing/unparseable/future ``fetched_at`` counts as no usable age (forces a
    refetch) rather than pinning the cache "fresh" forever.
    """
    now = now or datetime.now(UTC)
    cached = _load_member_cache(cache_path)
    same_org = cached is not None and cached.get("org") == org
    cached_ids = _cached_member_ids(cached) if same_org else set()
    age = _cache_age(cached, now) if same_org else None

    if cached_ids and age is not None and age < timedelta(seconds=_MEMBERS_TTL_SECONDS):
        return cached_ids

    try:
        members = client.list_org_members(org)
    except Exception as exc:
        print(
            "discussion_context: could not fetch trusted org members "
            f"({type(exc).__name__})",
            file=sys.stderr,
        )
        members = None

    ids = (
        {mid for m in members if (mid := _int_or_none(m.get("id"))) is not None}
        if members is not None
        else set()
    )
    if not ids:
        # Empty is a failure signal, not "no one is trusted". Serve a stale cache
        # only within the grace window; past it, fail closed so a removed member is
        # dropped within a bounded, documented horizon.
        if (
            cached_ids
            and age is not None
            and age < timedelta(seconds=_MEMBERS_STALE_GRACE_SECONDS)
        ):
            print(
                "discussion_context: serving stale trusted org members "
                f"(age {age}, fetch failing)",
                file=sys.stderr,
            )
            return cached_ids
        print(
            "discussion_context: no trusted org members resolved — failing "
            "closed (injecting no PR discussion). Does the token have read:org?",
            file=sys.stderr,
        )
        return None

    write_json(
        cache_path,
        {"org": org, "member_ids": sorted(ids), "fetched_at": now.isoformat()},
    )
    return ids


def _cached_member_ids(cached: Mapping[str, Any] | None) -> set[int]:
    """Numeric ids from a member cache, tolerant of a missing/non-list field."""
    raw = cached.get("member_ids") if cached else None
    if not isinstance(raw, list):
        return set()
    return {i for i in raw if isinstance(i, int)}


def _cache_age(cached: Mapping[str, Any], now: datetime) -> timedelta | None:
    """Age of a member cache, or None if ``fetched_at`` is missing/unparseable/future.

    ``_parse_datetime`` maps a missing/blank/non-ISO timestamp to ``datetime.max``;
    a future timestamp (write-time clock skew later corrected back) yields a
    negative age. Both must count as "no usable age" so freshness/grace checks
    force a refetch instead of trusting a pinned-forever cache.
    """
    parsed = _parse_datetime(cached.get("fetched_at"))
    if parsed == datetime.max.replace(tzinfo=UTC):
        return None
    age = now - parsed
    return age if age >= timedelta(0) else None


def _load_member_cache(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        data = load_json_file(path)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _comment_key(comment: Mapping[str, Any]) -> tuple[str, int]:
    """Dedup/exclusion key: ``(type, id)`` — never collapses the id streams."""
    return (str(comment.get("type") or "comment"), _int_or_zero(comment.get("id")))


def _comment_identity(comment: Mapping[str, Any]) -> str:
    """Stable identity for a comment, including a body hash so edits count as new."""
    ctype = str(comment.get("type") or "comment")
    cid = _int_or_zero(comment.get("id"))
    body = str(comment.get("body") or "")
    digest = hashlib.sha1(body.encode("utf-8")).hexdigest()[:12]
    return f"{ctype}:{cid}:{digest}"


def _key_from_identity(identity: str) -> tuple[str, int]:
    """Recover the ``(type, id)`` key embedded in a stored identity string.

    An identity is ``"{type}:{id}:{digest}"``; type carries no colon. A malformed
    stored value maps to ``("", 0)`` so it never matches a live key (retained,
    which is the safe direction for the transient-absence carry-forward).
    """
    parts = identity.split(":")
    if len(parts) >= 3 and (cid := _int_or_none(parts[1])) is not None:
        return (parts[0], cid)
    return ("", 0)


def _identity_set(value: Any) -> set[str]:
    if not isinstance(value, list):
        return set()
    return {item for item in value if isinstance(item, str)}


def _normalize_issue_comment(raw: Mapping[str, Any]) -> Comment | None:
    comment_id = _int_or_none(raw.get("id"))
    if comment_id is None:
        return None
    return {
        "id": comment_id,
        "type": "issue_comment",
        "author": _author(raw),
        "author_id": _author_id(raw),
        "created_at": str(raw.get("created_at") or ""),
        "body": str(raw.get("body") or ""),
    }


def _normalize_review_comment(raw: Mapping[str, Any]) -> Comment | None:
    comment_id = _int_or_none(raw.get("id"))
    if comment_id is None:
        return None
    normalized: Comment = {
        "id": comment_id,
        "type": "review_comment",
        "author": _author(raw),
        "author_id": _author_id(raw),
        "created_at": str(raw.get("created_at") or ""),
        "body": str(raw.get("body") or ""),
    }
    path = raw.get("path")
    if isinstance(path, str) and path:
        normalized["path"] = path
    line = _int_or_none(raw.get("line")) or _int_or_none(raw.get("original_line"))
    if line is not None:
        normalized["line"] = line
    return normalized


def _normalize_review(raw: Mapping[str, Any]) -> Comment | None:
    """A submitted review's *summary body* (``/pulls/{n}/reviews``).

    Distinct ``type="review"`` so its id never collides with a review_comment id
    (separate GitHub sequences). Uses ``submitted_at`` as the temporal field.
    A review with an empty body (e.g. a bare approve) carries nothing to inject
    and is dropped.
    """
    review_id = _int_or_none(raw.get("id"))
    if review_id is None:
        return None
    body = str(raw.get("body") or "")
    if not body.strip():
        return None
    return {
        "id": review_id,
        "type": "review",
        "author": _author(raw),
        "author_id": _author_id(raw),
        "created_at": str(raw.get("submitted_at") or ""),
        "body": body,
    }


def _author(raw: Mapping[str, Any]) -> str:
    user = raw.get("user")
    if isinstance(user, Mapping):
        login = user.get("login")
        if isinstance(login, str) and login:
            return login
    return "unknown"


def _author_id(raw: Mapping[str, Any]) -> int | None:
    """The comment author's immutable numeric GitHub user id, or None."""
    user = raw.get("user")
    if isinstance(user, Mapping):
        return _int_or_none(user.get("id"))
    return None


def _comment_location(comment: Mapping[str, Any]) -> str:
    path = comment.get("path")
    line = comment.get("line")
    if isinstance(path, str) and path and isinstance(line, int):
        return f"{path}:{line}"
    if isinstance(path, str) and path:
        return path
    return ""


def _sort_key(comment: Mapping[str, Any]) -> tuple[datetime, int]:
    return (_parse_datetime(comment.get("created_at")), _int_or_zero(comment.get("id")))


def _minute_timestamp(value: Any) -> str:
    if not isinstance(value, str) or not value:
        return "unknown time"
    parsed = _parse_datetime(value)
    if parsed == datetime.max.replace(tzinfo=UTC):
        return value
    return parsed.isoformat(timespec="minutes").replace("+00:00", "Z")


def _older_than(created_at: Any, threshold: datetime | None) -> bool:
    """True if a comment is old enough to inject now (older than the trigger).

    ``threshold`` of ``None`` means no temporal bound (everything qualifies). A
    missing or unparseable timestamp is treated as old so the comment is injected
    rather than deferred forever.
    """
    if threshold is None:
        return True
    parsed = _parse_datetime(created_at)
    if parsed == datetime.max.replace(tzinfo=UTC):
        return True
    return parsed < threshold


def _parse_datetime(value: Any) -> datetime:
    if not isinstance(value, str) or not value:
        return datetime.max.replace(tzinfo=UTC)
    try:
        normalized = value.replace("Z", "+00:00")
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return datetime.max.replace(tzinfo=UTC)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _int_or_none(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return None
    return None


def _int_or_zero(value: Any) -> int:
    return _int_or_none(value) or 0
