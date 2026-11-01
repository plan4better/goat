{{/*
Expand the name of the chart.
*/}}
{{- define "goat.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
Truncated at 63 chars (DNS limit).
*/}}
{{- define "goat.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Chart identifier label.
*/}}
{{- define "goat.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels applied to every chart-owned resource.
*/}}
{{- define "goat.labels" -}}
helm.sh/chart: {{ include "goat.chart" . }}
{{ include "goat.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: goat
{{- with .Values.global.commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end }}

{{/*
Selector labels — must be stable across upgrades.
*/}}
{{- define "goat.selectorLabels" -}}
app.kubernetes.io/name: {{ include "goat.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Per-service labels — adds `app.kubernetes.io/component`.
Usage: {{ include "goat.serviceLabels" (dict "context" . "component" "core") }}
*/}}
{{- define "goat.serviceLabels" -}}
{{ include "goat.labels" .context }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{/*
Per-service selector labels.
*/}}
{{- define "goat.serviceSelectorLabels" -}}
{{ include "goat.selectorLabels" .context }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{/*
Per-service fullname — appends component to release fullname.
Usage: {{ include "goat.serviceFullname" (dict "context" . "component" "core") }}
*/}}
{{- define "goat.serviceFullname" -}}
{{- $maxFullnameLen := sub 62 (len .component) | int -}}
{{- $fullname := include "goat.fullname" .context | trunc $maxFullnameLen | trimSuffix "-" -}}
{{- printf "%s-%s" $fullname .component | trimSuffix "-" -}}
{{- end }}

{{/*
Render an image reference. Honors global.imageRegistry as a mirror override.
Usage: {{ include "goat.image" (dict "image" .Values.core.image "global" .Values.global "root" $) }}
*/}}
{{- define "goat.image" -}}
{{- $registry := default .image.registry .global.imageRegistry -}}
{{- $repo := .image.repository -}}
{{- $tag := default .root.Chart.AppVersion .image.tag -}}
{{- if $registry -}}
{{- printf "%s/%s:%s" $registry $repo $tag -}}
{{- else -}}
{{- printf "%s:%s" $repo $tag -}}
{{- end -}}
{{- end }}

{{/*
imagePullSecrets — rendered from .Values.global.imagePullSecrets only.
Per-service overrides are not supported in v1; add them if a real use case appears.
*/}}
{{- define "goat.imagePullSecrets" -}}
{{- $secrets := .Values.global.imagePullSecrets -}}
{{- if $secrets -}}
imagePullSecrets:
{{ toYaml $secrets | indent 2 }}
{{- end -}}
{{- end }}

{{/*
Legacy per-worker claim name (windmill tools/workflows `persistence`, the
`data.enabled: false` fallback). Params: root, worker ("tools" | "workflows").
*/}}
{{- define "goat.windmill.workerPvc.name" -}}
{{- printf "%s-windmill-%s-data" (include "goat.fullname" .root) .worker -}}
{{- end }}

{{/*
Whether this release renders the per-worker claim (the fallback used only
when `data.enabled: false`). Shared by the pvc.yaml templates and the guard
so the two can never disagree. Params: root, worker.
*/}}
{{- define "goat.windmill.workerPvc.rendered" -}}
{{- $w := index .root.Values.windmill.workers .worker -}}
{{- if and (not .root.Values.data.enabled) $w.enabled $w.persistence.enabled (not $w.persistence.existingClaim) -}}
true
{{- end -}}
{{- end }}

{{/*
Whether the chart wires processes to the bundled windmill server
(WINDMILL_URL/WORKSPACE, plus the bootstrap token). Off with
`processes.windmillAutoWire: false`. Compared as a string because Sprig's
`default true` treats an explicit false as empty and turned it back on.
*/}}
{{- define "goat.processes.windmillAutoWire" -}}
{{- if and .Values.processes.enabled .Values.windmill.server.enabled (ne (toString .Values.processes.windmillAutoWire) "false") -}}
true
{{- end -}}
{{- end }}

{{/*
Whether the windmill bootstrap hook hands its token to processes: it then
restarts the processes Deployment whenever the token changes, since the pods
read it from an env var at start.
*/}}
{{- define "goat.windmill.bootstrapWiresProcesses" -}}
{{- if and .Values.windmill.bootstrap.enabled (include "goat.processes.windmillAutoWire" .) -}}
true
{{- end -}}
{{- end }}

{{/*
Shared data volume — claim name. Honors data.existingClaim.
*/}}
{{- define "goat.data.claimName" -}}
{{- if .Values.data.existingClaim -}}
{{- .Values.data.existingClaim -}}
{{- else -}}
{{- printf "%s-data" (include "goat.fullname" .) -}}
{{- end -}}
{{- end }}

{{/*
Shared data volume — the pod-level volumes entry. Volume name is `goat-data`
everywhere, so the mount helpers below can reference it by name.
*/}}
{{- define "goat.data.volume" -}}
- name: goat-data
  persistentVolumeClaim:
    claimName: {{ include "goat.data.claimName" . }}
{{- end }}

{{/*
Shared data volume — full read-write mount. For geoapi, processes and the
tools/workflows workers. geoapi is deliberately NOT read-only: it writes
features into DuckLake and deletes a layer's PMTiles on save.
*/}}
{{- define "goat.data.mounts.full" -}}
- name: goat-data
  mountPath: /app/data
{{- end }}

{{/*
Shared data volume — catalog's mount: just the catalog subtree, read-only.
User data on this volume is not the catalog service's business.
*/}}
{{- define "goat.data.mounts.catalog" -}}
- name: goat-data
  mountPath: /app/data/catalog
  subPath: catalog
  readOnly: true
{{- end }}

{{/*
Shared data volume — core's mounts: the catalog mirror and the geoip database,
both read-only. Core only ever reads from this volume.
*/}}
{{- define "goat.data.mounts.core" -}}
- name: goat-data
  mountPath: /app/data/catalog
  subPath: catalog
  readOnly: true
- name: goat-data
  mountPath: /app/data/geoip
  subPath: geoip
  readOnly: true
{{- end }}

{{/*
The browser-facing base URL of the web app. Used for the catalog's
"Open in GOAT" links and as its default CORS origin. Never cluster DNS —
a browser has to be able to resolve it. Falls back to web.ingress (so a
realistic ingress-based install still derives the real host instead of
staying on the NEXTAUTH_URL default of localhost:3000) before finally
falling back to the NEXTAUTH_URL config value itself.
*/}}
{{- define "goat.web.publicUrl" -}}
{{- .Values.web.auth.publicUrl | default (include "goat.ingressUrl" (dict "ingress" .Values.web.ingress)) | default .Values.web.config.NEXTAUTH_URL -}}
{{- end }}


{{/*
In-cluster URL of the processes service, or empty when it is not deployed.
Core and geoapi both POST here to start background jobs (layer and bundle
cleanup, bundle import, the rebuild a bundle edit needs). Unset, those
triggers fail silently while everything else keeps working.
Service port is 80, so no port suffix.
*/}}
{{- define "goat.processes.url" -}}
{{- if .Values.processes.enabled -}}
{{- printf "http://%s" (include "goat.serviceFullname" (dict "context" . "component" "processes")) -}}
{{- end -}}
{{- end }}

{{/*
Path prefix of the assistant behind a path-routing ingress: the first path of
its ingress without a trailing slash; "" for "/" or without an ingress. It is
the service's ROOT_PATH and the suffix of the web app's NEXT_PUBLIC_ASSISTANT_URL.
*/}}
{{- define "goat.assistant.pathPrefix" -}}
{{- $ing := .Values.assistant.ingress -}}
{{- if and $ing.enabled $ing.hosts -}}
{{- $paths := (first $ing.hosts).paths | default list -}}
{{- if $paths -}}
{{- (first $paths).path | default "/" | trimSuffix "/" -}}
{{- end -}}
{{- end -}}
{{- end }}

{{/*
Browser-facing URL of the assistant, the web app's NEXT_PUBLIC_ASSISTANT_URL:
web.publicUrls.assistant, else its ingress plus the path prefix; "" while the
assistant is off or has neither (the web app then hides it).
*/}}
{{- define "goat.assistant.publicUrl" -}}
{{- if .Values.assistant.enabled -}}
{{- $base := include "goat.ingressUrl" (dict "ingress" .Values.assistant.ingress) -}}
{{- $derived := ternary (printf "%s%s" $base (include "goat.assistant.pathPrefix" .)) "" (ne $base "") -}}
{{- .Values.web.publicUrls.assistant | default $derived -}}
{{- end -}}
{{- end }}

{{/*
Where the assistant gets the web app's Keycloak client (KEYCLOAK_CLIENT_ID,
KEYCLOAK_CLIENT_SECRET) when auth is on and the assistant itself is not wired
to a Secret: from the same source the web app reads it. Renders "secret" (the
web app is wired to a Secret), "extraEnv" (web.extraEnv sets it), "config"
(web.config holds a value) or "" (nothing to take, or the operator set the key
for the assistant). Params: root, key (KEYCLOAK_CLIENT_ID | KEYCLOAK_CLIENT_SECRET).
*/}}
{{- define "goat.assistant.webClientSource" -}}
{{- $r := .root -}}
{{- $values := $r.Values.assistant -}}
{{- $auth := dict "values" $values "root" $r -}}
{{- $webAuth := dict "values" $r.Values.web "root" $r -}}
{{- $webCfg := $r.Values.web.config | default dict -}}
{{- if and (include "goat.auth.enabled" $auth) (not (include "goat.auth.wired" $auth)) (not (include "goat.env.userSet" (dict "values" $values "key" .key))) -}}
{{- if include "goat.auth.wired" $webAuth -}}secret
{{- else if include "goat.env.inExtraEnv" (dict "values" $r.Values.web "key" .key) -}}extraEnv
{{- else if index $webCfg .key -}}config
{{- end -}}
{{- end -}}
{{- end }}

{{/*
Host headers the assistant's /mcp endpoint accepts, as a JSON list: every
host of its ingress, bare and with any port (`host:*` does not match the bare
host). '["*"]', which switches the check off, without an ingress host.
*/}}
{{- define "goat.assistant.mcpAllowedHosts" -}}
{{- $ing := .Values.assistant.ingress -}}
{{- $hosts := list -}}
{{- if $ing.enabled -}}
{{- range ($ing.hosts | default list) -}}
{{- if .host -}}
{{- $hosts = append $hosts .host -}}
{{- $hosts = append $hosts (printf "%s:*" .host) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- if $hosts -}}{{ toJson $hosts }}{{- else -}}["*"]{{- end -}}
{{- end }}

{{/*
Derive a browser-facing URL from a service's ingress block: scheme from
whether TLS is configured, host from the first entry. Empty when the ingress
is off or has no hosts.
Usage: {{ include "goat.ingressUrl" (dict "ingress" .Values.core.ingress) }}
*/}}
{{- define "goat.ingressUrl" -}}
{{- $ing := .ingress -}}
{{- if and $ing.enabled $ing.hosts -}}
{{- $scheme := ternary "https" "http" (gt (len $ing.tls) 0) -}}
{{- printf "%s://%s" $scheme (first $ing.hosts).host -}}
{{- end -}}
{{- end }}

{{/*
──── Auth (OIDC / Keycloak) ────────────────────────────────────────────────
One switch, `global.auth`, with per-service overrides under `<svc>.auth`.
Every helper takes (dict "values" .Values.<svc> "root" $) so core, web,
geoapi, processes and catalog all resolve the same way.

Inheritance, per field:
  enabled            <svc>.auth.enabled if it is true/false; unset or null
                     inherits global.auth.enabled. NOT `default`: `default
                     true false` is true, so an explicit false would be lost.
  existingSecret     <svc>.auth.existingSecret if non-empty, else global's.
  existingSecretKeys per key: <svc>.auth.existingSecretKeys.<k>, else
                     global.auth.existingSecretKeys.<k>, else the built-in
                     name (server-url, realm, client-id, client-secret,
                     nextauth-secret).
*/}}

{{/*
Effective auth switch. Renders "true" or "" (use with `eq ... "true"` or as
a truthy string).
*/}}
{{- define "goat.auth.enabled" -}}
{{- $a := .values.auth | default dict -}}
{{- $g := .root.Values.global.auth | default dict -}}
{{- if and (hasKey $a "enabled") (not (kindIs "invalid" $a.enabled)) -}}
{{- if $a.enabled -}}true{{- end -}}
{{- else if $g.enabled -}}
true
{{- end -}}
{{- end }}

{{/*
Effective Keycloak Secret name ("" when none is configured).
*/}}
{{- define "goat.auth.secretName" -}}
{{- $a := .values.auth | default dict -}}
{{- $g := .root.Values.global.auth | default dict -}}
{{- $a.existingSecret | default $g.existingSecret | default "" -}}
{{- end }}

{{/*
Auth is on AND a Secret is configured: the service reads its Keycloak
settings from that Secret. Renders "true" or "".
*/}}
{{- define "goat.auth.wired" -}}
{{- if and (include "goat.auth.enabled" .) (include "goat.auth.secretName" .) -}}
true
{{- end -}}
{{- end }}

{{/*
Effective key name inside the Secret. Extra param: key (serverUrl | realm |
clientId | clientSecret | nextauthSecret).
*/}}
{{- define "goat.auth.secretKey" -}}
{{- $a := .values.auth | default dict -}}
{{- $g := .root.Values.global.auth | default dict -}}
{{- $sk := $a.existingSecretKeys | default dict -}}
{{- $gk := $g.existingSecretKeys | default dict -}}
{{- $builtin := dict "serverUrl" "server-url" "realm" "realm" "clientId" "client-id" "clientSecret" "client-secret" "nextauthSecret" "nextauth-secret" -}}
{{- index $sk .key | default (index $gk .key) | default (index $builtin .key) -}}
{{- end }}

{{/*
AUTH_ALLOWED_CLIENTS for core, geoapi, processes, catalog and the assistant: the client IDs
in `global.auth.allowedClients`, comma-separated. Renders "" when the list is
empty, and the services then accept tokens of every client. Param: root.
*/}}
{{- define "goat.auth.allowedClients" -}}
{{- $g := .Values.global.auth | default dict -}}
{{- join "," ($g.allowedClients | default list) -}}
{{- end }}

{{/*
The AUTH value a service gets: "true" or "false", never empty — no service
may fall back to its code default (geoapi/processes default to AUTH on).
*/}}
{{- define "goat.auth.value" -}}
{{- ternary "true" "false" (eq (include "goat.auth.enabled" .) "true") -}}
{{- end }}

{{/*
Whether the operator already set env var `key` for this service in
`<svc>.extraEnv`. Renders "true" or "". Params: values, key.
*/}}
{{- define "goat.env.inExtraEnv" -}}
{{- $found := false -}}
{{- range (.values.extraEnv | default list) -}}
{{- if and (kindIs "map" .) (eq (toString .name) $.key) -}}
{{- $found = true -}}
{{- end -}}
{{- end -}}
{{- if $found -}}true{{- end -}}
{{- end }}

{{/*
Whether the operator set env var `key` explicitly, in `<svc>.config` or
`<svc>.extraEnv`. An explicitly set key wins: the chart then emits it
nowhere else, so it is rendered exactly once (a duplicate ConfigMap key
breaks yaml.v3 parsers; an env entry would silently shadow the ConfigMap).
Renders "true" or "". Params: values, key.
*/}}
{{- define "goat.env.userSet" -}}
{{- $cfg := .values.config | default dict -}}
{{- if or (hasKey $cfg .key) (include "goat.env.inExtraEnv" .) -}}
true
{{- end -}}
{{- end }}

{{/*
Auth env for the Python API services that validate tokens themselves and
ship no Keycloak placeholders in their `config` (geoapi, processes,
catalog). Renders `env:` list entries (indent with nindent):
  - AUTH, always "true"/"false" (never the code default);
  - when wired to a Secret: KEYCLOAK_SERVER_URL and REALM_NAME via
    secretKeyRef;
  - when `fallback` is true, auth is on and no Secret is configured:
    KEYCLOAK_SERVER_URL / REALM_NAME as plain values from
    core.config.KEYCLOAK_SERVER_URL / core.config.REALM_NAME, when set;
  - AUTH_ALLOWED_CLIENTS from `global.auth.allowedClients`, when not empty.
Each entry is skipped when the operator set that key in `<svc>.config` or
`<svc>.extraEnv` (see goat.env.userSet).
Params: values, root, fallback (bool).
*/}}
{{- define "goat.auth.backendEnv" -}}
{{- $ctx := dict "values" .values "root" .root -}}
{{- $wired := include "goat.auth.wired" $ctx -}}
{{- $secret := include "goat.auth.secretName" $ctx -}}
{{- $coreCfg := .root.Values.core.config | default dict -}}
{{- if not (include "goat.env.userSet" (dict "values" .values "key" "AUTH")) }}
- name: AUTH
  value: {{ include "goat.auth.value" $ctx | quote }}
{{- end }}
{{- range $pair := list (list "KEYCLOAK_SERVER_URL" "serverUrl") (list "REALM_NAME" "realm") }}
{{- $name := index $pair 0 }}
{{- if not (include "goat.env.userSet" (dict "values" $.values "key" $name)) }}
{{- if $wired }}
- name: {{ $name }}
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: {{ include "goat.auth.secretKey" (merge (dict "key" (index $pair 1)) $ctx) }}
{{- else if and $.fallback (include "goat.auth.enabled" $ctx) (index $coreCfg $name) }}
- name: {{ $name }}
  value: {{ index $coreCfg $name | quote }}
{{- end }}
{{- end }}
{{- end }}
{{- $allowedClients := include "goat.auth.allowedClients" .root }}
{{- if and $allowedClients (not (include "goat.env.userSet" (dict "values" .values "key" "AUTH_ALLOWED_CLIENTS"))) }}
- name: AUTH_ALLOWED_CLIENTS
  value: {{ $allowedClients | quote }}
{{- end }}
{{- end }}

{{/*
core's Keycloak env from the auth Secret (core.auth / global.auth), for the
core Deployment and its migrate hook alike: core refuses to start with AUTH
on and no KEYCLOAK_SERVER_URL, and the ConfigMap leaves the Keycloak keys out
when they come from the Secret. A key set in core.extraEnv is left to
extraEnv; AUTH set in core.config / core.extraEnv is left to that value.
Renders nothing unless a Secret is wired. Param: root.
*/}}
{{- define "goat.core.authEnv" -}}
{{- $auth := dict "values" .root.Values.core "root" .root -}}
{{- if include "goat.auth.wired" $auth }}
{{- $secret := include "goat.auth.secretName" $auth }}
{{- if not (include "goat.env.userSet" (dict "values" .root.Values.core "key" "AUTH")) }}
- name: AUTH
  value: "true"
{{- end }}
{{- range $pair := list (list "KEYCLOAK_SERVER_URL" "serverUrl") (list "REALM_NAME" "realm") (list "KEYCLOAK_CLIENT_ID" "clientId") (list "KEYCLOAK_CLIENT_SECRET" "clientSecret") }}
{{- if not (include "goat.env.inExtraEnv" (dict "values" $.root.Values.core "key" (index $pair 0))) }}
- name: {{ index $pair 0 }}
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: {{ include "goat.auth.secretKey" (merge (dict "key" (index $pair 1)) $auth) }}
{{- end }}
{{- end }}
{{- end }}
{{- end }}

{{/*
The AUTH value a service's container ends up with, including an operator's
explicit AUTH in `<svc>.config` or `<svc>.extraEnv` (lowercased; "custom"
for an extraEnv valueFrom). For the mixed-auth warning in NOTES.txt.
Params: values, root.
*/}}
{{- define "goat.auth.effectiveValue" -}}
{{- $cfg := .values.config | default dict -}}
{{- $v := include "goat.auth.value" . -}}
{{- if hasKey $cfg "AUTH" -}}
{{- $v = toString (index $cfg "AUTH") | lower -}}
{{- end -}}
{{- range (.values.extraEnv | default list) -}}
{{- if and (kindIs "map" .) (eq (toString .name) "AUTH") -}}
{{- $v = ternary (toString .value | lower) "custom" (hasKey . "value") -}}
{{- end -}}
{{- end -}}
{{- $v -}}
{{- end }}

{{/*
──── Company CA ─────────────────────────────────────────────────────────────
`global.caBundle` names a ConfigMap or a Secret holding a PEM CA certificate.
Mounted at /etc/goat/ca/ca.pem in core, web, the assistant and the Windmill
print, tools and workflows workers; each points its own variable at that file.
*/}}
{{- define "goat.caBundle.enabled" -}}
{{- $ca := .Values.global.caBundle | default dict -}}
{{- if and $ca.existingConfigMap $ca.existingSecret -}}
{{- fail "global.caBundle: set existingConfigMap or existingSecret, not both" -}}
{{- end -}}
{{- if or $ca.existingConfigMap $ca.existingSecret -}}true{{- end -}}
{{- end }}

{{- define "goat.caBundle.path" -}}/etc/goat/ca/ca.pem{{- end }}

{{- define "goat.caBundle.volume" -}}
{{- $ca := .Values.global.caBundle -}}
- name: goat-ca-bundle
{{- if $ca.existingSecret }}
  secret:
    secretName: {{ $ca.existingSecret }}
    items:
      - key: {{ $ca.key | default "ca.crt" }}
        path: ca.pem
{{- else }}
  configMap:
    name: {{ $ca.existingConfigMap }}
    items:
      - key: {{ $ca.key | default "ca.crt" }}
        path: ca.pem
{{- end }}
{{- end }}

{{- define "goat.caBundle.mount" -}}
- name: goat-ca-bundle
  mountPath: /etc/goat/ca
  readOnly: true
{{- end }}

{{/*
Public URL of core's API (API_URL, with /api/v2): web.publicUrls.api, else
core's ingress.
*/}}
{{- define "goat.core.publicApiUrl" -}}
{{- $base := .Values.web.publicUrls.api | default (include "goat.ingressUrl" (dict "ingress" .Values.core.ingress)) | trimSuffix "/" -}}
{{- if $base -}}{{ printf "%s/api/v2" $base }}{{- end -}}
{{- end }}
