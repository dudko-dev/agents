{{/* Names. */}}
{{- define "swarm.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "swarm.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* "<fullname>-<component>", within 63 characters. */}}
{{- define "swarm.component" -}}
{{- $root := index . 0 -}}
{{- $component := index . 1 -}}
{{- printf "%s-%s" (include "swarm.fullname" $root | trunc (int (sub 62 (len $component))) | trimSuffix "-") $component -}}
{{- end -}}

{{- define "swarm.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/name: {{ include "swarm.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: agent-swarm
{{- end -}}

{{/* Selector labels of one role: gateway | worker | migrate. */}}
{{- define "swarm.selector" -}}
{{- $root := index . 0 -}}
app.kubernetes.io/name: {{ include "swarm.name" $root }}
app.kubernetes.io/instance: {{ $root.Release.Name }}
app.kubernetes.io/component: {{ index . 1 }}
{{- end -}}

{{/* A pod's labels: its role's selector and the chart's other labels. */}}
{{- define "swarm.podLabels" -}}
{{- $root := index . 0 -}}
{{ include "swarm.selector" . }}
helm.sh/chart: {{ printf "%s-%s" $root.Chart.Name $root.Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/version: {{ $root.Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ $root.Release.Service }}
app.kubernetes.io/part-of: agent-swarm
{{- end -}}

{{- define "swarm.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "swarm.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "swarm.image" -}}
{{- $tag := default .Chart.AppVersion .Values.image.tag -}}
{{- if .Values.image.digest -}}
{{- printf "%s@%s" .Values.image.repository .Values.image.digest -}}
{{- else -}}
{{- printf "%s:%s" .Values.image.repository $tag -}}
{{- end -}}
{{- end -}}

{{/* The bundled Temporal chart's frontend, as that chart names it (its temporal.fullname). */}}
{{- define "swarm.bundledTemporalFrontend" -}}
{{- $t := .Values.temporal -}}
{{- $full := "" -}}
{{- if $t.fullnameOverride -}}
{{- $full = $t.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default "temporal" $t.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- $full = .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $full = printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- printf "%s-frontend" ($full | trunc 53 | trimSuffix "-") -}}
{{- end -}}

{{/* The frontend: the bundled chart's when temporal.enabled, else temporal.address. */}}
{{- define "swarm.temporalAddress" -}}
{{- if .Values.temporal.enabled -}}
{{- printf "%s:7233" (include "swarm.bundledTemporalFrontend" .) -}}
{{- else if .Values.temporal.address -}}
{{- .Values.temporal.address -}}
{{- else -}}
{{- fail "temporal.address is required (host:port of your Temporal frontend), or set temporal.enabled to run the bundled Temporal chart" -}}
{{- end -}}
{{- end -}}

{{- define "swarm.temporalTls" -}}
{{- if or .Values.temporal.tls.enabled .Values.secrets.temporalTls.name .Values.secrets.temporalApiKey.name -}}on{{- else -}}off{{- end -}}
{{- end -}}

{{/* A JSON setting given as a string or as a map. */}}
{{- define "swarm.json" -}}
{{- if kindIs "string" . -}}{{ . }}{{- else -}}{{ toJson . }}{{- end -}}
{{- end -}}

{{- define "swarm.secretDir" -}}/run/secrets/agent-swarm{{- end -}}

{{/*
The secret files a role mounts: a list of { secret, key, file, env } (env: the app's <NAME>_FILE).
Roles: gateway | worker | migrate.
*/}}
{{- define "swarm.secretFiles" -}}
{{- $root := index . 0 -}}
{{- $role := index . 1 -}}
{{- $s := $root.Values.secrets -}}
{{- $files := list -}}
{{- if eq $role "migrate" -}}
{{- if $s.migrateDatabaseUrl.name -}}
{{- $files = append $files (dict "secret" $s.migrateDatabaseUrl.name "key" $s.migrateDatabaseUrl.key "file" "migrate-database-url" "env" "MIGRATE_DATABASE_URL_FILE") -}}
{{- end -}}
{{- end -}}
{{- $files = append $files (dict "secret" $s.databaseUrl.name "key" $s.databaseUrl.key "file" "database-url" "env" "DATABASE_URL_FILE") -}}
{{- if and (eq $role "gateway") (eq $root.Values.gateway.auth "bearer") -}}
{{- $files = append $files (dict "secret" $s.gatewayTokens.name "key" $s.gatewayTokens.key "file" "gateway-tokens" "env" "GATEWAY_TOKENS_FILE") -}}
{{- end -}}
{{- if eq $role "worker" -}}
{{- $files = append $files (dict "secret" $s.agentApiKey.name "key" $s.agentApiKey.key "file" "agent-api-key" "env" "AGENT_API_KEY_FILE") -}}
{{- end -}}
{{- if and (ne $role "migrate") $s.temporalApiKey.name -}}
{{- $files = append $files (dict "secret" $s.temporalApiKey.name "key" $s.temporalApiKey.key "file" "temporal-api-key" "env" "TEMPORAL_API_KEY_FILE") -}}
{{- end -}}
{{- if and (ne $role "migrate") $s.temporalTls.name -}}
{{- $files = append $files (dict "secret" $s.temporalTls.name "key" "ca.crt" "file" "temporal-ca.crt" "env" "") -}}
{{- if $s.temporalTls.clientCertificate -}}
{{- $files = append $files (dict "secret" $s.temporalTls.name "key" "tls.crt" "file" "temporal-tls.crt" "env" "") -}}
{{- $files = append $files (dict "secret" $s.temporalTls.name "key" "tls.key" "file" "temporal-tls.key" "env" "") -}}
{{- end -}}
{{- end -}}
{{- toJson $files -}}
{{- end -}}

{{/* The env and volume parts of a role's secrets. */}}
{{- define "swarm.secretEnv" -}}
{{- range (include "swarm.secretFiles" . | fromJsonArray) }}
{{- if .env }}
- name: {{ .env }}
  value: {{ printf "%s/%s" (include "swarm.secretDir" dict) .file | quote }}
{{- end }}
{{- end }}
{{- end -}}

{{- define "swarm.secretVolume" -}}
- name: secrets
  projected:
    defaultMode: 0440
    sources:
      {{- range (include "swarm.secretFiles" . | fromJsonArray) }}
      - secret:
          name: {{ .secret }}
          items:
            - key: {{ .key }}
              path: {{ .file }}
      {{- end }}
{{- end -}}

{{/* Pod-level settings shared by the roles. */}}
{{- define "swarm.podCommon" -}}
{{- with .Values.imagePullSecrets }}
imagePullSecrets:
  {{- toYaml . | nindent 2 }}
{{- end }}
securityContext:
  {{- toYaml .Values.podSecurityContext | nindent 2 }}
{{- end -}}

{{- define "swarm.tmpVolume" -}}
- name: tmp
  emptyDir:
    sizeLimit: {{ .Values.tmp.sizeLimit }}
{{- end -}}

{{- define "swarm.mounts" -}}
- name: tmp
  mountPath: /tmp
- name: secrets
  mountPath: {{ include "swarm.secretDir" dict }}
  readOnly: true
{{- end -}}

{{/* NetworkPolicy egress every role needs: DNS, Postgres, and (list root true) Temporal. */}}
{{- define "swarm.baseEgress" -}}
{{- $root := index . 0 -}}
{{- $np := $root.Values.networkPolicy -}}
{{- if $np.dns.enabled }}
- to:
    {{- toYaml $np.dns.to | nindent 4 }}
  ports:
    - { port: 53, protocol: UDP }
    - { port: 53, protocol: TCP }
{{- end }}
- ports:
    - { port: {{ $np.postgres.port }}, protocol: TCP }
  {{- with $np.postgres.to }}
  to:
    {{- toYaml . | nindent 4 }}
  {{- end }}
{{- if index . 1 }}
- ports:
    - { port: {{ $np.temporal.port }}, protocol: TCP }
  {{- if $np.temporal.to }}
  to:
    {{- toYaml $np.temporal.to | nindent 4 }}
  {{- else if $root.Values.temporal.enabled }}
  to:
    - podSelector:
        matchLabels:
          app.kubernetes.io/instance: {{ $root.Release.Name }}
          app.kubernetes.io/name: {{ default "temporal" $root.Values.temporal.nameOverride }}
          app.kubernetes.io/component: frontend
  {{- end }}
{{- end }}
{{- end }}
