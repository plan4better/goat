#!/usr/bin/env bash
# Creates or updates .env for the GOAT single-node deployment.
#
#   ./setup.sh                                   interactive
#   ./setup.sh --public-url https://goat.example.org --tls auto \
#              --acme-email ops@example.org --admin-email admin@example.org \
#              --non-interactive
#
# Existing values in .env are never changed, except the ones derived from the
# public URL and TLS mode. Secrets are generated only when empty.
set -euo pipefail

cd "$(dirname "$0")"
ENV_FILE=.env
EXAMPLE=.env.example

PUBLIC_URL=""
TLS=""
ACME_EMAIL=""
ADMIN_EMAIL=""
HTTP_PORT=""
INTERACTIVE=1

usage() {
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
  echo "Options: --public-url URL --tls auto|custom|internal|off --acme-email EMAIL"
  echo "         --admin-email EMAIL --http-port PORT (TLS off behind a load balancer)"
  echo "         --non-interactive"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --public-url) PUBLIC_URL="$2"; shift 2 ;;
    --tls) TLS="$2"; shift 2 ;;
    --acme-email) ACME_EMAIL="$2"; shift 2 ;;
    --admin-email) ADMIN_EMAIL="$2"; shift 2 ;;
    --http-port) HTTP_PORT="$2"; shift 2 ;;
    --non-interactive) INTERACTIVE=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

die() { echo "setup.sh: $*" >&2; exit 1; }

# --- Requirements -------------------------------------------------------------
# Checks only; installing or upgrading Docker is up to the server's operator.
install_hint="see https://docs.docker.com/engine/install/"
command -v docker >/dev/null || die "docker is not installed; $install_hint"
command -v openssl >/dev/null || die "openssl is not installed"
at_least() {
  # at_least VERSION MAJOR MINOR: VERSION (x.y[.z]) is MAJOR.MINOR or newer.
  local major=${1%%.*} rest=${1#*.}
  local minor=${rest%%.*}
  [ "$major" -gt "$2" ] || { [ "$major" -eq "$2" ] && [ "$minor" -ge "$3" ]; }
}
if [ -z "${SETUP_SKIP_DOCKER_CHECK:-}" ]; then
  engine_version=$(docker version --format '{{.Server.Version}}' 2>/dev/null) \
    || die "cannot reach the Docker daemon; is it running, and may this user use it (root or the docker group)?"
  at_least "$engine_version" 24 0 || die "Docker Engine >= 24 required (found $engine_version); $install_hint"
  compose_version=$(docker compose version --short 2>/dev/null | sed 's/^v//') \
    || die "the Docker Compose plugin is missing; $install_hint"
  # 2.24: optional env_file entries (required: false), used by the assistant.
  at_least "$compose_version" 2 24 || die "Docker Compose >= 2.24 required (found $compose_version); $install_hint"
fi

# --- .env helpers -------------------------------------------------------------
get() {
  # Value of KEY in .env (empty if unset). Last assignment wins, like docker compose.
  grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -n 1 | cut -d= -f2- || true
}

set_value() {
  # Replace KEY's line in .env, or append it.
  local key="$1" value="$2" tmp
  tmp=$(mktemp)
  if grep -qE "^$key=" "$ENV_FILE"; then
    awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $1==k {print k "=" v; next} {print}' "$ENV_FILE" > "$tmp"
  else
    cp "$ENV_FILE" "$tmp"
    printf '%s=%s\n' "$key" "$value" >> "$tmp"
  fi
  cat "$tmp" > "$ENV_FILE"
  rm -f "$tmp"
}

set_if_empty() {
  [ -n "$(get "$1")" ] || set_value "$1" "$2"
}

hex() { openssl rand -hex "$1"; }
password() { openssl rand -base64 30 | tr -dc 'A-Za-z0-9' | head -c "$1"; }
# A Fernet key: 32 random bytes, URL-safe base64 (what the assistant expects).
fernet_key() { openssl rand -base64 32 | tr '+/' '-_'; }

ask() {
  # ask VAR "Question" default
  local __var="$1" question="$2" default="$3" answer
  if [ "$INTERACTIVE" -eq 1 ]; then
    read -r -p "$question [${default}]: " answer
    printf -v "$__var" '%s' "${answer:-$default}"
  else
    printf -v "$__var" '%s' "$default"
  fi
}

# --- Create or merge .env -----------------------------------------------------
if [ -f "$ENV_FILE" ]; then
  cp "$ENV_FILE" "$ENV_FILE.bak.$(date +%Y%m%d%H%M%S)"
  # Append keys that are new in .env.example, with their example values.
  while IFS= read -r line; do
    case "$line" in
      ''|'#'*) continue ;;
    esac
    key=${line%%=*}
    grep -qE "^$key=" "$ENV_FILE" || printf '%s\n' "$line" >> "$ENV_FILE"
  done < "$EXAMPLE"
