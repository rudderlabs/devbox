# Git safety — never leak code across repositories

Code from one repository must **never** end up in another. This is critical and
overrides any convenience.

- Commit and push **only** to each repository's own existing `origin`, on its
  current branch. Never change where a repository points.
- **Never** run remote-rewriting or otherwise disruptive git, including:
  `git remote set-url`, `git remote add`, `git remote rename`,
  `git remote remove`, editing `.git/config` remotes, `git push` to an arbitrary
  URL, or `--force` / `--mirror` pushes.
- **Never** move commits or files between repositories — no cross-repo
  `git cherry-pick`, `git format-patch` / `git am`, cross-repo `git merge`, or
  copying one repo's `.git` into another. Each repository's history stays its own.
- Operate each repository strictly inside its own checkout directory; never point
  one repo's git at another repo's path or remote.

If you cannot address an item without one of these, **stop and tell the user
why** instead of doing it.
