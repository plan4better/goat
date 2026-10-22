#!/usr/bin/env bash
# Renders compose.yaml for each deployment variant and checks invariants, then
# validates the Caddyfile in every TLS mode. Needs docker (no containers run
# except `caddy validate`).
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
fail() { echo "FAIL [$variant]: $*" >&2; exit 1; }

render() {
  # render DIR -> compose config as JSON for the profiles in its .env
  (cd "$1" && docker compose --env-file .env -f compose.yaml config --format json)
}

make_variant() {
  local dir
  dir=$(mktemp -d)
  cp -r "$here/compose.yaml" "$here/.env.example" "$here/setup.sh" "$here/init" "$dir/"
  mkdir -p "$dir/certs"
  (cd "$dir" && SETUP_SKIP_DOCKER_CHECK=1 ./setup.sh --non-interactive --admin-email admin@example.org "$@" >/dev/null)
  echo "$dir"
}

check_common() {
  local json="$1"
  # Only Caddy publishes ports beyond loopback.
  local exposed
  exposed=$(jq -r '.services | to_entries[] | select(.value.ports) | .key as $k | .value.ports[] | select((.host_ip // "") != "127.0.0.1") | $k' <<<"$json" | sort -u | tr '\n' ' ')
  [ "$exposed" = "caddy " ] || fail "services publishing ports: $exposed"
  # Every Windmill worker running goatlib jobs has a whitelist.
  for w in windmill-worker-tools windmill-worker-workflows windmill-worker-print; do
    jq -e --arg w "$w" '.services[$w].environment.WHITELIST_ENVS | length > 100' <<<"$json" >/dev/null || fail "$w lacks WHITELIST_ENVS"
  done
  # Windmill passes every whitelisted name to jobs, as "" when unset, so each
  # one must be defined on the worker.
  for w in windmill-worker-tools windmill-worker-workflows windmill-worker-print; do
    missing=$(jq -r --arg w "$w" '.services[$w].environment as $e | $e.WHITELIST_ENVS | split(",") | map(select(. as $n | $e | has($n) | not)) | join(" ")' <<<"$json")
    [ -z "$missing" ] || fail "$w whitelists unset names: $missing"
  done
  # No service is pointed at Plan4Better's dev infrastructure.
  if jq -r '.. | strings' <<<"$json" | grep -q "dev.plan4better.de"; then fail "dev.plan4better.de referenced"; fi
  # Every service logs with rotation.
  jq -e '[.services[] | .logging.options["max-size"]] | all' <<<"$json" >/dev/null || fail "service without log rotation"
  # Public URL never ends with a slash.
  jq -e '.services.web.environment.NEXTAUTH_URL | endswith("/") | not' <<<"$json" >/dev/null || fail "trailing slash in public url"
  # DuckDB spills to disk only at its own budget, so geoapi's and processes'
  # budgets stay under 3/4 of their memory limits: geoapi's pool shares one
  # connection budgeted POOL_SIZE x MEMORY_LIMIT, plus its read and write
  # connections; processes keeps three connections. Unset values are the
  # services' code defaults.
  jq -e '
    def bytes: tostring | capture("^(?<n>[0-9.]+) *(?<u>[A-Za-z]*)$")
      | (.n | tonumber) * ({"": 1, "KB": 1e3, "MB": 1e6, "GB": 1e9, "KiB": 1024, "MiB": 1048576, "GiB": 1073741824}[.u]);
    .services as $s
    | ($s.geoapi.environment) as $g
    | ($s.processes.environment) as $p
    | (($g.GEOAPI_DUCKDB_MEMORY_LIMIT // "1GB" | bytes) * (($g.GEOAPI_DUCKLAKE_POOL_SIZE // "4" | tonumber) + 2)
        < ($s.geoapi.deploy.resources.limits.memory | bytes) * 0.75)
    and (($p.PROCESSES_DUCKDB_MEMORY_LIMIT // "1.2GB" | bytes) * 3
        < ($s.processes.deploy.resources.limits.memory | bytes) * 0.75)
  ' <<<"$json" >/dev/null || fail "geoapi or processes DuckDB budgets exceed 3/4 of their memory limits"
  # Windmill holds a bounded pool per container: unset, the server's grows to
  # 50; workers below 3 stop at start on Windmill 1.607.
  jq -e '.services["windmill-server"].environment.DATABASE_CONNECTIONS | tonumber | . >= 1 and . <= 20' <<<"$json" >/dev/null || fail "windmill-server without a bounded DATABASE_CONNECTIONS"
  for w in windmill-worker-default windmill-worker-tools windmill-worker-workflows windmill-worker-print; do
    jq -e --arg w "$w" '.services[$w].environment.DATABASE_CONNECTIONS | tonumber | . >= 3' <<<"$json" >/dev/null || fail "$w DATABASE_CONNECTIONS below 3 or unset"
  done
}

variant=auto
d=$(make_variant --public-url https://goat.example.org --tls auto --acme-email ops@plan4better.de)
j=$(render "$d"); check_common "$j"
jq -e '.services.web.environment.NEXT_PUBLIC_GEOAPI_URL == "https://goat.example.org/geoapi"' <<<"$j" >/dev/null || fail "geoapi url"
jq -e '.services.web.environment.NEXT_PUBLIC_KEYCLOAK_ISSUER == "https://goat.example.org/keycloak/realms/goat"' <<<"$j" >/dev/null || fail "issuer"
jq -e '.services.core.environment.KEYCLOAK_SERVER_URL == "http://keycloak:8080/keycloak"' <<<"$j" >/dev/null || fail "core keycloak url"
jq -e '.services.caddy.environment.GOAT_TLS_EMAIL_LINE == "tls ops@plan4better.de"' <<<"$j" >/dev/null || fail "acme email line"
jq -e '.services | has("garage") and has("keycloak")' <<<"$j" >/dev/null || fail "bundled profiles missing"
# Email off by default; Keycloak gets an empty server and no login.
jq -e '.services.core.environment.SMTP_HOST == "" and .services.keycloak.environment.GOAT_SMTP_HOST == ""' <<<"$j" >/dev/null || fail "smtp host not empty by default"
jq -e '.services.keycloak.environment.GOAT_SMTP_AUTH == ""' <<<"$j" >/dev/null || fail "keycloak smtp auth on without a user"
# Anyone may create an organization unless the setting says otherwise.
jq -e '.services.core.environment.ALLOW_ORGANIZATION_CREATION == "true"' <<<"$j" >/dev/null || fail "organization creation not open by default"

# Odoo connection and support tickets off by default: all four settings empty, default post action.
jq -e '.services.core.environment | .ODOO_URL == "" and .ODOO_DB == "" and .ODOO_SUPPORT_API_KEY == "" and .ODOO_SUPPORT_TEAM_ID == ""' <<<"$j" >/dev/null || fail "odoo settings not empty by default"
jq -e '.services.core.environment.ODOO_SUPPORT_POST_ACTION == "GOAT: post message as ticket participant"' <<<"$j" >/dev/null || fail "support post action default"
# The secret goes to core only, never to Windmill workers.
jq -e '[.services[] | select(.environment | has("ODOO_SUPPORT_API_KEY"))] | length == 1' <<<"$j" >/dev/null || fail "support api key outside core"
# Token client allow-list off by default: empty for every service that verifies tokens.
jq -e '[.services | (.core, .geoapi, .processes, .catalog) | .environment.AUTH_ALLOWED_CLIENTS] | all(. == "")' <<<"$j" >/dev/null || fail "allowed clients not empty by default"

variant=support
d2=$(make_variant --public-url https://goat.example.org --tls auto --acme-email ops@plan4better.de)
cat >> "$d2/.env" <<'VARS'
ODOO_URL=https://odoo.example.org
ODOO_DB=odoo-db
ODOO_SUPPORT_API_KEY=bridge-key
ODOO_SUPPORT_TEAM_ID=7
VARS
j2=$(render "$d2"); check_common "$j2"
jq -e '.services.core.environment | .ODOO_URL == "https://odoo.example.org" and .ODOO_DB == "odoo-db" and .ODOO_SUPPORT_API_KEY == "bridge-key" and .ODOO_SUPPORT_TEAM_ID == "7"' <<<"$j2" >/dev/null || fail "odoo settings not passed to core"
# processes reads the open-data mirror from the catalog bucket.
jq -e '.services.processes.environment | has("CATALOG_S3_BUCKET")' <<<"$j" >/dev/null || fail "catalog bucket not passed to processes"
# The edge proxy must not cap request bodies (support uploads take up to 55 MiB).
! grep -q "^[[:space:]]*request_body" "$here/init/caddy/Caddyfile" || fail "Caddyfile caps the request body"

variant=smtp
cat >> "$d/.env" <<'VARS'
SMTP_HOST=mail.example.org
SMTP_USER=mailer@example.org
SMTP_PASSWORD=secret
VARS
j=$(render "$d"); check_common "$j"
# core and Keycloak send through the same server as the same sender.
jq -e '.services.core.environment.SMTP_HOST == "mail.example.org" and .services.keycloak.environment.GOAT_SMTP_HOST == .services.core.environment.SMTP_HOST' <<<"$j" >/dev/null || fail "core and keycloak smtp host differ"
jq -e '.services.keycloak.environment.GOAT_SMTP_PORT == .services.core.environment.SMTP_PORT' <<<"$j" >/dev/null || fail "core and keycloak smtp port differ"
jq -e '.services.keycloak.environment | .GOAT_SMTP_AUTH == "true" and .GOAT_SMTP_FROM == "mailer@example.org"' <<<"$j" >/dev/null || fail "keycloak smtp login or sender"

variant=support-email
# NEXT_PUBLIC_SUPPORT_EMAIL reaches the web container, and is empty (the app uses its default) while unset.
d=$(make_variant --public-url https://goat.example.org --tls off)
j=$(render "$d")
jq -e '.services.web.environment.NEXT_PUBLIC_SUPPORT_EMAIL == ""' <<<"$j" >/dev/null || fail "support email not empty by default"
echo "NEXT_PUBLIC_SUPPORT_EMAIL=help@example.org" >> "$d/.env"
j=$(render "$d"); check_common "$j"
jq -e '.services.web.environment.NEXT_PUBLIC_SUPPORT_EMAIL == "help@example.org"' <<<"$j" >/dev/null || fail "support email not passed to web"

variant=organization-creation
d=$(make_variant --public-url https://goat.example.org --tls off)
echo "ALLOW_ORGANIZATION_CREATION=false" >> "$d/.env"
j=$(render "$d"); check_common "$j"
jq -e '.services.core.environment.ALLOW_ORGANIZATION_CREATION == "false"' <<<"$j" >/dev/null || fail "organization creation setting not passed to core"

variant=off-ip-port
d=$(make_variant --public-url http://10.0.0.5:8080 --tls off)
j=$(render "$d"); check_common "$j"
jq -e '.services.caddy.ports | map(.published) | index("8080") != null' <<<"$j" >/dev/null || fail "port 8080 not published"
jq -e '.services.keycloak.environment.GOAT_SSL_REQUIRED == "none"' <<<"$j" >/dev/null || fail "ssl required"

variant=lb
d=$(make_variant --public-url https://goat.example.org --tls off --http-port 8081)
j=$(render "$d"); check_common "$j"
jq -e '.services.caddy.networks.goat.aliases == ["goat-edge.internal"]' <<<"$j" >/dev/null || fail "alias must not be the public host"
jq -e '[.services.caddy.ports[] | select(.target == 443)] | all(.host_ip == "127.0.0.1")' <<<"$j" >/dev/null || fail "443 published beyond loopback with TLS off"

variant=external
d=$(make_variant --public-url https://goat.example.org --tls auto)
sed -i 's/^COMPOSE_PROFILES=.*/COMPOSE_PROFILES=/' "$d/.env"
cat >> "$d/.env" <<'VARS'
S3_ENDPOINT_URL=https://s3.example.org
S3_REGION=eu-central-1
KEYCLOAK_PUBLIC_URL=https://login.example.org
KEYCLOAK_INTERNAL_URL=https://login.example.org
VARS
j=$(render "$d"); check_common "$j"
jq -e '.services | (has("garage") or has("keycloak") or has("garage-init")) | not' <<<"$j" >/dev/null || fail "bundled services still active"
jq -e '.services.core.environment.S3_ENDPOINT_URL == "https://s3.example.org"' <<<"$j" >/dev/null || fail "external s3"
jq -e '.services.web.environment.NEXT_PUBLIC_KEYCLOAK_ISSUER == "https://login.example.org/realms/goat"' <<<"$j" >/dev/null || fail "external issuer"
# A realm shared with other applications: the allow-list reaches every service that verifies tokens.
echo "AUTH_ALLOWED_CLIENTS=goat,goat-scripts" >> "$d/.env"
j=$(render "$d"); check_common "$j"
jq -e '[.services | (.core, .geoapi, .processes, .catalog) | .environment.AUTH_ALLOWED_CLIENTS] | all(. == "goat,goat-scripts")' <<<"$j" >/dev/null || fail "allowed clients not passed to the APIs"

variant=auth-false
d=$(make_variant --public-url http://localhost --tls off)
sed -i 's/^AUTH=.*/AUTH=False/; s/^COMPOSE_PROFILES=.*/COMPOSE_PROFILES=garage/' "$d/.env"
j=$(render "$d"); check_common "$j"
jq -e '.services.web.environment.NEXT_PUBLIC_AUTH == "False" and .services.geoapi.environment.AUTH == "False"' <<<"$j" >/dev/null || fail "auth flag"

# Caddyfile in every TLS mode
variant=caddy
for mode in auto custom internal off; do
  case $mode in
    auto) site=goat.example.org ;; custom|internal) site=https://goat.example.org ;; off) site=:80 ;;
  esac
  certs=$(mktemp -d)
  if [ "$mode" = custom ]; then
    openssl req -x509 -newkey rsa:2048 -nodes -keyout "$certs/key.pem" -out "$certs/cert.pem" -days 1 -subj "/CN=goat.example.org" >/dev/null 2>&1
  fi
  docker run --rm -v "$here/init/caddy:/etc/caddy:ro" -v "$certs:/certs:ro" \
    -e GOAT_SITE_ADDRESS="$site" -e GOAT_HOSTNAME=goat.example.org -e GOAT_TLS="$mode" -e GOAT_TLS_EMAIL_LINE="tls ops@plan4better.de" \
    -e GOAT_HTTP_PORT=80 -e GOAT_HTTPS_PORT=443 -e GOAT_TRUSTED_PROXIES=private_ranges \
    -e GOAT_ADMIN_ALLOW_CIDRS="0.0.0.0/0 ::/0" \
    caddy:2.10-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>"$certs/err" \
    || { cat "$certs/err" >&2; fail "caddyfile invalid in mode $mode"; }
done
# auto without an email: the line is empty
docker run --rm -v "$here/init/caddy:/etc/caddy:ro" -e GOAT_SITE_ADDRESS=goat.example.org -e GOAT_HOSTNAME=goat.example.org -e GOAT_TLS=auto \
  -e GOAT_TLS_EMAIL_LINE= -e GOAT_HTTP_PORT=80 -e GOAT_HTTPS_PORT=443 -e GOAT_TRUSTED_PROXIES=private_ranges \
  -e GOAT_ADMIN_ALLOW_CIDRS="0.0.0.0/0 ::/0" caddy:2.10-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 \
  || fail "caddyfile invalid without acme email"

echo "config-check: PASS"
