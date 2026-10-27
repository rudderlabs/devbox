# syntax=docker/dockerfile:1
# uv binary (digest-pinned)
FROM ghcr.io/astral-sh/uv:0.13.6@sha256:af22a52f5eafef3d78e551599d405c02df61919d18028f0cea8eda93bc9986d0 AS uv

# Slim base: the full image's -dev libraries and desktop packages carried most
# of the image's OS findings. Everything the sandbox needs is listed below.
FROM python:3.14-slim-trixie@sha256:0514bc76712d64f8bb48adcb95b1ab0d88c69fee95d62fe4c18ee948bee9b1e1 AS runtime

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    WORKSPACE=/workspace \
    DEVBOX_SCRIPTS_DIR=/opt/harness/scripts

# build-essential keeps the compiler the full image shipped: agents build
# arbitrary repositories here (cgo, node-gyp, native Python wheels). The
# upgrade picks up Debian security fixes newer than the pinned base digest.
RUN apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        curl \
        git \
        gnupg \
        jq \
        less \
        make \
        openssh-client \
        procps \
        ripgrep \
        tini \
        tzdata \
        unzip \
        xz-utils \
    && rm -rf /var/lib/apt/lists/*

# No system pip: the harness installs with uv, sandboxes cannot reach PyPI, and
# pip's vendored dependencies carry High CVEs that no pip release has fixed.
# ensurepip stays, so `python -m venv` still creates environments with pip.
RUN python -m pip uninstall -y pip \
    && python -c "import ensurepip"

# GitHub CLI v2.103.0 (pinned, checksum-verified).
RUN ARCH="$(dpkg --print-architecture)" \
    && case "${ARCH}" in \
        amd64) GH_SHA="fdd768eb70f6409f80fcfa9f3a1c0adf0fc98d827ab3ce0bed2ac22762c5d786" ;; \
        arm64) GH_SHA="7f322df34e624d14f5ec0c4acb121fd6dfa14392fdbbd1066aa8e0a05ac3721e" ;; \
        *) echo "Unsupported architecture: ${ARCH}" >&2; exit 1 ;; \
    esac \
    && GH_VERSION="2.103.0" \
    && GH_TGZ="gh_${GH_VERSION}_linux_${ARCH}.tar.gz" \
    && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/${GH_TGZ}" \
        -o "/tmp/${GH_TGZ}" \
    && echo "${GH_SHA}  /tmp/${GH_TGZ}" | sha256sum -c - \
    && tar -xzf "/tmp/${GH_TGZ}" -C /tmp \
    && install -m 0755 "/tmp/gh_${GH_VERSION}_linux_${ARCH}/bin/gh" /usr/local/bin/gh \
    && rm -rf "/tmp/${GH_TGZ}" "/tmp/gh_${GH_VERSION}_linux_${ARCH}"

# Go v1.27.3 (official tarball, pinned and checksum-verified).
RUN ARCH="$(dpkg --print-architecture)" \
    && case "${ARCH}" in \
        amd64) GO_SHA="65efbc80fdc1fa2cd2631cad5b481777a68e8725f34e89f50fc6ac714e379b40" ;; \
        arm64) GO_SHA="a06e99309dbcbdca1a8ccd2282c3ee146e55930886e26b4f1193269587165f49" ;; \
        *) echo "Unsupported architecture: ${ARCH}" >&2; exit 1 ;; \
    esac \
    && GO_VERSION="1.27.3" \
    && GO_TGZ="go${GO_VERSION}.linux-${ARCH}.tar.gz" \
    && curl -fsSL "https://go.dev/dl/${GO_TGZ}" -o "/tmp/${GO_TGZ}" \
    && echo "${GO_SHA}  /tmp/${GO_TGZ}" | sha256sum -c - \
    && tar -xzf "/tmp/${GO_TGZ}" -C /usr/local \
    && rm -f "/tmp/${GO_TGZ}"

ENV PATH="/usr/local/go/bin:${PATH}"

# Node.js v24.22.1 LTS (official tarball, pinned and checksum-verified) with
# corepack, which provides the pnpm and yarn shims. Installed under
# /usr/local so `node` resolves on a bare Debian PATH, including the agent's
# tool-call shell.
#
# npm is upgraded past the release bundled with Node: the bundled one vendors
# brace-expansion and undici versions with High CVEs.
#
# Corepack's activated pnpm is ONE HOME-wide "last known good" value. It stays
# on pnpm 10, the major agents used before the move off Node 20; repos that
# pin `packageManager` in package.json still override this default.
RUN ARCH="$(dpkg --print-architecture)" \
    && case "${ARCH}" in \
        amd64) NODE_ARCH="x64"; NODE_SHA="6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6" ;; \
        arm64) NODE_ARCH="arm64"; NODE_SHA="dbabf7a1cbf947e6059ffad2c27b80041db97dea1e553b62afdee7f13fca336e" ;; \
        *) echo "Unsupported architecture: ${ARCH}" >&2; exit 1 ;; \
    esac \
    && NODE_VERSION="24.22.1" \
    && NODE_TAR="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" \
    && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TAR}" -o "/tmp/${NODE_TAR}" \
    && echo "${NODE_SHA}  /tmp/${NODE_TAR}" | sha256sum -c - \
    && tar -xJf "/tmp/${NODE_TAR}" -C /usr/local --strip-components=1 --no-same-owner \
        --exclude='*/CHANGELOG.md' --exclude='*/README.md' --exclude='*/LICENSE' \
    && rm -f "/tmp/${NODE_TAR}" \
    && npm install -g npm@11.21.1 \
    && corepack enable \
    && corepack prepare pnpm@10 --activate \
    && npm cache clean --force

