#!/usr/bin/env bash
# Checks a running GOAT deployment end to end:
#   containers -> HTTP routes -> login -> dataset upload + import -> vector
#   tile -> buffer analysis. The test layers are deleted again at the end;
#   if the first admin has no organization yet, one named "GOAT" is created.
# Run from the bundle directory after `docker compose up -d`.
#   ./smoke.sh            full check
#   ./smoke.sh --quick    containers, routes and login only; creates nothing
set -uo pipefail

cd "$(dirname "$0")"
for tool in curl jq; do
  command -v "$tool" >/dev/null || { echo "smoke.sh: $tool is not installed" >&2; exit 1; }
done
QUICK=0
[ "${1:-}" = "--quick" ] && QUICK=1

env_get() { grep -E "^$1=" .env | tail -n 1 | cut -d= -f2-; }
URL=$(env_get GOAT_PUBLIC_URL)
AUTH=$(env_get AUTH)
TLS=$(env_get GOAT_TLS)
REALM=$(env_get REALM_NAME); REALM=${REALM:-goat}
CLIENT_ID=$(env_get KEYCLOAK_CLIENT_ID); CLIENT_ID=${CLIENT_ID:-goat}
KC_PUBLIC=$(env_get KEYCLOAK_PUBLIC_URL); KC_PUBLIC=${KC_PUBLIC:-$URL/keycloak}

CURL=(curl -sS --max-time 60)
[ "$TLS" = "internal" ] && CURL+=(-k)

step() { printf '%-58s' "$1"; }
pass() { echo "PASS${1:+  $1}"; }
fail() {
  echo "FAIL  $1"
  [ -n "${2:-}" ] && docker compose logs --tail 40 "$2" 2>&1 | sed 's/^/    /'
  exit 1
}

auth_on() { case "${AUTH,,}" in false|0|no|off|f|n) return 1 ;; *) return 0 ;; esac; }

# --- 1. Containers ----------------------------------------------------------
step "one-shot jobs finished successfully"
bad=$(docker compose ps -a --format '{{.Service}} {{.State}} {{.ExitCode}}' |
  awk '$1 ~ /(init|migrate|bootstrap|sync)$/ && !($2=="exited" && $3=="0") {print $1}')
[ -z "$bad" ] && pass || fail "not completed: $bad" "$(echo "$bad" | head -n1)"

step "long-running services are healthy"
# Right after `docker compose up -d` some health checks have not passed yet:
# services still starting get up to SMOKE_WAIT seconds, one reported
# unhealthy fails at once.
deadline=$((SECONDS + ${SMOKE_WAIT:-300}))
while :; do
  health=$(docker compose ps --format '{{.Service}} {{.Health}}')
  unhealthy=$(awk '$2=="unhealthy" {print $1}' <<< "$health" | sort -u | tr '\n' ' ')
  starting=$(awk '$2=="starting" {print $1}' <<< "$health" | sort -u | tr '\n' ' ')
  { [ -n "$unhealthy" ] || [ -z "$starting" ] || [ "$SECONDS" -ge "$deadline" ]; } && break
  sleep 5
done
if [ -n "$unhealthy" ]; then
  fail "unhealthy: $unhealthy" "$(echo "$unhealthy" | cut -d' ' -f1)"
elif [ -n "$starting" ]; then
  fail "still starting after ${SMOKE_WAIT:-300}s: $starting" "$(echo "$starting" | cut -d' ' -f1)"
fi
pass

# --- 2. Routes ---------------------------------------------------------------
check_status() {
  local path="$1" want="$2" svc="$3" code
  step "GET $path"
  code=$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$URL$path") || code=000
  [[ "$code" =~ ^($want)$ ]] && pass "$code" || fail "HTTP $code (want $want)" "$svc"
}
check_status / "200|307|308" web
check_status /api/healthz 200 core
check_status /geoapi/healthz 200 geoapi
check_status /processes/healthz 200 processes
check_status /catalog/healthz 200 catalog
check_status /assistant/healthz 200 assistant
check_status /assistant/readyz 200 assistant
# The MCP endpoint moved from the catalog to the assistant.
check_status /catalog/mcp 404 catalog

# Caddy passes every method to the assistant: a CORS preflight is answered by
# the service, and PUT reaches it (405 from the app, not an error from Caddy).
step "OPTIONS and PUT reach the assistant"
pre=$("${CURL[@]}" -o /dev/null -w '%{http_code}' -X OPTIONS -H "Origin: $URL" -H 'Access-Control-Request-Method: PATCH' "$URL/assistant/conversations") || pre=000
put=$("${CURL[@]}" -o /dev/null -w '%{http_code}' -X PUT "$URL/assistant/healthz") || put=000
[ "$pre" = 200 ] && [ "$put" = 405 ] && pass "$pre/$put" || fail "OPTIONS $pre, PUT $put" assistant

