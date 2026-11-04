#!/usr/bin/env bash
# End-to-end smoke test: install the chart on a throwaway k3d cluster and
# assert every service comes up. All GOAT images on ghcr.io are public, so no
# pull secret is needed.
#
# A fresh cluster installs with ONE `helm install --wait` — that is what this
# script asserts. Two things make that possible:
#   - The CNPG operator's CRDs are vendored under goat/crds/, which Helm
#     applies before rendering any template, so the operator and the chart's
#     Postgres `Cluster` CR can be created in the same call.
#   - The one-time bootstrap that geoapi/processes (the DuckLake catalog) and
#     the windmill server/workers (the `windmill` database) depend on runs as
#     INIT CONTAINERS on those Deployments, not as post-install hooks. Helm
#     holds post-install hooks until every resource is Ready under --wait, so
#     hooks those pods needed in order to become Ready deadlocked the install
#     (chart 0.5.0 before this change needed 3 sequenced helm calls for it).
# `core.migrate` is still a post-install hook; nothing needs the alembic
# schema to go Ready, so it runs once the release is up.
set -euo pipefail

CLUSTER="${CLUSTER:-goat-smoke}"
NS="${NS:-goat}"
RELEASE="${RELEASE:-goat}"
CHART_DIR="$(cd "$(dirname "$0")" && pwd)/goat"
VALUES="$CHART_DIR/ci/values-smoke.yaml"

cleanup() {
  if [ "${KEEP:-0}" != "1" ]; then
    echo "==> Deleting cluster $CLUSTER"
    k3d cluster delete "$CLUSTER" >/dev/null 2>&1 || true
  else
    echo "==> KEEP=1, leaving cluster $CLUSTER up"
  fi
}
trap cleanup EXIT

echo "==> Creating k3d cluster $CLUSTER"
k3d cluster create "$CLUSTER" --wait --agents 0

echo "==> helm dependency update"
helm dependency update "$CHART_DIR"

echo "==> Single helm install --wait (fresh cluster, full smoke values)"
helm install "$RELEASE" "$CHART_DIR" \
  --namespace "$NS" --create-namespace \
  -f "$VALUES" \
  --wait --timeout 25m

echo "==> Rendered NOTES.txt"
helm get notes "$RELEASE" --namespace "$NS"

# On a fresh install the windmill bootstrap hook restarts processes once it
# has minted the token (processes came up before the hook, without it). Let
# that rollout finish first, including the old pod's shutdown: `rollout
# status` returns once the new pod is available, and `wait pod --all` below
# then fails with NotFound on the old pod as it disappears (seen for real).
PROCESSES_DEPLOY=$(kubectl -n "$NS" get deploy -l app.kubernetes.io/component=processes \
  -o jsonpath='{.items[0].metadata.name}')
echo "==> Waiting for the $PROCESSES_DEPLOY rollout"
kubectl -n "$NS" rollout status "deploy/$PROCESSES_DEPLOY" --timeout=10m
TERMINATING=$(kubectl -n "$NS" get pod \
  -o jsonpath='{range .items[?(@.metadata.deletionTimestamp)]}{.metadata.name}{" "}{end}')
if [ -n "$TERMINATING" ]; then
  # shellcheck disable=SC2086 # one argument per pod name
  kubectl -n "$NS" wait --for=delete pod $TERMINATING --timeout=5m
fi

echo "==> Waiting for all pods Ready"
kubectl -n "$NS" wait --for=condition=Ready pod --all --timeout=10m

echo "==> Asserting the migrate hook reached alembic head"
CORE_POD=$(kubectl -n "$NS" get pod -l app.kubernetes.io/component=core \
  -o jsonpath='{.items[0].metadata.name}')
if [ -z "$CORE_POD" ]; then
  echo "FAIL: no pod found for component=core"
  exit 1
fi
# alembic.ini lives in /app/apps/core (see the migrate hook's own `cd`) —
# running `alembic` from the container's default workdir fails with
# "No config file 'alembic.ini' found", which pipefail then turns into a
# silent script abort with no FAIL message printed (found running this
# script for real; helm template / unit tests never exec into a pod).
CURRENT=$(kubectl -n "$NS" exec "$CORE_POD" -- sh -c 'cd /app/apps/core && alembic current' 2>/dev/null \
  | grep -oE '^[0-9a-zA-Z_]+' | head -1)
HEAD=$(kubectl -n "$NS" exec "$CORE_POD" -- sh -c 'cd /app/apps/core && alembic heads' 2>/dev/null \
  | grep -oE '^[0-9a-zA-Z_]+' | head -1)
