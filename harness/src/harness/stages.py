"""Pipeline stage identifiers for harness orchestration."""

from enum import StrEnum


class Stage(StrEnum):
    PLANNING = "planning"
    IMPLEMENTATION = "implementation"
    DISTILLATION = "distillation"
    REVIEW = "review"
    REVIEW_FIX = "review-fix"
    COMMENT = "comment"
    USER_REVIEW = "user-review"
    CI = "ci"
    COMMIT = "commit"
