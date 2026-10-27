# Extending the harness image

Each sandbox runs the harness image, `rudderlabs/devbox-harness`. It
has Python with `uv` (no system `pip`; `python -m venv` still provides one),
Node.js 24 with pnpm and yarn, Bun, native Go 1.27.3, a C/C++ toolchain
(`build-essential`), `git`, `gh`, `jq`, `make` and `ripgrep`. If your repos
need more, such as a JDK, build an image on top of it.

Sandboxes reach only GitHub and the LLM host, so the agent cannot download
tools or packages from other hosts while it works. Bake them into the image.
`ironProxy.extraAllowlist` can open more hosts through iron-proxy (rules of
`{host, methods, paths}`), but each one widens what a sandbox can reach.

## Build and push

[examples/Dockerfile.harness](examples/Dockerfile.harness) adds a JDK and
Maven:

```dockerfile
ARG DEVBOX_VERSION=0.1.0
FROM rudderlabs/devbox-harness:${DEVBOX_VERSION}
RUN apt-get update \
    && apt-get install -y --no-install-recommends openjdk-17-jdk-headless maven \
    && rm -rf /var/lib/apt/lists/*
```

```bash
docker build -f docs/kubernetes/examples/Dockerfile.harness -t <registry>/devbox-harness-java:0.1.0 .
docker push <registry>/devbox-harness-java:0.1.0
```

Build for your nodes' architecture (`docker buildx build --platform …`).

## Use it

```yaml
images:
  harness: <registry>/devbox-harness-java
sandbox:
  imagePullSecrets: [{ name: <pull-secret> }]   # for a private registry
```

- `images.tag` is the tag of both devbox images, the control plane's and the
  harness's, and defaults to the chart's `appVersion`. Tag your image with the same
  version, and build it again on every devbox upgrade.
- `sandbox.imagePullSecrets` names Secrets in the `devbox-sandboxes`
  namespace:

  ```bash
  kubectl -n devbox-sandboxes create secret docker-registry <pull-secret> \
    --docker-server=<registry> --docker-username=<user> --docker-password=<password>
  ```

Run the installer again, or apply the chart with GitOps. New sandboxes use the
image; running ones keep theirs until they stop.

## The compatibility contract

An image works as a harness image if it keeps what the base image provides:

- **The entrypoint.** The control plane starts every sandbox with
  `/usr/local/bin/harness-entrypoint`, whatever the image's own `ENTRYPOINT`.
  It runs `/usr/local/bin/bootstrap`, then the harness daemon. Keep both, and
  the harness in `/opt/harness`.
- **`bootstrap.sh` (installed as `/usr/local/bin/bootstrap`).** On Kubernetes
  the control plane sets `IRON_PROXY_EGRESS=true`. bootstrap then adds the
  iron-proxy CA to the system trust store (`update-ca-certificates`) and makes
  `git` use HTTPS with a dummy token for `github.com`, which iron-proxy swaps
  for the real one. It needs `bash`, `git`, `base64` and
  `update-ca-certificates`.
- **The CA at `/run/iron-proxy/ca.crt`.** The sandbox pod mounts it there. The
  control plane also sets `NODE_EXTRA_CA_CERTS=/run/iron-proxy/ca.crt` and
  points `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE` and `CURL_CA_BUNDLE` at the
  system bundle. Tools you add must trust the system bundle or one of these.
  A tool with its own trust store needs the CA added at start; Debian's JDK
  packages pick it up through `update-ca-certificates`.
- **`/workspace`.** The task's volume is mounted there, with each repo at
  `/workspace/<repo>`. Anything the image puts in `/workspace` is hidden.
- **Root.** The sandbox runs as root, so bootstrap can change the trust store.
  Do not add a `USER`.