if [ -z "$CURRENT" ] || [ "$CURRENT" != "$HEAD" ]; then
  echo "FAIL: alembic current='$CURRENT' != heads='$HEAD'"
  kubectl -n "$NS" logs "job/$RELEASE-core-migrate" || true
  exit 1
fi
echo "    alembic at head: $HEAD"

echo "==> Health-checking each service"
check() {
  local component="$1" port="$2" path="$3"
  local pod
  pod=$(kubectl -n "$NS" get pod -l "app.kubernetes.io/component=$component" \
    -o jsonpath='{.items[0].metadata.name}')
  # A label matching zero pods leaves $pod empty; `kubectl exec ""` would
  # fail with a raw kubectl error and no FAIL: message (the same class of
  # silent-abort bug the alembic check above was fixed for — guard it the
  # same way here).
  if [ -z "$pod" ]; then
    echo "FAIL: no pod found for component=$component"
    exit 1
  fi
  local code
  code=$(kubectl -n "$NS" exec "$pod" -- \
    python -c "import urllib.request,sys;sys.stdout.write(str(urllib.request.urlopen('http://127.0.0.1:$port$path',timeout=10).status))")
  if [ "$code" != "200" ]; then
    echo "FAIL: $component $path returned $code"
    kubectl -n "$NS" logs "$pod" --tail=50
    exit 1
  fi
  echo "    $component$path -> 200"
}

check core      8000 /api/healthz
check geoapi    8000 /healthz
check processes 8000 /healthz
check catalog   8400 /healthz
# /readyz: the assistant reaches the chart's Postgres and Redis.
check assistant 8500 /readyz

echo "==> Asserting processes lists jobs without a token (auth off, windmill token wired)"
# Two chart 0.5.0 regressions end at this one call, GET /jobs
# (list_jobs: Depends(get_user_id), then a windmill query):
#   - 401: the chart set no AUTH for geoapi and processes, so their code
#     default (AUTH on) applied while core/web ran auth off. With no login
#     there is no token, and every route that needs a user answered 401.
#   - 500: processes reads WINDMILL_TOKEN from the bootstrap hook's Secret at
#     pod start, but on a fresh install the pod starts before that
#     post-install hook runs, and nothing restarted it: every windmill call
#     (tool runs, job listing) failed until a manual restart.
# The smoke values leave auth off, so this must be a plain 200.
jobs_code() {
  local pod
  pod=$(kubectl -n "$NS" get pod -l app.kubernetes.io/component=processes \
    --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}')
  if [ -z "$pod" ]; then
    echo "FAIL: no running pod found for component=processes" >&2
    return 1
  fi
  kubectl -n "$NS" exec "$pod" -- python -c "
import sys, urllib.request, urllib.error
try:
    code = urllib.request.urlopen('http://127.0.0.1:8000/jobs', timeout=30).status
except urllib.error.HTTPError as e:
    code = e.code
sys.stdout.write(str(code))
"
}
dump_processes() {
  local pod
  pod=$(kubectl -n "$NS" get pod -l app.kubernetes.io/component=processes \
    -o jsonpath='{.items[0].metadata.name}')
  kubectl -n "$NS" exec "$pod" -- printenv AUTH || true
  kubectl -n "$NS" exec "$pod" -- sh -c 'echo "WINDMILL_TOKEN length: ${#WINDMILL_TOKEN}"' || true
  kubectl -n "$NS" logs "$pod" --tail=30 || true
}
JOBS_CODE=$(jobs_code) || JOBS_CODE=""
if [ "$JOBS_CODE" != "200" ]; then
  echo "FAIL: processes GET /jobs without a token returned '${JOBS_CODE}', expected 200 (401 = AUTH on again, 500 = no windmill token)"
  dump_processes
  exit 1
fi
echo "    processes /jobs (no token) -> 200"

# The pod template carries the fingerprint of the Secret's token — what the
# hook compares to decide on a restart (the 200 above shows the pods have it).
TOKEN_SECRET="$RELEASE-windmill-token"
case "$RELEASE" in *goat*) ;; *) TOKEN_SECRET="$RELEASE-goat-windmill-token" ;; esac
token_fp() {
  kubectl -n "$NS" get secret "$TOKEN_SECRET" -o jsonpath='{.data.token}' \
    | base64 -d | sha256sum | cut -c1-16
}
template_fp() {
  kubectl -n "$NS" get deploy "$PROCESSES_DEPLOY" \
    -o jsonpath='{.spec.template.metadata.annotations.goat\.plan4better\.de/windmill-token-sha256}'
}
TOKEN_FP=$(token_fp)
if [ -z "$TOKEN_FP" ] || [ "$(template_fp)" != "$TOKEN_FP" ]; then
  echo "FAIL: $PROCESSES_DEPLOY pod template fingerprint '$(template_fp)' != token Secret '$TOKEN_FP'"
  exit 1
