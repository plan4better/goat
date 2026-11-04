#!/usr/bin/env bash
# setup.sh: derived values per URL/TLS mode, and secrets survive re-runs.
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
fail() { echo "FAIL: $*" >&2; exit 1; }

run_case() {
  local dir
  dir=$(mktemp -d)
  cp "$here/setup.sh" "$here/.env.example" "$dir/"
  mkdir -p "$dir/certs"
  (cd "$dir" && SETUP_SKIP_DOCKER_CHECK=1 ./setup.sh --non-interactive "$@" >/dev/null)
  echo "$dir"
}
val() { grep -E "^$2=" "$1/.env" | tail -n1 | cut -d= -f2-; }

# auto: hostname site, standard ports, alias = hostname
d=$(run_case --public-url https://goat.example.org/ --tls auto --admin-email a@example.org)
[ "$(val "$d" GOAT_PUBLIC_URL)" = "https://goat.example.org" ] || fail "trailing slash kept"
[ "$(val "$d" GOAT_SITE_ADDRESS)" = "goat.example.org" ] || fail "auto site address"
[ "$(val "$d" GOAT_NETWORK_ALIAS)" = "goat.example.org" ] || fail "auto alias"
[ "$(val "$d" GOAT_KEYCLOAK_SSL_REQUIRED)" = "external" ] || fail "auto ssl required"

# secrets are generated once and kept on re-run; new example keys are appended
pw=$(val "$d" POSTGRES_PASSWORD); kid=$(val "$d" S3_ACCESS_KEY_ID); admin=$(val "$d" GOAT_ADMIN_PASSWORD)
akey=$(val "$d" ASSISTANT_SECRETS_KEY || true)
[[ "$akey" =~ ^[A-Za-z0-9_-]{43}=$ ]] || fail "assistant secrets key is not a Fernet key: $akey"
[ ${#pw} -eq 48 ] || fail "postgres password length"
case "$kid" in GK????????????????????????) ;; *) fail "garage key id format: $kid" ;; esac
echo "NEW_TEST_KEY=hello" >> "$d/.env.example"
(cd "$d" && SETUP_SKIP_DOCKER_CHECK=1 ./setup.sh --non-interactive >/dev/null)
[ "$(val "$d" POSTGRES_PASSWORD)" = "$pw" ] || fail "postgres password rotated"
[ "$(val "$d" S3_ACCESS_KEY_ID)" = "$kid" ] || fail "s3 key rotated"
[ "$(val "$d" GOAT_ADMIN_PASSWORD)" = "$admin" ] || fail "admin password rotated"
[ "$(val "$d" ASSISTANT_SECRETS_KEY)" = "$akey" ] || fail "assistant secrets key rotated"
[ "$(val "$d" NEW_TEST_KEY)" = "hello" ] || fail "new key not merged"
# an upgraded bundle moves GOAT_VERSION even though .env already has one
sed -i "s/^GOAT_VERSION=.*/GOAT_VERSION=v9.9.9/" "$d/.env.example"
(cd "$d" && SETUP_SKIP_DOCKER_CHECK=1 ./setup.sh --non-interactive >/dev/null)
[ "$(val "$d" GOAT_VERSION)" = "v9.9.9" ] || fail "GOAT_VERSION did not follow the bundle"
[ "$(val "$d" POSTGRES_PASSWORD)" = "$pw" ] || fail "postgres password rotated on upgrade"
[ "$(val "$d" GOAT_PUBLIC_URL)" = "https://goat.example.org" ] || fail "public url lost on re-run"
# an installation from before the assistant gets its key on the next run,
# and nothing else changes
sed -i '/^ASSISTANT_SECRETS_KEY=/d' "$d/.env"
(cd "$d" && SETUP_SKIP_DOCKER_CHECK=1 ./setup.sh --non-interactive >/dev/null)
upgraded=$(val "$d" ASSISTANT_SECRETS_KEY || true)
[[ "$upgraded" =~ ^[A-Za-z0-9_-]{43}=$ ]] || fail "assistant secrets key not created on upgrade: $upgraded"
[ "$(val "$d" POSTGRES_PASSWORD)" = "$pw" ] || fail "postgres password rotated when adding the assistant key"
[ "$(val "$d" S3_ACCESS_KEY_ID)" = "$kid" ] || fail "s3 key rotated when adding the assistant key"
[ "$(val "$d" GOAT_ADMIN_PASSWORD)" = "$admin" ] || fail "admin password rotated when adding the assistant key"
[ "$(val "$d" GOAT_VERSION)" = "v9.9.9" ] || fail "GOAT_VERSION changed when adding the assistant key"
[ "$(val "$d" GOAT_PUBLIC_URL)" = "https://goat.example.org" ] || fail "public url lost when adding the assistant key"

# plain http on IP with port
d=$(run_case --public-url http://10.0.0.5:8080/ --tls off --admin-email a@example.org)
[ "$(val "$d" GOAT_PUBLIC_URL)" = "http://10.0.0.5:8080" ] || fail "ip url"
[ "$(val "$d" GOAT_SITE_ADDRESS)" = ":8080" ] || fail "off site address"
[ "$(val "$d" GOAT_HTTP_PORT)" = "8080" ] || fail "off http port"
[ "$(val "$d" GOAT_KEYCLOAK_SSL_REQUIRED)" = "none" ] || fail "http ssl required"

# behind a TLS load balancer
d=$(run_case --public-url https://goat.example.org --tls off --http-port 8081 --admin-email a@example.org)
[ "$(val "$d" GOAT_SITE_ADDRESS)" = ":8081" ] || fail "lb site address"
[ "$(val "$d" GOAT_NETWORK_ALIAS)" = "goat-edge.internal" ] || fail "lb must not alias the public host"
[ "$(val "$d" GOAT_KEYCLOAK_SSL_REQUIRED)" = "external" ] || fail "lb ssl required"

# internal CA: https with custom port, CA bundle points at Caddy's root
d=$(run_case --public-url https://10.0.0.5:8443 --tls internal --admin-email a@example.org)
[ "$(val "$d" GOAT_SITE_ADDRESS)" = "https://10.0.0.5:8443" ] || fail "internal site address"
[ "$(val "$d" GOAT_HTTPS_PORT)" = "8443" ] || fail "internal https port"
[ "$(val "$d" GOAT_CA_BUNDLE)" = "/caddy-data/caddy/pki/authorities/local/root.crt" ] || fail "internal ca bundle"

# SMTP security mode -> Keycloak's two TLS flags
for mode in starttls ssl none; do
  d=$(run_case --public-url https://goat.example.org --tls auto --admin-email a@example.org)
  sed -i "s/^SMTP_SECURITY=.*/SMTP_SECURITY=$mode/" "$d/.env"
  (cd "$d" && SETUP_SKIP_DOCKER_CHECK=1 ./setup.sh --non-interactive >/dev/null)
  got="$(val "$d" SMTP_STARTTLS)/$(val "$d" SMTP_SSL)"
  case "$mode" in starttls) want=true/false ;; ssl) want=false/true ;; none) want=false/false ;; esac
  [ "$got" = "$want" ] || fail "SMTP_SECURITY=$mode gave $got"
done

# invalid combinations are rejected
tmp=$(mktemp -d); cp "$here/setup.sh" "$here/.env.example" "$tmp/"
(cd "$tmp" && ! SETUP_SKIP_DOCKER_CHECK=1 ./setup.sh --non-interactive --public-url http://x.org --tls auto 2>/dev/null) || fail "http + auto accepted"
(cd "$tmp" && ! SETUP_SKIP_DOCKER_CHECK=1 ./setup.sh --non-interactive --public-url https://x.org/goat --tls auto 2>/dev/null) || fail "path accepted"

(cd "$tmp" && ! SETUP_SKIP_DOCKER_CHECK=1 ./setup.sh --non-interactive --public-url https://x.org --tls auto --acme-email ops@goat.test 2>/dev/null) || fail "reserved acme email domain accepted"

echo "setup-check: PASS"
