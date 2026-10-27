{{/* Labels on every devbox resource. */}}
{{- define "devbox.labels" -}}
app.kubernetes.io/part-of: devbox
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end }}

{{/* Selector labels; the argument is the component name. */}}
{{- define "devbox.selectorLabels" -}}
app.kubernetes.io/part-of: devbox
app.kubernetes.io/component: {{ . }}
{{- end }}

{{/* Sandboxes, task PVCs and repo snapshots live here. */}}
{{- define "devbox.sandboxNamespace" -}}devbox-sandboxes{{- end }}

{{- define "devbox.tag" -}}{{ .Values.images.tag | default .Chart.AppVersion }}{{- end }}
{{- define "devbox.controlPlaneImage" -}}{{ printf "%s:%s" (required "images.controlPlane is required: the control-plane image repository" .Values.images.controlPlane) (include "devbox.tag" .) }}{{- end }}
{{- define "devbox.harnessImage" -}}{{ printf "%s:%s" (required "images.harness is required: the harness image repository" .Values.images.harness) (include "devbox.tag" .) }}{{- end }}
{{- define "devbox.controlPlaneImagePullSecrets" -}}
{{- $secrets := .Values.images.controlPlanePullSecrets -}}
{{- if $secrets }}
imagePullSecrets: {{- toYaml $secrets | nindent 2 }}
{{- end }}
{{- end }}

{{/* Secret names: the user's existingSecret, else the installer's. */}}
{{- define "devbox.githubSecret" -}}{{ .Values.secrets.github.existingSecret | default "devbox-github" }}{{- end }}
{{- define "devbox.llmSecret" -}}{{ .Values.secrets.llm.existingSecret | default "devbox-llm" }}{{- end }}
{{- define "devbox.githubAppSecret" -}}{{ .Values.secrets.githubApp.existingSecret | default "devbox-github-app" }}{{- end }}
{{- define "devbox.integrationsSecret" -}}{{ .Values.secrets.integrations.existingSecret | default "devbox-integrations" }}{{- end }}

{{- define "devbox.publicBaseUrl" -}}
{{- if .Values.controlPlane.publicBaseUrl -}}
{{ .Values.controlPlane.publicBaseUrl }}
{{- else if .Values.ingress.api.enabled -}}
{{ ternary "https" "http" (not (empty .Values.ingress.api.tls)) }}://{{ .Values.ingress.api.host }}
{{- else -}}
http://localhost:3000
{{- end -}}
{{- end }}

{{/* LLM host and the one endpoint the harness calls, as control-plane/scripts/up/ironProxy.ts
derives them: <baseUrl>/responses for openai, <baseUrl>/v1/messages for anthropic. */}}
{{- define "devbox.llmHost" -}}{{ (urlParse .Values.llm.baseUrl).host }}{{- end }}
{{- define "devbox.llmPath" -}}
{{- $path := regexReplaceAll "/+$" (urlParse .Values.llm.baseUrl).path "" -}}
{{- ternary (printf "%s/v1/messages" $path) (printf "%s/responses" $path) (eq .Values.llm.provider "anthropic") -}}
{{- end }}

{{/* LLM stage keys and env suffixes. Keep in sync with values.schema.json llm.stages and control-plane/scripts/up/config.ts LLM_STAGES. */}}
{{- define "devbox.llmStages" -}}
- key: orientation
  env: ORIENTATION
- key: planning
  env: PLANNING
- key: planReview
  env: PLAN_REVIEW
- key: implementation
  env: IMPLEMENTATION
- key: distillation
  env: DISTILLATION
- key: review
  env: REVIEW
- key: followup
  env: FOLLOWUP
{{- end }}

{{/* Owner and name of a repo URL https://github.com/<owner>/<name>.git. */}}
{{- define "devbox.repoOwner" -}}{{ regexReplaceAll "^https://github\\.com/([^/]+)/([^/]+)\\.git$" . "${1}" }}{{- end }}
{{- define "devbox.repoName" -}}{{ regexReplaceAll "^https://github\\.com/([^/]+)/([^/]+)\\.git$" . "${2}" }}{{- end }}

{{/* The repo list as one "<url> <branch>" line per repo; toJson keeps the newlines escaped. */}}
{{- define "devbox.reposEnv" -}}
{{- range .Values.repos }}{{ printf "%s %s\n" .url (.branch | default "main") }}{{- end }}
{{- end }}

