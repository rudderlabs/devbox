FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 AS runtime
WORKDIR /app
ENV NODE_ENV=production

# kubectl is required at runtime: src/clients/k8s.ts shells out to it for
# VolumeSnapshot/PVC operations because Bun's node:https mTLS path is broken
# (oven-sh/bun#21643). In-cluster auth uses the SA token mounted by k8s, so
# kubectl works without extra config. Pinned to track recent Kubernetes minors.
#
# SHA256s are pinned in the Dockerfile (not fetched at build time) so a
# compromised dl.k8s.io mirror can't serve a matching binary+sha pair. When
# bumping KUBECTL_VERSION, update both digests from the upstream
# kubectl.sha256 files for each arch.
ARG KUBECTL_VERSION=v1.37.1
ARG KUBECTL_SHA256_AMD64=65691ff77eb6fa44c908b77a1082c9f092c3b9733b5cefabec0d1104890e21a8
ARG KUBECTL_SHA256_ARM64=ff749f4b78d9c4f1ec87307df9b50119ed819e2094aa9810cb9acffc3286c8c7
# git and openssl: the chart's snapshot builder and bootstrap Job run in this image.
# The upgrade picks up Debian security fixes newer than the pinned base digest.
RUN set -eux \
  && apt-get update \
  && apt-get upgrade -y \
  && apt-get install -y --no-install-recommends curl ca-certificates git openssl \
  && apt-mark manual ca-certificates git openssl \
  && arch="$(dpkg --print-architecture)" \
  && case "${arch}" in \
       amd64) expected="${KUBECTL_SHA256_AMD64}" ;; \
       arm64) expected="${KUBECTL_SHA256_ARM64}" ;; \
       *) echo "unsupported arch: ${arch}" >&2; exit 1 ;; \
     esac \
  && curl -fsSLo /usr/local/bin/kubectl \
       "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${arch}/kubectl" \
  && echo "${expected}  /usr/local/bin/kubectl" | sha256sum -c - \
  && chmod +x /usr/local/bin/kubectl \
  && kubectl version --client \
  && apt-get purge -y curl \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY --chown=bun:bun package.json bun.lock ./
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun scripts ./scripts
COPY --chown=bun:bun drizzle ./drizzle

USER bun
EXPOSE 3000
CMD ["bun", "run", "start"]
