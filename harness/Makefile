UV ?= uv
VENV ?= .venv
PYTHON ?= python3
DOCKER ?= docker
IMAGE ?= devbox-dev
# Override in CI, e.g. TAG=$(git rev-parse --short HEAD)
TAG ?= latest

.PHONY: setup test lint build
setup:
	$(UV) venv $(VENV) --clear
	$(UV) sync

test:
	$(UV) run $(PYTHON) -m unittest discover -s tests -t . -p "test_*.py" -v

lint:
	$(UV) run ruff check .
	$(UV) run ruff format --check .

# Commit identity for the local layer below.
LOCAL_GIT_NAME ?= harness-local
LOCAL_GIT_EMAIL ?= harness-local@users.noreply.github.com

# Local OpenSandbox stack only: IRON_PROXY_CA=<path/to/ca.crt> layers onto the
# image the iron-proxy CA, the egress env and a git identity. Honoured only on
# the command line, so a stray exported IRON_PROXY_CA can't leak the local CA into a CI
# build, and tagged $(IMAGE):local so it is never mistaken for the plain image.
build:
	$(DOCKER) build -t $(IMAGE):$(TAG) .
ifeq ($(origin IRON_PROXY_CA),command line)
	printf '%s\n' 'FROM $(IMAGE):$(TAG)' \
	  'COPY $(notdir $(IRON_PROXY_CA)) /run/iron-proxy/ca.crt' \
	  'ENV IRON_PROXY_EGRESS=true' \
	  'ENV NODE_EXTRA_CA_CERTS=/run/iron-proxy/ca.crt SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt CURL_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt' \
	  'ENV GIT_AUTHOR_NAME="$(LOCAL_GIT_NAME)" GIT_AUTHOR_EMAIL="$(LOCAL_GIT_EMAIL)" GIT_COMMITTER_NAME="$(LOCAL_GIT_NAME)" GIT_COMMITTER_EMAIL="$(LOCAL_GIT_EMAIL)"' \
	  | $(DOCKER) build -t $(IMAGE):local -f - $(dir $(IRON_PROXY_CA))
endif
