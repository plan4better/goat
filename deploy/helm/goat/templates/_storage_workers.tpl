{{/*
──── Object storage (global.s3) ─────────────────────────────────────────────
The S3 store GOAT keeps uploads in, and core's assets bucket. Nothing is
rendered until `global.s3.bucket` is set (or garage.enabled, see _garage.tpl). Each service gets it as env
entries; a variable the service sets itself in `<svc>.config` or
`<svc>.extraEnv` wins and is rendered nowhere else.
*/}}
{{- define "goat.s3.enabled" -}}
{{- if (include "goat.s3.settings" . | fromYaml).bucket -}}true{{- end -}}
{{- end }}

{{/*
S3 env entries (a YAML list, indent with nindent). Params: root, values
(the service's values block), assets (true for core: its assets bucket and
the AWS_* key pair it uses for it).
*/}}
{{- define "goat.s3.env" -}}
{{- $s3 := include "goat.s3.settings" .root | fromYaml -}}
{{- if $s3.bucket -}}
{{- $v := .values -}}
{{- $pathStyle := ternary "true" "false" (eq (toString $s3.forcePathStyle) "true") -}}
{{- $plain := list (list "S3_BUCKET_NAME" $s3.bucket) (list "S3_PROVIDER" $s3.provider) (list "S3_ENDPOINT_URL" $s3.endpointUrl) (list "S3_PUBLIC_ENDPOINT_URL" $s3.publicEndpointUrl) (list "S3_REGION" $s3.region) (list "S3_FORCE_PATH_STYLE" $pathStyle) (list "AWS_REQUEST_CHECKSUM_CALCULATION" "when_required") (list "AWS_RESPONSE_CHECKSUM_VALIDATION" "when_required") -}}
{{- $keys := $s3.existingSecretKeys | default dict -}}
{{- $idKey := $keys.accessKeyId | default "access-key-id" -}}
{{- $secretKey := $keys.secretAccessKey | default "secret-access-key" -}}
{{- $fromSecret := list (list "S3_ACCESS_KEY_ID" $idKey) (list "S3_SECRET_ACCESS_KEY" $secretKey) -}}
{{- if .assets -}}
{{- $a := $s3.assets | default dict -}}
{{- if $a.servedByCore -}}
{{- /* Assets in the data bucket, served by core: no assets bucket or keys. */ -}}
{{- $plain = concat $plain (list (list "ASSETS_SERVED_BY_CORE" "true") (list "ASSETS_URL" $a.publicUrl)) -}}
{{- else -}}
{{- $plain = concat $plain (list (list "AWS_REGION" $s3.region) (list "AWS_S3_ASSETS_BUCKET" $a.bucket) (list "ASSETS_URL" $a.publicUrl) (list "ASSETS_S3_ENDPOINT_URL" $s3.endpointUrl) (list "ASSETS_S3_FORCE_PATH_STYLE" $pathStyle)) -}}
{{- $fromSecret = concat $fromSecret (list (list "AWS_ACCESS_KEY_ID" $idKey) (list "AWS_SECRET_ACCESS_KEY" $secretKey)) -}}
{{- end -}}
{{- end -}}
{{- range $plain -}}
{{- $name := index . 0 -}}
{{- $value := toString (index . 1 | default "") -}}
{{- if and $value (not (include "goat.env.userSet" (dict "values" $v "key" $name))) }}
- name: {{ $name }}
  value: {{ $value | quote }}
{{- end -}}
{{- end -}}
{{- if $s3.existingSecret -}}
{{- range $fromSecret -}}
{{- if not (include "goat.env.userSet" (dict "values" $v "key" (index . 0))) }}
- name: {{ index . 0 }}
  valueFrom:
    secretKeyRef:
      name: {{ $s3.existingSecret }}
      key: {{ index . 1 }}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end }}