{{/* The snapshot builder's pod, shared by the CronJob and the install hook. */}}
{{- define "devbox.snapshotBuilderPod" -}}
metadata:
  labels: {{- include "devbox.selectorLabels" "snapshot-builder" | nindent 4 }}
spec:
  serviceAccountName: devbox-snapshot-builder
{{ include "devbox.controlPlaneImagePullSecrets" . | indent 2 }}
  restartPolicy: Never
  securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 }
  containers:
    - name: snapshot-builder
      image: {{ include "devbox.controlPlaneImage" . }}
      imagePullPolicy: {{ .Values.images.pullPolicy }}
      command: [sh, /scripts/snapshot-builder.sh]
      env:
        - { name: REPOS, value: {{ include "devbox.reposEnv" . | toJson }} }
        - { name: RELEASE_NAMESPACE, value: {{ .Release.Namespace | quote }} }
        - { name: SANDBOX_NAMESPACE, value: {{ include "devbox.sandboxNamespace" . | quote }} }
        - { name: GITHUB_SECRET, value: {{ include "devbox.githubSecret" . | quote }} }
        - { name: SCRATCH_PVC, value: devbox-repos-scratch }
        - { name: SNAPSHOT_CLASS, value: {{ .Values.storage.volumeSnapshotClass | quote }} }
        - { name: KEEP, value: {{ .Values.snapshotBuilder.keep | quote }} }
      securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: [ALL] } }
      volumeMounts:
        - { name: repos, mountPath: /repos }
        - { name: scripts, mountPath: /scripts, readOnly: true }
  volumes:
    - name: repos
      persistentVolumeClaim: { claimName: devbox-repos-scratch }
    - name: scripts
      configMap: { name: devbox-snapshot-builder-script }
{{- end }}

{{/* "true" when the chart runs the GitHub token minter: the App is on and devbox
mints its tokens. Empty otherwise. */}}
{{- define "devbox.githubMinter" -}}
{{- $app := .Values.integrations.githubApp | default dict -}}
{{- if and $app.enabled (eq ($app.tokens | default "") "devbox") }}true{{ end -}}
{{- end }}

{{/* The minter's pod, shared by its Deployment and the seed Job; the argument
is a dict of the root context (ctx), the component name and the command. */}}
{{- define "devbox.githubTokenPod" -}}
{{- $ := .ctx -}}
{{- $app := $.Values.integrations.githubApp -}}
{{- $names := list -}}
{{- /* Narrowed unless the whole installation is asked for. */ -}}
{{- if ne ($app.tokenScope | default "") "installation" -}}
{{- range $.Values.repos }}{{ $names = append $names (include "devbox.repoName" .url) }}{{ end -}}
{{- end -}}
metadata:
  labels: {{- include "devbox.selectorLabels" .component | nindent 4 }}
spec:
  {{- with .restartPolicy }}
  restartPolicy: {{ . }}
  {{- end }}
  serviceAccountName: devbox-github-token
{{ include "devbox.controlPlaneImagePullSecrets" $ | indent 2 }}
  # fsGroup: the key file is group-readable (0440) for the pod's group.
  securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 }
  containers:
    - name: {{ .component }}
      image: {{ include "devbox.controlPlaneImage" $ }}
      imagePullPolicy: {{ $.Values.images.pullPolicy }}
      command: {{ toJson .command }}
      env:
        - { name: GITHUB_APP_ID, value: {{ $app.appId | int64 | toString | quote }} }
        - { name: GITHUB_APP_INSTALLATION_ID, value: {{ $app.installationId | int64 | toString | quote }} }
        - { name: GITHUB_APP_PRIVATE_KEY_FILE, value: /var/run/devbox/github-app/private-key }
        # Repo names without owners; empty asks for the whole installation.
        - { name: GITHUB_APP_REPOSITORIES, value: {{ $names | uniq | join "," | quote }} }
        - { name: GITHUB_TOKEN_SINK, value: {{ printf "secret:%s/%s" $.Release.Namespace (include "devbox.githubSecret" $) | quote }} }
      resources:
        requests: { cpu: 50m, memory: 64Mi }
      securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: [ALL] } }
      volumeMounts:
        - { name: github-app-key, mountPath: /var/run/devbox/github-app, readOnly: true }
  volumes:
    - name: github-app-key
      secret:
        secretName: {{ include "devbox.githubAppSecret" $ }}
        defaultMode: 0440
        items: [{ key: private-key, path: private-key }]
{{- end }}