fi
echo "    $PROCESSES_DEPLOY runs with the Secret's token ($TOKEN_FP)"

echo "==> Asserting the web bundle has no unresolved APP_NEXT_PUBLIC_*_URL sentinel"
# web has no readiness/liveness probe (Next.js has no bare health endpoint),
# so `check` above can't cover it — precisely the blind spot that let a bare
# install ship with a white-screening web UI (C1 in the 0.5.0 whole-branch
# review). The web image ships its client bundle with literal
# APP_NEXT_PUBLIC_<NAME> placeholders; its entrypoint seds each one it has a
# NEXT_PUBLIC_<NAME> env var for, in place, under /app/apps/web/.next, blanks
# the rest (logging `Clearing APP_NEXT_PUBLIC_<NAME>` for each; older images
# leave them in place), then execs node. So the check reads that log, and the
# bundle for older images. The placeholders live in the JS chunks under
# .next/static, NOT in the served HTML: the previous version of this check
# grepped `/`'s HTML, which contains none even on a broken install, so it
# could never fail. Only the four service URLs are asserted: APP_URL,
# MAPBOX_TOKEN, STATUS_FEED_URL and WEBSITE_URL are legitimately unset in the
# smoke profile.
WEB_POD=$(kubectl -n "$NS" get pod -l app.kubernetes.io/component=web \
  -o jsonpath='{.items[0].metadata.name}')
if [ -z "$WEB_POD" ]; then
  echo "FAIL: no pod found for component=web"
  exit 1
fi
WEB_STATIC=/app/apps/web/.next/static
# The pod is "Ready" as soon as the entrypoint starts (no probe), i.e.
# possibly while its sed pass is still rewriting files: wait for the line it
# prints right before exec'ing node.
for i in $(seq 1 60); do
  if kubectl -n "$NS" logs "$WEB_POD" 2>/dev/null | grep -q '^Starting Nextjs'; then
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "FAIL: web entrypoint never printed 'Starting Nextjs'"
    kubectl -n "$NS" logs "$WEB_POD" --tail=50 || true
    exit 1
  fi
  sleep 2
done
# Guard against a vacuous pass (path moved in a new image, empty dir).
JS_COUNT=$(kubectl -n "$NS" exec "$WEB_POD" -- \
  sh -c "find $WEB_STATIC -type f -name '*.js' | wc -l" | tr -d ' ')
if [ -z "$JS_COUNT" ] || [ "$JS_COUNT" -eq 0 ]; then
  echo "FAIL: no JS chunks under $WEB_STATIC in the web pod — the sentinel check would be vacuous"
  exit 1
fi
# grep exits 1 on "no match" (the pass case) and 2 on a real error.
if ! SENTINEL_FILES=$(kubectl -n "$NS" exec "$WEB_POD" -- \
  sh -c "grep -rlE 'APP_NEXT_PUBLIC_(API|GEOAPI|PROCESSES|CATALOG|ASSISTANT)_URL' $WEB_STATIC; rc=\$?; [ \$rc -le 1 ] || exit \$rc"); then
  echo "FAIL: grep for sentinels in $WEB_STATIC errored in the web pod"
  exit 1
fi
if [ -n "$SENTINEL_FILES" ]; then
  echo "FAIL: web bundle still contains unresolved APP_NEXT_PUBLIC_*_URL sentinels in:"
  echo "$SENTINEL_FILES"
  kubectl -n "$NS" exec "$WEB_POD" -- sh -c \
    "grep -rhoE 'APP_NEXT_PUBLIC_(API|GEOAPI|PROCESSES|CATALOG|ASSISTANT)_URL' $WEB_STATIC | sort | uniq -c" || true
  exit 1
fi
CLEARED=$(kubectl -n "$NS" logs "$WEB_POD" 2>/dev/null \
  | grep -E '^Clearing APP_NEXT_PUBLIC_(API|GEOAPI|PROCESSES|CATALOG)_URL$' || true)
if [ -n "$CLEARED" ]; then
  echo "FAIL: the web entrypoint had no value for:"
  echo "$CLEARED"
  exit 1
fi
echo "    web $WEB_STATIC ($JS_COUNT JS chunks) -> no unresolved API/GEOAPI/PROCESSES/CATALOG/ASSISTANT sentinel"

echo "==> Asserting the catalog serves a valid STAC root with no mirror present"
CATALOG_POD=$(kubectl -n "$NS" get pod -l app.kubernetes.io/component=catalog \
  -o jsonpath='{.items[0].metadata.name}')
