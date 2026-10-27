# Secrets on Kubernetes

The chart reads every secret from a Kubernetes Secret in the `devbox`
namespace, with a fixed name and key. Secrets never pass as Helm values: they
would stay in Helm's release history.

## The contract

| Secret | Key | Used by | Created by |
|---|---|---|---|
| `devbox-github`, or `secrets.github.existingSecret` | `token` (the minter also writes `expires-at`) | iron-proxy (sandboxes' GitHub requests), the control plane (its own GitHub calls), the snapshot builder (clones) | the installer, or you; with the GitHub App's devbox tokens, the minter keeps it fresh |
| `devbox-github-app`, or `secrets.githubApp.existingSecret` | `private-key` | the GitHub App's token minter only. Used only with `integrations.githubApp.tokens: devbox`. | the installer, or you |
| `devbox-llm`, or `secrets.llm.existingSecret` | `api-key` | iron-proxy | the installer, or you |
| `devbox-integrations`, or `secrets.integrations.existingSecret` | env names: `LINEAR_CLIENT_SECRET`, `LINEAR_WEBHOOK_SECRET`, `SLACK_BOT_TOKEN`, `GITHUB_WEBHOOK_SECRET` | the control plane, as env. Used only with an integration enabled. | the installer when an integration is enabled, or you |
| `database.existingSecret` (no default name) | `DATABASE_URL` | the control plane, with `postgresql.enabled: false` | you |
| `devbox-opensandbox` | `api-key` | the OpenSandbox server and the control plane | the chart |
| `devbox-postgres` | `password` | the bundled Postgres and the control plane | the chart, with `postgresql.enabled: true` |
| `devbox-iron-proxy-ca` | `tls.crt`, `tls.key` | iron-proxy. The public certificate is copied to the ConfigMap `iron-proxy-ca-cert` in `devbox-sandboxes`. | the chart |

- **The installer** creates `devbox-github`, `devbox-github-app` (only with
  the GitHub App's devbox tokens), `devbox-llm` and `devbox-integrations` from
  the secrets it looks up: your environment, the
  system keychain, a prompt ([README.md](README.md#2-set-the-secrets)). It
  rewrites them on every run. They carry the label
  `app.kubernetes.io/managed-by=devbox-installer`, which
  `k8s:uninstall --purge` uses to delete them.
- **The integration secrets** are those of the enabled integrations
  ([customizing.md](customizing.md#integrations)):

  | Key | Integration |
  |---|---|
  | `LINEAR_CLIENT_SECRET` | Linear: the app's client secret |
  | `LINEAR_WEBHOOK_SECRET` | Linear: the app's webhook signing secret |
  | `SLACK_BOT_TOKEN` | Slack: the bot token (`xoxb-…`) |
  | `GITHUB_WEBHOOK_SECRET` | The GitHub App: the webhook's secret |

  The installer writes only the enabled integrations' keys, and deletes its
  `devbox-integrations` when none is enabled. A key of an integration that is
  off does nothing, in either Secret.
- **The chart** creates the last three in a bootstrap Job that runs before
  every install and upgrade (ArgoCD: `PreSync`). It creates a Secret only when
  it is missing and never overwrites one. Deleting `devbox-postgres` while the
  database volume remains locks the control plane out of the database; see
  [Troubleshooting](README.md#troubleshooting).
- The sandboxes see none of these values. They get dummy tokens, and
  iron-proxy swaps them for the real ones.

## Bring your own

To manage a Secret yourself, name it with `existingSecret`, in chart values or
under `values` in the [target file](README.md#1-configure):

```yaml
secrets:
  github: { existingSecret: my-github }
  llm: { existingSecret: my-llm }
  integrations: { existingSecret: my-integrations }
database: { existingSecret: my-database }   # with postgresql.enabled: false
```

The installer then creates none of these, and never reads them: it does not
check that they exist or what they hold, and asks for none of their secrets. A
missing Secret or key shows only when the pods start, and `helm --wait` may
wait out its timeout. Check them with
[`bun run k8s:check`](README.md#check-the-secrets), before or after the
install; it needs read access to Secrets in `devbox`.
`k8s:uninstall --purge` never deletes them.

- With your own GitHub Secret, the agent's commit identity is `git.name` and
  `git.email` from the values, or the chart's default: it is no longer taken
  from the token. (With the GitHub App enabled, it is the App's bot.)
- Put only `token` (and `expires-at`, if your tooling writes it) in your own
  GitHub Secret, never the App's private key: every key in it reaches the
  control plane and iron-proxy, which mount the whole Secret, and the snapshot
  builder, which reads it.
- With your own key Secret (`secrets.githubApp.existingSecret`), the
  installer cannot mint a token, so it skips the GitHub token checks; run
  `k8s:check` after the install.
- With your own integrations Secret, put the keys of the enabled integrations
  there, and restart the control plane after each change
  ([Rotation](#rotation)).

The three default names (`devbox-github`, `devbox-llm`, `devbox-integrations`)
belong to the installer: a Secret you create under one of them by hand is
rewritten on the next `k8s:install` and deleted by `--purge`. Use your own
name with `existingSecret` to keep a Secret yours.

**No trailing newline.** iron-proxy sends the GitHub token and the LLM key as
they are, newline included. Write them with `--from-literal`, or `printf '%s'`,
never `echo`:

```bash
kubectl -n devbox create secret generic my-github --from-literal=token="$GITHUB_TOKEN"
```

`k8s:check` reports a `token` or `api-key` that ends with a newline.

### External Secrets

[External Secrets Operator](https://external-secrets.io/) writes a Secret from
your secret store. Name the target after the contract, or point
`existingSecret` at it:

```yaml
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: devbox-llm
  namespace: devbox
spec:
  refreshInterval: 1h
  secretStoreRef: { kind: ClusterSecretStore, name: <store> }
  target: { name: devbox-llm }
  data:
    - secretKey: api-key
      remoteRef: { key: <path-to-llm-key> }
```

Older operator versions serve `external-secrets.io/v1beta1`.

**GitHub App tokens.** The operator's `GithubAccessToken` generator can mint
the App's installation tokens for devbox. That recipe is in
[External tokens](../github.md#kubernetes-1). devbox can also mint them itself
([below](#the-github-app-key-and-the-minter)).

### Sealed Secrets and SOPS

- [Sealed Secrets](https://github.com/bitnami-labs/sealed-secrets): seal the
  Secret and commit the result.

  ```bash
  kubectl -n devbox create secret generic devbox-github --from-literal=token="$GITHUB_TOKEN" \
    --dry-run=client -o yaml | kubeseal -o yaml > devbox-github.sealed.yaml
  ```

- [SOPS](https://github.com/getsops/sops): encrypt the Secret manifest
  (`sops --encrypt --encrypted-regex '^(data|stringData)$'`), and let your
  GitOps tool decrypt it (Flux has SOPS support built in; ArgoCD needs a
  plugin).

## The GitHub App key and the minter

With `integrations.githubApp.tokens: devbox` ([docs/github.md](../github.md)),
devbox keeps the GitHub token fresh itself:

- **The key.** The App's private key lives in the Secret `devbox-github-app`
  (key `private-key`), or in the Secret `secrets.githubApp.existingSecret`
  names. Only the minter mounts it, as a file at
  `/var/run/devbox/github-app/private-key` (mode `0440`).
  `bun run github:setup` and `k8s:install` fill it; with GitOps you do.
- **The minter** is the Deployment `devbox-github-token`: the control-plane
  image run as `bun run github-token`. About every 30 minutes it asks GitHub
  for an installation token and patches the keys `token` and `expires-at` of
  `devbox-github`. The kubelet then updates the files in the control plane,
  iron-proxy and the snapshot builder, which re-read them as
  [below](#rotation). A Job, `devbox-github-token-seed`, mints one token after
  every install and upgrade, so the first snapshot build has one.
- **Its RBAC.** The minter has its own ServiceAccount, `devbox-github-token`.
  Its Role allows `get`, `update` and `patch` on the one token Secret, and
  nothing else, not even `create`: the Secret must exist, so the installer or
  the chart's bootstrap hook creates it (empty) first. A NetworkPolicy lets
  the minter reach DNS, port 443 (GitHub) and the Kubernetes API only.
- **Installer-owned Secrets.** The installer deletes `devbox-github-app` when
  the install does not use it (the App is off, uses your own key Secret, or has
  external tokens) and `devbox-github` when tokens are external. Only Secrets
  with its label `app.kubernetes.io/managed-by=devbox-installer`; yours are
  never touched.

With `tokens: external`, none of this runs: you keep the Secret named by
`secrets.github.existingSecret` fresh ([External tokens](../github.md#kubernetes-1)).

## Rotation

Change the Secret; nothing needs a restart for these:

- **iron-proxy** reads the GitHub token and the LLM key from mounted files and
  re-reads them every 60 seconds. The kubelet updates mounted Secrets within
  about a minute, so a new value is in use within about two minutes.
- **The control plane** reads the GitHub token the same way
  (`GITHUB_TOKEN_FILE`, re-read every 60 seconds).
- **The snapshot builder** reads the GitHub token on every run.

With the GitHub App's devbox tokens, the minter rotates the GitHub token for
you. To change the App's private key, see
[Rotating the key](../github.md#rotating-the-key): the minter reads the key
only when it starts.

Values the control plane reads as env take effect only after a restart of
the control plane: the integrations Secret and `DATABASE_URL`. After you change
either, run:

```bash
kubectl --context <context> -n devbox rollout restart deploy/devbox-control-plane
bun run k8s:check --target devbox.k8s.json
```

With the installer, rotating is running
`bun run k8s:install --target devbox.k8s.json` again with the new values: in
your environment, saved in the keychain, or typed at the prompt after
`bun run secrets rm <NAME> --target devbox.k8s.json`. It does not restart the
control plane. When it changed `devbox-integrations` and Helm did not roll the
control plane, it prints the restart command:

```
The integrations secrets changed; the control plane keeps the old values until it restarts:
  kubectl --context <context> -n devbox rollout restart deploy/devbox-control-plane
then: bun run k8s:check --target devbox.k8s.json
```

With your own Secret or with GitOps, nothing prints it: change the Secret,
then run the two commands above.

To turn an integration off, set its `enabled` to `false` (for Linear,
`bun run linear:disable --target devbox.k8s.json`) and re-run the installer.
It rewrites `devbox-integrations` without that integration's keys, or deletes
it when none is left.

## Encryption at rest

Secrets live in etcd. Check how your cluster encrypts them:

- EKS: [envelope encryption](https://docs.aws.amazon.com/eks/latest/userguide/envelope-encryption.html)
  with KMS, on by default from Kubernetes 1.28; you can use your own key.
- Other managed clusters: see your provider's docs on encrypting Secrets with
  your own KMS key.
- Your own cluster: configure an
  [EncryptionConfiguration](https://kubernetes.io/docs/tasks/administer-cluster/encrypt-data/)
  with a KMS provider.

## Who can read them

Anyone who can `get` Secrets in `devbox` can read the real GitHub token and LLM
key. So can anyone who can `exec` into, or create, pods there. Grant these to
the people and pipelines that operate devbox, not to its users. Users of the
CLI need only an API token.

Inside the cluster:

- The control plane and iron-proxy get the Secrets as mounted files; their
  service accounts cannot read Secrets.
- The bootstrap Job's service account can create Secrets in `devbox` and read
  only the three generated ones, and `devbox-github` to check it exists.
- The minter's service account, `devbox-github-token`, can read and update
  only the token Secret. The App's private key is mounted into the minter's
  pods alone, so anyone who can `exec` into them can read it.
- The snapshot builder's service account, `devbox-snapshot-builder` in
  `devbox-sandboxes`, can read only the GitHub Secret. Anyone who can create
  pods or Jobs in `devbox-sandboxes` could run a pod as it, so limit that too.
- Sandbox pods get no service account token.

## The GitHub token

Use a [fine-grained personal access token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens),
scoped to the repos in `repos`, or [a GitHub App](../github.md), which refreshes
its own tokens and adds webhooks:

- Repository access: only the configured repos.
- Permissions: Contents, read and write; Pull requests, read and write.
  Metadata, read, is added automatically. Add Workflows, read and write, only
  if the agent should change files under `.github/workflows`.

`k8s:install` checks these permissions before it installs anything. See
[what preflight checks](../configuration.md#what-preflight-checks) for each
request it makes, and for what each kind of token reports.

iron-proxy also lets sandboxes read and clone other repos the token can read,
so a narrow token keeps the sandbox from reading more than it needs.