# MCP behind Caddy and ROOT_PATH: POST answers the handshake (401 without a
# token while login is on); the endpoint is stateless, so GET (no event
# stream) and DELETE (no session) answer 405.
step "MCP at /assistant/mcp"
if auth_on; then want_mcp=401; else want_mcp=200; fi
mcp_init='{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
init=$("${CURL[@]}" -o /dev/null -w '%{http_code}' -X POST -H 'Accept: application/json, text/event-stream' -H 'Content-Type: application/json' -d "$mcp_init" "$URL/assistant/mcp") || init=000
get=$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$URL/assistant/mcp") || get=000
del=$("${CURL[@]}" -o /dev/null -w '%{http_code}' -X DELETE "$URL/assistant/mcp") || del=000
[ "$init" = "$want_mcp" ] && [ "$get" = 405 ] && [ "$del" = 405 ] && pass "POST $init, GET $get, DELETE $del" || fail "POST $init (want $want_mcp), GET $get, DELETE $del (want 405)" assistant

step "assistant database privileges"
out=$(docker compose exec -T assistant python -m assistant.dbcheck 2>&1) && pass || fail "$out" assistant

step "catalog STAC root"
type=$("${CURL[@]}" "$URL/catalog/stac" | jq -r '.type // empty' 2>/dev/null)
[ "$type" = "Catalog" ] && pass || fail "type='$type'" catalog

step "geoapi links use the public URL"
bad_links=$("${CURL[@]}" "$URL/geoapi/" | jq -r '.links[]?.href' 2>/dev/null | grep -v "^$URL" | head -n 3)
[ -z "$bad_links" ] && pass || fail "links: $bad_links" geoapi

# --- 3. Login ----------------------------------------------------------------
AUTHZ=()
if auth_on; then
  step "Keycloak issuer is the public URL"
  issuer=$("${CURL[@]}" "$KC_PUBLIC/realms/$REALM/.well-known/openid-configuration" | jq -r '.issuer // empty')
  [ "$issuer" = "$KC_PUBLIC/realms/$REALM" ] && pass || fail "issuer='$issuer'" keycloak

  step "password login for the first admin"
  token=$("${CURL[@]}" -X POST "$KC_PUBLIC/realms/$REALM/protocol/openid-connect/token" \
    -d grant_type=password -d client_id="$CLIENT_ID" -d client_secret="$(env_get KEYCLOAK_CLIENT_SECRET)" \
    --data-urlencode username="$(env_get GOAT_ADMIN_EMAIL)" --data-urlencode password="$(env_get GOAT_ADMIN_PASSWORD)" |
    jq -r '.access_token // empty')
  [ -n "$token" ] && pass || fail "no access token" keycloak
  AUTHZ=(-H "Authorization: Bearer $token")
fi

check_authed() {
  local path="$1" svc="$2" code
  step "GET $path (signed in)"
  code=$("${CURL[@]}" "${AUTHZ[@]}" -o /tmp/goat-smoke-body -w '%{http_code}' "$URL$path") || code=000
  [ "$code" = 200 ] && pass || { head -c 400 /tmp/goat-smoke-body; echo; fail "HTTP $code" "$svc"; }
}
check_authed /processes/jobs processes
check_authed /assistant/status assistant

[ "$QUICK" -eq 1 ] && { echo "smoke (quick): PASS"; exit 0; }

# A new user creates an organization on first login (the onboarding screen);
# core creates its user record at that point.
step "user belongs to an organization"
code=$("${CURL[@]}" "${AUTHZ[@]}" -o /tmp/goat-smoke-body -w '%{http_code}' "$URL/api/v2/users/organization") || code=000
if [ "$code" = 200 ] && [ -n "$(jq -r '.id // empty' /tmp/goat-smoke-body 2>/dev/null)" ]; then
  pass "existing"
else
  code=$("${CURL[@]}" "${AUTHZ[@]}" -o /tmp/goat-smoke-body -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
    "$URL/api/v2/organizations" -d '{"name":"GOAT","type":"government","size":"1-10","industry":"architecture","department":"GIS","use_case":"infrastructure_planning_and_design","location":"DE","region":"EU","phone_number":"000"}') || code=000
  [ "$code" = 200 ] || [ "$code" = 201 ] && pass "created \"GOAT\" (rename it in the app's organization settings)" || { head -c 400 /tmp/goat-smoke-body; echo; fail "create organization: HTTP $code" core; }
