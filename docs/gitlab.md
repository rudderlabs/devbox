# GitLab

devbox can work on repos hosted on a GitLab instance: self-managed, or
`https://gitlab.com`. The agent clones from it, pushes its branch and opens a
**draft merge request**, the way it opens a draft pull request on GitHub. A
deployment may mix GitHub and GitLab repos; each repo's host is read from its
URL.

This is the outbound half. Nothing comes back from GitLab yet: no merge
request comments, reviews or pipeline results reach the running task, and
there is no `@mention` trigger. Those are tracked in
[rudderlabs/devbox#8](https://github.com/rudderlabs/devbox/issues/8).
Kubernetes only: the local Compose stack takes GitHub repos.

## What you need

- **A GitHub token as well.** GitLab is added beside GitHub, not instead of
  it: the egress proxy and the snapshot builder read the GitHub token Secret
  unconditionally, so a deployment with only GitLab repos still needs a GitHub
  token (any account's, with no repos to reach) or the GitHub App. Making it
  optional is tracked in [rudderlabs/devbox#8](https://github.com/rudderlabs/devbox/issues/8).
- **A group or project access token** for the group that holds the repos,
  with the `api`, `read_repository` and `write_repository` scopes and at least
  the Developer role. Merge requests and commits are attributed to the token's
  bot user. The token does not rotate itself: set an expiry you can live with
  and replace it in the Secret before then.
- **The instance's URL** as `gitlab.baseUrl`: `https://gitlab.example.com`,
  or with a relative URL root `https://example.com/gitlab`. The default port
  only, like `llm.baseUrl`, because the egress proxy intercepts only 80 and
  443.
- **A private CA, if the instance has one.** Put the CA certificate (PEM, the
  chain if there is one) in a Secret and name it in `ironProxy.caBundle`. Only
  the egress proxy talks to GitLab directly; sandboxes see the proxy's own
  certificate and need nothing.

## Configure

1. Create the token Secret in the `devbox` namespace. The chart never creates
   it and the installer does not ask for it.

   ```bash
   kubectl -n devbox create secret generic devbox-gitlab --from-literal=token="$GITLAB_TOKEN"
   # With a private CA:
   kubectl -n devbox create secret generic gitlab-ca --from-file=ca.crt=./gitlab-ca.pem
   ```

2. Put the instance and the repos in `devbox.config.json`:

   ```json
   {
     "gitlab": { "baseUrl": "https://gitlab.example.com" },
     "repos": [
       { "url": "https://github.com/acme/widgets.git", "branch": "main" },
       { "url": "https://gitlab.example.com/platform/backend/api.git", "branch": "develop" }
     ]
   }
   ```

   A GitLab repo is `<gitlab.baseUrl>/<group>[/<subgroup>...]/<project>.git`.
   Nested groups are fine. Repo names (the last path segment) must be unique
   across both hosts, because each is cloned to `/workspace/<name>`.

3. Name the Secret, and the CA bundle if any, in the target file's values:

   ```yaml
   secrets: { gitlab: { existingSecret: devbox-gitlab } }
   ironProxy: { caBundle: gitlab-ca }   # only with a private CA
   ```

4. `bun run k8s:install --target <file>` as usual. With GitOps, set
   `gitlab.baseUrl`, `repos`, `secrets.gitlab.existingSecret` and
   `ironProxy.caBundle` directly ([values](../deploy/helm/devbox/README.md)).

The GitHub checks the installer runs (token, push access) cover the GitHub
repos only; there is no GitLab preflight yet. A wrong token shows on the first
task, as a failed push or merge request.

## How it works

- **Clones** come from the snapshot builder, which reads the token from the
  Secret and sends it as a Basic credential on `http.<gitlab.baseUrl>/`
  only, through `GIT_CONFIG_*` env, so no token lands in a `.git/config`.
- **Pushes and the API** go through iron-proxy. Sandboxes hold a placeholder
  (`proxy-gitlab-dummy-token`) that the proxy swaps for the real token on the
  `Authorization` header for that one host. The allowlist admits each
  configured project's git paths and its `/api/v4/projects/<group>/<project>`
  routes, nothing else on the instance.
- **The harness** picks a client per repo from its remote: GitHub for
  github.com, GitLab for a remote under `gitlab.baseUrl`
  (`harness/src/harness/codehost.py`). The merge request's `web_url` is what
  the task records as its PR URL.

## Versions and editions

Any GitLab that serves REST API v4 and smart-HTTP git works for this half:
every call used (project, branch, merge request create and list) predates
GitLab 10. Drafts are the `Draft:` title prefix. The Free tier is enough.