{{/*
The catalog bucket env of processes (catalog.s3), which reads the open-data
mirror in it. Unset values render nothing. Params: root, values (the
service's values block).
*/}}
{{- define "goat.catalogS3.env" -}}
{{- $v := .values -}}
{{- $cat := .root.Values.catalog.s3 | default dict -}}
{{- if $cat.bucket -}}
{{- range list (list "CATALOG_S3_BUCKET" $cat.bucket) (list "CATALOG_S3_ENDPOINT_URL" $cat.endpointUrl) (list "CATALOG_S3_REGION" $cat.region) -}}
{{- $value := toString (index . 1 | default "") -}}
{{- if and $value (not (include "goat.env.userSet" (dict "values" $v "key" (index . 0)))) }}
- name: {{ index . 0 }}
  value: {{ $value | quote }}
{{- end -}}
{{- end -}}
{{- if $cat.existingSecret -}}
{{- range list (list "CATALOG_S3_ACCESS_KEY_ID" $cat.accessKeyIdKey) (list "CATALOG_S3_SECRET_ACCESS_KEY" $cat.secretAccessKeyKey) -}}
{{- if not (include "goat.env.userSet" (dict "values" $v "key" (index . 0))) }}
- name: {{ index . 0 }}
  valueFrom:
    secretKeyRef:
      name: {{ $cat.existingSecret }}
      key: {{ index . 1 }}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end }}

{{/*
──── Windmill workers that run GOAT's jobs (print, tools, workflows) ────────
Windmill runs GOAT's tools, imports, workflows and prints as scripts inside
these workers, and hands a script only the variables named in
WHITELIST_ENVS. The chart gives each of these workers what goatlib reads:
the GOAT database and DuckLake, S3 (global.s3), the catalog bucket
(catalog.s3), the web app the print worker renders (PRINT_BASE_URL) and the
Keycloak client it logs in with (global.auth). A variable set in the
worker's `config` or `extraEnv` wins.
*/}}

{{/*
The GOAT env entries of one worker. Params: root, values (the worker's
values block).
*/}}
{{- define "goat.worker.appEnv" -}}
{{- $r := .root -}}
{{- $v := .values -}}
{{- $plain := list (list "POSTGRES_SERVER" (include "goat.postgresql.host" $r)) (list "POSTGRES_PORT" (include "goat.postgresql.port" $r)) (list "POSTGRES_DB" (include "goat.postgresql.database" $r)) (list "POSTGRES_TRANSACTION_POOLER" (include "goat.postgresql.transactionPooler" $r)) (list "DUCKLAKE_POSTGRES_SERVER" (include "goat.postgresql.ducklakeHost" $r)) (list "DUCKLAKE_POSTGRES_PORT" (include "goat.postgresql.ducklakePort" $r)) (list "DUCKLAKE_DATA_DIR" $r.Values.ducklakeBootstrap.dataDir) (list "DUCKLAKE_CATALOG_SCHEMA" $r.Values.ducklakeBootstrap.catalogSchema) -}}
{{- if $r.Values.web.enabled -}}
{{- $plain = append $plain (list "PRINT_BASE_URL" (printf "http://%s" (include "goat.serviceFullname" (dict "context" $r "component" "web")))) -}}
{{- end -}}
{{- $cat := $r.Values.catalog.s3 | default dict -}}
{{- if $cat.bucket -}}
{{- $plain = concat $plain (list (list "CATALOG_S3_BUCKET" $cat.bucket) (list "CATALOG_S3_ENDPOINT_URL" $cat.endpointUrl) (list "CATALOG_S3_REGION" $cat.region)) -}}
{{- end -}}
{{- range $plain -}}
{{- $name := index . 0 -}}
{{- $value := toString (index . 1 | default "") -}}
{{- if and $value (not (include "goat.env.userSet" (dict "values" $v "key" $name))) }}
- name: {{ $name }}
  value: {{ $value | quote }}
{{- end -}}
{{- end -}}
{{- $secrets := list (list "POSTGRES_USER" (include "goat.postgresql.secretName" $r) (include "goat.postgresql.userKey" $r)) (list "POSTGRES_PASSWORD" (include "goat.postgresql.secretName" $r) (include "goat.postgresql.passwordKey" $r)) -}}
{{- if and $cat.bucket $cat.existingSecret -}}
{{- $secrets = concat $secrets (list (list "CATALOG_S3_ACCESS_KEY_ID" $cat.existingSecret $cat.accessKeyIdKey) (list "CATALOG_S3_SECRET_ACCESS_KEY" $cat.existingSecret $cat.secretAccessKeyKey)) -}}
{{- end -}}
{{- $auth := dict "values" (dict) "root" $r -}}
{{- if include "goat.auth.wired" $auth -}}
{{- $kc := include "goat.auth.secretName" $auth -}}
{{- range $pair := list (list "KEYCLOAK_SERVER_URL" "serverUrl") (list "REALM_NAME" "realm") (list "KEYCLOAK_CLIENT_ID" "clientId") (list "KEYCLOAK_CLIENT_SECRET" "clientSecret") -}}
{{- $secrets = append $secrets (list (index $pair 0) $kc (include "goat.auth.secretKey" (merge (dict "key" (index $pair 1)) $auth))) -}}
{{- end -}}
{{- end -}}
{{- range $secrets -}}
{{- if not (include "goat.env.userSet" (dict "values" $v "key" (index . 0))) }}
- name: {{ index . 0 }}
  valueFrom:
    secretKeyRef:
      name: {{ index . 1 }}
      key: {{ index . 2 }}
{{- end -}}
{{- end -}}
{{- include "goat.s3.env" (dict "root" $r "values" $v "assets" false) -}}
{{- end }}