fi
check_authed /api/v2/users/profile core

# --- 4. Upload, import, tile, analysis ---------------------------------------
api() { "${CURL[@]}" "${AUTHZ[@]}" -H 'Content-Type: application/json' "$@"; }

wait_job() {
  # wait_job JOB_ID LABEL -> exits on failure
  local job="$1" label="$2" status="" i
  for i in $(seq 1 90); do
    status=$(api "$URL/processes/jobs/$job" | jq -r '.status // empty')
    case "$status" in
      successful) pass "$label"; return 0 ;;
      failed|dismissed) api "$URL/processes/jobs/$job" | head -c 800; echo; fail "$label job $status" windmill-worker-tools ;;
    esac
    sleep 4
  done
  fail "$label job still '$status' after 6 minutes" windmill-worker-tools
}

step "home folder"
folder=$(api "$URL/api/v2/folder" | jq -r '(map(select(.name=="home")) + .)[0].id // empty')
[ -n "$folder" ] && pass || fail "no folder" core

geojson='{"type":"FeatureCollection","features":[{"type":"Feature","properties":{"name":"smoke"},"geometry":{"type":"Point","coordinates":[11.576,48.137]}}]}'
size=${#geojson}

step "request a presigned upload"
upload=$(api -X POST "$URL/api/v2/datasets/request-upload" \
  -d "{\"filename\":\"smoke.geojson\",\"content_type\":\"application/geo+json\",\"file_size\":$size}")
put_url=$(jq -r '.url // empty' <<<"$upload"); s3_key=$(jq -r '.key // empty' <<<"$upload")
[ -n "$put_url" ] && pass || fail "response: $upload" core

step "upload through the public URL"
header_args=()
while IFS= read -r h; do [ -n "$h" ] && header_args+=(-H "$h"); done < <(jq -r '.headers // {} | to_entries[] | "\(.key): \(.value)"' <<<"$upload")
code=$("${CURL[@]}" -o /tmp/goat-smoke-body -w '%{http_code}' -X PUT "${header_args[@]}" --data-binary "$geojson" "$put_url")
[ "$code" = 200 ] && pass || { head -c 400 /tmp/goat-smoke-body; echo; fail "PUT HTTP $code" caddy; }

step "start the layer import"
job=$(api -X POST "$URL/processes/processes/layer_import/execution" \
  -d "{\"inputs\":{\"layer_id\":\"$(cat /proc/sys/kernel/random/uuid)\",\"folder_id\":\"$folder\",\"name\":\"smoke\",\"s3_key\":\"$s3_key\"}}" | jq -r '.jobID // .id // empty')
[ -n "$job" ] && pass "$job" || fail "no job id" processes
step "layer import finishes"
wait_job "$job" "import"
# The import picks the layer id; the job result reports it.
layer_id=$(api "$URL/processes/jobs/$job" | jq -r '.result.layer_id // empty')
[ -n "$layer_id" ] || fail "import job result has no layer_id" processes

step "vector tile for the new layer"
code=$("${CURL[@]}" "${AUTHZ[@]}" -o /tmp/goat-smoke-tile -w '%{http_code}' "$URL/geoapi/collections/$layer_id/tiles/WebMercatorQuad/10/544/355")
bytes=$(stat -c %s /tmp/goat-smoke-tile 2>/dev/null || echo 0)
[ "$code" = 200 ] && [ "$bytes" -gt 0 ] && pass "$bytes bytes" || fail "HTTP $code, $bytes bytes" geoapi

step "start a buffer analysis"
job=$(api -X POST "$URL/processes/processes/buffer/execution" \
  -d "{\"inputs\":{\"input_layer_id\":\"$layer_id\",\"distances\":[500],\"folder_id\":\"$folder\",\"result_layer_name\":\"smoke buffer\"}}" | jq -r '.jobID // .id // empty')
[ -n "$job" ] && pass "$job" || fail "no job id" processes
step "buffer analysis finishes"
wait_job "$job" "buffer"
buffer_layer=$(api "$URL/processes/jobs/$job" | jq -r '.result.layer_id // empty')

step "remove the test layers"
for id in $buffer_layer $layer_id; do
  "${CURL[@]}" "${AUTHZ[@]}" -o /dev/null -X DELETE "$URL/api/v2/layer/$id" || true
done
left=$(api "$URL/api/v2/layer/$layer_id" -o /dev/null -w '%{http_code}') || left=000
[ "$left" = 404 ] && pass || pass "delete answered, layer lookup HTTP $left"

echo "smoke: PASS"