else
  cp "$EXAMPLE" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi

# The images must match this bundle's compose.yaml and scripts, so the version
# always comes from the bundle, also when upgrading an existing .env.
bundle_version=$(grep -E '^GOAT_VERSION=' "$EXAMPLE" | tail -n 1 | cut -d= -f2-)
[ -n "$bundle_version" ] && set_value GOAT_VERSION "$bundle_version"

# --- Public URL and TLS -------------------------------------------------------
[ -n "$PUBLIC_URL" ] || PUBLIC_URL=$(get GOAT_PUBLIC_URL)
[ -n "$TLS" ] || TLS=$(get GOAT_TLS)
[ -n "$ACME_EMAIL" ] || ACME_EMAIL=$(get GOAT_ACME_EMAIL)
[ -n "$ADMIN_EMAIL" ] || ADMIN_EMAIL=$(get GOAT_ADMIN_EMAIL)

if [ -z "$PUBLIC_URL" ] || [ "$INTERACTIVE" -eq 1 ]; then
  ask PUBLIC_URL "Public URL (e.g. https://goat.example.org or http://10.0.0.5)" "${PUBLIC_URL:-http://localhost}"
fi
PUBLIC_URL=${PUBLIC_URL%/}
case "$PUBLIC_URL" in
  http://*|https://*) ;;
  *) die "public URL must start with http:// or https:// (got '$PUBLIC_URL')" ;;
