# Contributing to devbox

Thanks for taking the time and for your help in improving this project!

## Table of contents

- [Reporting issues](#reporting-issues)
- [Submitting a pull request](#submitting-a-pull-request)
- [Running the tests and lint](#running-the-tests-and-lint)

## Reporting issues

If you encounter a bug or have an improvement suggestion, [**submit an issue**][issue] describing it.
Report security issues as described in [SECURITY.md](SECURITY.md), not as issues.
For questions and ideas, use [Discussions][discussions].

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).

## Submitting a pull request

Keep a pull request to one change. Before you open it, run the tests and lint of
every component you changed (below). CI runs equivalent checks for each
component whose files changed.

We prefer squash or rebase commits so that all changes from a branch are
committed to `main` as a single commit. All pull requests are squashed when
merged, but rebasing prior to merge gives you better control over the commit
message.

## Running the tests and lint

The repo has three components. Each has its own tools, and you run its commands
from its own directory.

### `harness/` (Python)

Needs [uv](https://docs.astral.sh/uv/). uv installs the Python version in
`harness/.python-version`.

```bash
cd harness
make setup   # once: creates .venv and installs the dependencies
make test
make lint
```

### `control-plane/` (Bun)

Needs Bun 1.4.4 or newer. Some tests need a Postgres 18 database. They read its
URL from `TEST_DATABASE_URL`, and default to
`postgres://devbox:devbox@localhost:5432/devbox`.

Use a database of its own for the tests, not the one `bun run up` starts. For
example, a throwaway container on port 5433:

```bash
docker run -d --name devbox-test-pg -p 127.0.0.1:5433:5432 \
  -e POSTGRES_USER=devbox -e POSTGRES_PASSWORD=devbox -e POSTGRES_DB=devbox \
  postgres:18
```

Then:

```bash
cd control-plane
bun install
bun run biome:ci
bun run typecheck
TEST_DATABASE_URL=postgres://devbox:devbox@localhost:5433/devbox bun test
```

`bun run format` fixes the formatting that `biome:ci` reports.

### `cli/` (Bun)

```bash
cd cli
bun install
bun run typecheck
bun test
```

### All tests at once

`bun run test` at the repo root runs the tests of all three components. It
needs the setup above: `make setup`, `bun install` in `control-plane/` and
`cli/`, and a test database. `bun run setup` at the repo root checks the Bun
version and does both `bun install` steps. `bun run up` runs it first.

<!----variables---->

[issue]: https://github.com/rudderlabs/devbox/issues/new/choose
[discussions]: https://github.com/rudderlabs/devbox/discussions