# Bun v1.4.4 (pinned, checksum-verified against the release's signed SHASUMS256.txt).
RUN ARCH="$(dpkg --print-architecture)" \
    && case "${ARCH}" in \
        amd64) BUN_ARCH="x64"; BUN_SHA="bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c" ;; \
        arm64) BUN_ARCH="aarch64"; BUN_SHA="baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e" ;; \
        *) echo "Unsupported architecture: ${ARCH}" >&2; exit 1 ;; \
    esac \
    && BUN_VERSION="1.4.4" \
    && BUN_ZIP="bun-linux-${BUN_ARCH}.zip" \
    && curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${BUN_ZIP}" \
        -o "/tmp/${BUN_ZIP}" \
    && echo "${BUN_SHA}  /tmp/${BUN_ZIP}" | sha256sum -c - \
    && unzip -q "/tmp/${BUN_ZIP}" -d /tmp/bun \
    && install -m 0755 "/tmp/bun/bun-linux-${BUN_ARCH}/bun" /usr/local/bin/bun \
    && ln -s /usr/local/bin/bun /usr/local/bin/bunx \
    && rm -rf "/tmp/${BUN_ZIP}" /tmp/bun

# Create runtime directories and a non-root user.
RUN groupadd --system --gid 10001 harness \
    && useradd --system --uid 10001 --gid harness --create-home --home-dir /home/harness harness \
    && mkdir -p /opt/harness /workspace \
    && chown -R harness:harness /home/harness /workspace

COPY --from=uv /uv /uvx /usr/local/bin/

WORKDIR /opt/harness
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/harness/.venv

COPY pyproject.toml uv.lock README.md /opt/harness/
RUN uv sync --frozen --no-install-project --no-dev

# Copy the whole src/ package and install it (+ the `harness` console script)
# into the venv. The dependency layer above stays cached; editing package source
# only invalidates from here down.
COPY --link src/ /opt/harness/src/
RUN uv sync --frozen --no-dev

# The `harness` console script lands in the venv bin, but the agent's tool-call
# shell may run with a reduced PATH that omits /opt/harness/.venv/bin. Without
# this, the agent's `harness ...` calls fail with "command not found". Symlink it onto /usr/local/bin, which IS on that shell's PATH.
RUN ln -sf /opt/harness/.venv/bin/harness /usr/local/bin/harness

# Harness helper scripts import the installed `harness` package;
# SCRIPTS_DIR resolves to /opt/harness/scripts via the DEVBOX_SCRIPTS_DIR env
# (PACKAGE_DIR now points at the installed package, not /opt/harness).
COPY --link scripts/ /opt/harness/scripts/.
COPY --link scripts/bootstrap.sh /usr/local/bin/bootstrap
COPY --link scripts/harness-entrypoint.sh /usr/local/bin/harness-entrypoint
RUN chmod 0755 /opt/harness/scripts/*.py \
        /usr/local/bin/bootstrap \
        /usr/local/bin/harness-entrypoint \
    && chown -R harness:harness /opt/harness

ENV PATH="/opt/harness/.venv/bin:$PATH"

# Runs as root so the bootstrap script can install the egress proxy CA into the
# system trust store when the container starts.
WORKDIR /workspace

ENTRYPOINT ["/usr/bin/tini", "-g", "--", "sleep", "infinity"]