{{/*
WHITELIST_ENVS of one worker: every variable the chart hands it for GOAT
(goat.worker.appEnv, GOAT_CA_BUNDLE) plus every name in its `config` and
`extraEnv`, less Windmill's own settings. Params: root, values, appEnv (the
rendered goat.worker.appEnv).
*/}}
{{- define "goat.worker.whitelist" -}}
{{- $names := list -}}
{{- range regexFindAll "(?m)^- name: [A-Z0-9_]+" .appEnv -1 -}}
{{- $names = append $names (trimPrefix "- name: " .) -}}
{{- end -}}
{{- range $k, $_ := (.values.config | default dict) -}}
{{- $names = append $names $k -}}
{{- end -}}
{{- range (.values.extraEnv | default list) -}}
{{- if kindIs "map" . -}}{{- $names = append $names (toString .name) -}}{{- end -}}
{{- end -}}
{{- if include "goat.caBundle.enabled" .root -}}
{{- $names = append $names "GOAT_CA_BUNDLE" -}}
{{- end -}}
{{- $windmill := list "MODE" "WORKER_GROUP" "WORKER_TAGS" "WHITELIST_ENVS" "DISABLE_NSJAIL" "JOB_DEFAULT_TIMEOUT" "DATABASE_URL" "DATABASE_CONNECTIONS" "_WMILL_DB_USER" "_WMILL_DB_PASSWORD" -}}
{{- $out := list -}}
{{- range ($names | uniq | sortAlpha) -}}
{{- if not (has . $windmill) -}}{{- $out = append $out . -}}{{- end -}}
{{- end -}}
{{- join "," $out -}}
{{- end }}

{{/*
The env entries a GOAT worker gets from the chart: goat.worker.appEnv and,
unless the worker sets it itself, WHITELIST_ENVS. Params: root, values.
*/}}
{{- define "goat.worker.env" -}}
{{- $appEnv := include "goat.worker.appEnv" . -}}
{{- $appEnv -}}
{{- if not (include "goat.env.userSet" (dict "values" .values "key" "WHITELIST_ENVS")) }}
- name: WHITELIST_ENVS
  value: {{ include "goat.worker.whitelist" (dict "root" .root "values" .values "appEnv" $appEnv) | quote }}
{{- end -}}
{{- end }}
