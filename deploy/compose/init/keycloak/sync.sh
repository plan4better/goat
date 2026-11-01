#!/bin/sh
# Brings the settings of the GOAT realm that come from .env up to date on every
# start: the client's addresses and secret, the HTTPS requirement, outgoing
# email, and that refresh tokens are not revoked on use (the AI assistant
# refreshes a user's login for long answers with the same client as the
# browser). The realm file is imported only once, when the realm does not exist
# yet; without this step a changed public URL or SMTP server would have to be
# edited by hand in the admin console.
set -eu

KCADM=/opt/bitnami/keycloak/bin/kcadm.sh
CONFIG=/tmp/kcadm.config
REALM=${GOAT_REALM:-goat}
URL=${GOAT_PUBLIC_URL%/}

"$KCADM" config credentials --config "$CONFIG" \
  --server http://keycloak:8080/keycloak --realm master \
  --user admin --password "$KEYCLOAK_ADMIN_PASSWORD" >/dev/null

client=$("$KCADM" get clients --config "$CONFIG" -r "$REALM" \
  -q "clientId=$GOAT_CLIENT_ID" --fields id --format csv --noquotes | head -n 1)
if [ -z "$client" ]; then
  echo "keycloak-sync: client $GOAT_CLIENT_ID not found in realm $REALM" >&2
  exit 1
fi

"$KCADM" update "clients/$client" --config "$CONFIG" -r "$REALM" \
  -s "rootUrl=$URL" \
  -s "redirectUris=[\"$URL/*\"]" \
  -s "webOrigins=[\"$URL\"]" \
  -s "attributes.\"post.logout.redirect.uris\"=$URL/*" \
  -s "secret=$GOAT_CLIENT_SECRET"

"$KCADM" update "realms/$REALM" --config "$CONFIG" \
  -s "sslRequired=$GOAT_SSL_REQUIRED" \
  -s "revokeRefreshToken=false" \
  -s "smtpServer.host=$GOAT_SMTP_HOST" \
  -s "smtpServer.port=$GOAT_SMTP_PORT" \
  -s "smtpServer.from=$GOAT_SMTP_FROM" \
  -s "smtpServer.fromDisplayName=$GOAT_SMTP_FROM_NAME" \
  -s "smtpServer.auth=${GOAT_SMTP_AUTH:-false}" \
  -s "smtpServer.user=$GOAT_SMTP_USER" \
  -s "smtpServer.password=$GOAT_SMTP_PASSWORD" \
  -s "smtpServer.starttls=$GOAT_SMTP_STARTTLS" \
  -s "smtpServer.ssl=$GOAT_SMTP_SSL"

rm -f "$CONFIG"
echo "keycloak-sync: realm $REALM follows $URL"
