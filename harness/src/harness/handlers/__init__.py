"""Per-`kind` inbox handlers — one file per inbox row `kind`.

The daemon's `process_one_inbox_file` dispatcher reads an inbox row's `kind`
field and delegates to the matching handler in this package: `assignment`
(`handlers/assignment.py`), `comment` (`handlers/comment.py`), `review`
(`handlers/user_review.py`).
"""