esac
scheme=${PUBLIC_URL%%://*}
rest=${PUBLIC_URL#*://}
case "$rest" in */*) die "public URL must not contain a path (got '$PUBLIC_URL')" ;; esac
host=${rest%%:*}
if [ "$rest" != "$host" ]; then url_port=${rest#*:}; else url_port=""; fi

if [ -z "$TLS" ] || [ "$INTERACTIVE" -eq 1 ]; then
  if [ "$scheme" = "http" ]; then default_tls=off; else default_tls=${TLS:-auto}; fi
  ask TLS "TLS mode: auto (Let's Encrypt), custom (own certificate), internal, off" "$default_tls"
fi
case "$TLS" in auto|custom|internal|off) ;; *) die "unknown TLS mode '$TLS'" ;; esac

if [ "$scheme" = "http" ] && [ "$TLS" != "off" ]; then
  die "an http:// URL needs --tls off"
fi

if [ "$TLS" = "auto" ] && [ "$INTERACTIVE" -eq 1 ]; then
  ask ACME_EMAIL "Email for Let's Encrypt notices (optional)" "$ACME_EMAIL"
fi
if [ -z "$ADMIN_EMAIL" ] || [ "$INTERACTIVE" -eq 1 ]; then
  ask ADMIN_EMAIL "Email of the first GOAT administrator" "${ADMIN_EMAIL:-admin@${host}}"
fi

if [ -n "$ACME_EMAIL" ]; then
  # Let's Encrypt refuses contacts outside the public DNS, which would leave
  # the site without a certificate.
  email_domain=${ACME_EMAIL##*@}
  case "$ACME_EMAIL" in
    *@*.*) ;;
    *) die "'$ACME_EMAIL' is not a valid email address" ;;
  esac
  case "$email_domain" in
    *.test|*.local|*.localhost|*.invalid|*.example|example.com|example.org|example.net|localhost)
      die "Let's Encrypt rejects the email domain '$email_domain'; use a real address or leave it empty" ;;
  esac
fi

http_port=80
https_port=443
network_alias=$host
ca_bundle=$(get GOAT_CA_BUNDLE)
case "$TLS" in
  auto)
    [ -z "$url_port" ] || [ "$url_port" = "443" ] || die "TLS auto needs the standard ports; drop :$url_port from the URL"
    site=$host
    ;;
  custom|internal)
    https_port=${url_port:-443}
    site="https://$host:$https_port"
    if [ "$TLS" = "internal" ]; then
      ca_bundle=/caddy-data/caddy/pki/authorities/local/root.crt
    fi
    ;;
  off)
    if [ "$scheme" = "http" ]; then
      http_port=${url_port:-80}
    else
      # TLS ends at the operator's load balancer, which forwards plain HTTP
      # to this port. Containers must reach the public URL through it.
      http_port=${HTTP_PORT:-$(get GOAT_HTTP_PORT)}
      http_port=${http_port:-80}
      network_alias=goat-edge.internal
    fi
    site=":$http_port"
    ;;
esac
[ "$TLS" = "custom" ] && { [ -s certs/cert.pem ] && [ -s certs/key.pem ] || echo "setup.sh: remember to put cert.pem and key.pem into ./certs"; }

if [ "$scheme" = "http" ]; then ssl_required=none; else ssl_required=external; fi

set_value GOAT_PUBLIC_URL "$PUBLIC_URL"
set_value GOAT_TLS "$TLS"
set_value GOAT_ACME_EMAIL "$ACME_EMAIL"
set_value GOAT_HOSTNAME "$host"
set_value GOAT_NETWORK_ALIAS "$network_alias"
set_value GOAT_SITE_ADDRESS "$site"
set_value GOAT_HTTP_PORT "$http_port"
set_value GOAT_HTTPS_PORT "$https_port"
if [ "$TLS" = "off" ]; then
  set_value GOAT_HTTPS_PUBLISH "127.0.0.1::$https_port"
else
  set_value GOAT_HTTPS_PUBLISH "$https_port:$https_port"
fi
set_value GOAT_KEYCLOAK_SSL_REQUIRED "$ssl_required"
set_value GOAT_CA_BUNDLE "$ca_bundle"
set_value GOAT_ADMIN_EMAIL "$ADMIN_EMAIL"

# Keycloak takes TLS for SMTP as two separate flags.
smtp_security=$(get SMTP_SECURITY)
case "${smtp_security:-starttls}" in
  starttls) set_value SMTP_STARTTLS true; set_value SMTP_SSL false ;;
  ssl) set_value SMTP_STARTTLS false; set_value SMTP_SSL true ;;
  none) set_value SMTP_STARTTLS false; set_value SMTP_SSL false ;;
  *) die "SMTP_SECURITY must be starttls, ssl or none (got '$smtp_security')" ;;
esac

# --- Secrets (only when empty) -------------------------------------------------
new_admin_password=""
if [ -z "$(get GOAT_ADMIN_PASSWORD)" ]; then
  new_admin_password=$(password 20)
  set_value GOAT_ADMIN_PASSWORD "$new_admin_password"
fi
set_if_empty POSTGRES_PASSWORD "$(hex 24)"
set_if_empty WINDMILL_DB_PASSWORD "$(hex 24)"
set_if_empty KEYCLOAK_DB_PASSWORD "$(hex 24)"
set_if_empty KEYCLOAK_ADMIN_PASSWORD "$(password 24)"
set_if_empty KEYCLOAK_CLIENT_SECRET "$(hex 24)"
set_if_empty NEXTAUTH_SECRET "$(hex 32)"
set_if_empty WINDMILL_ADMIN_PASSWORD "$(password 24)"
set_if_empty GARAGE_RPC_SECRET "$(hex 32)"
set_if_empty GARAGE_ADMIN_TOKEN "$(hex 32)"
set_if_empty S3_ACCESS_KEY_ID "GK$(hex 12)"
set_if_empty S3_SECRET_ACCESS_KEY "$(hex 32)"
set_if_empty ASSISTANT_SECRETS_KEY "$(fernet_key)"

chmod 600 "$ENV_FILE"

echo
echo "Wrote $ENV_FILE for $PUBLIC_URL (TLS: $TLS)."
if [ -n "$new_admin_password" ]; then
  echo "First login: $ADMIN_EMAIL / $new_admin_password  (also stored in .env as GOAT_ADMIN_PASSWORD)"
fi
echo "Next: docker compose up -d && ./smoke.sh"