if [ -z "$CATALOG_POD" ]; then
  echo "FAIL: no pod found for component=catalog"
  exit 1
fi
kubectl -n "$NS" exec "$CATALOG_POD" -- \
  python -c "import urllib.request,json;d=json.load(urllib.request.urlopen('http://127.0.0.1:8400/stac',timeout=10));assert d.get('type')=='Catalog',d;print('    STAC root OK')"

echo "==> helm upgrade: the bootstrap hook reuses the token and leaves processes alone"
# Before 0.5.1 every post-upgrade hook minted another non-expiring token (and
# never revoked the old one); now it keeps the stored token while windmill
# accepts it, so an upgrade with unchanged values neither rotates the token
# nor restarts processes.
PODS_BEFORE=$(kubectl -n "$NS" get pod -l app.kubernetes.io/component=processes \
  -o jsonpath='{.items[*].metadata.name}')
helm upgrade "$RELEASE" "$CHART_DIR" --namespace "$NS" -f "$VALUES" --wait --timeout 15m >/dev/null
if [ "$(token_fp)" != "$TOKEN_FP" ]; then
  echo "FAIL: helm upgrade rotated the windmill token ($TOKEN_FP -> $(token_fp))"
  exit 1
fi
PODS_AFTER=$(kubectl -n "$NS" get pod -l app.kubernetes.io/component=processes \
  -o jsonpath='{.items[*].metadata.name}')
if [ "$PODS_AFTER" != "$PODS_BEFORE" ]; then
  echo "FAIL: helm upgrade restarted processes ($PODS_BEFORE -> $PODS_AFTER)"
  exit 1
fi
JOBS_CODE=$(jobs_code) || JOBS_CODE=""
if [ "$JOBS_CODE" != "200" ]; then
  echo "FAIL: processes GET /jobs returned '${JOBS_CODE}' after the upgrade, expected 200"
  dump_processes
  exit 1
fi
echo "    token kept ($TOKEN_FP), processes not restarted, /jobs -> 200"

echo "==> Asserting the legacy worker-PVC upgrade guard fires against a live claim"
# 0.4.x per-worker claims are deleted by `helm upgrade` unless the LIVE
# object carries helm.sh/resource-policy=keep; the chart refuses such an
# upgrade (templates/windmill/legacy-persistence-guard.yaml). That guard
# uses `lookup`, which unit tests can only mock, so exercise it for real:
# plant an unannotated claim of this release under the legacy name, expect a
# server-side dry-run upgrade to fail with the annotate command, annotate it,
# expect the same dry-run to pass. --dry-run=server changes nothing.
case "$RELEASE" in
  *goat*) LEGACY_PVC="$RELEASE-windmill-tools-data" ;;
  *) LEGACY_PVC="$RELEASE-goat-windmill-tools-data" ;;
esac
cat <<PVC | kubectl -n "$NS" apply -f - >/dev/null
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: $LEGACY_PVC
  annotations:
    meta.helm.sh/release-name: $RELEASE
    meta.helm.sh/release-namespace: $NS
spec:
  accessModes: [ReadWriteOnce]
  resources: { requests: { storage: 1Mi } }
PVC
drop_legacy_pvc() {
  kubectl -n "$NS" delete pvc "$LEGACY_PVC" --wait=false >/dev/null 2>&1 || true
}
if GUARD_OUT=$(helm upgrade "$RELEASE" "$CHART_DIR" --namespace "$NS" -f "$VALUES" \
    --dry-run=server 2>&1); then
  echo "FAIL: upgrade dry-run passed although $LEGACY_PVC is unannotated"
  drop_legacy_pvc
  exit 1
fi
if ! echo "$GUARD_OUT" | grep -q "annotate pvc $LEGACY_PVC helm.sh/resource-policy=keep"; then
  echo "FAIL: upgrade dry-run failed, but not with the guard's annotate command:"
  echo "$GUARD_OUT" | tail -20
  drop_legacy_pvc
  exit 1
fi
echo "    unannotated $LEGACY_PVC -> upgrade refused with the annotate command"
kubectl -n "$NS" annotate pvc "$LEGACY_PVC" helm.sh/resource-policy=keep >/dev/null
if ! GUARD_OUT=$(helm upgrade "$RELEASE" "$CHART_DIR" --namespace "$NS" -f "$VALUES" \
    --dry-run=server 2>&1); then
  echo "FAIL: upgrade dry-run still refused after annotating $LEGACY_PVC:"
  echo "$GUARD_OUT" | tail -20
  drop_legacy_pvc
  exit 1
fi
echo "    annotated $LEGACY_PVC -> upgrade dry-run passes"
drop_legacy_pvc

echo "==> SMOKE PASS"
