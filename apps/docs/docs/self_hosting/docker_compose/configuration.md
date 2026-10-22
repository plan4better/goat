---
sidebar_position: 4
sidebar_label: Configuration reference
description: "Every setting in the bundle's .env file, grouped by release, address and TLS, authentication, storage, database, jobs, integrations, email and backups."
---

# Configuration reference

The whole configuration lives in the file `.env` in the bundle folder. `setup.sh` creates it from `.env.example`, which documents every setting with comments. This page lists the settings in the same groups.

- **Set by setup.sh** means that `setup.sh` fills the value: secrets are generated once when empty, and derived values are rewritten from the public URL and the TLS mode on every run. Do not edit derived values by hand; run `setup.sh` instead.
- A setting shown as *(commented out)* is present in `.env.example` but inactive until you remove the `#`.

Apply changes with `docker compose up -d`.

## Release {#release}

| Setting | Default | Meaning |
|---|---|---|
| `GOAT_VERSION` | the bundle's release | The GOAT version all images use. See [Upgrades](./operations.md#upgrade). |
| `GOAT_REGISTRY` | `ghcr.io/plan4better/goat` | Where the GOAT images are pulled from, e.g. an internal mirror |

## Public address and TLS {#address}

| Setting | Default | Meaning |
|---|---|---|
| `GOAT_PUBLIC_URL` | asked by setup.sh | The URL users type into the browser, without a trailing slash |
| `GOAT_TLS` | `auto` | `auto`, `custom`, `internal` or `off`; see [HTTPS and addresses](./https.md) |
| `GOAT_ACME_EMAIL` | empty | Optional contact for Let's Encrypt expiry notices (`auto` only) |
| `GOAT_TRUSTED_PROXIES` | `private_ranges` | Addresses allowed to set `X-Forwarded-*` headers (your load balancer), as CIDRs separated by spaces |
| `GOAT_ADMIN_ALLOW_CIDRS` | `0.0.0.0/0 ::/0` | Networks allowed to open the Keycloak admin console under `/keycloak/admin` |
| `GOAT_CA_BUNDLE` | empty | Path inside the containers of extra CA certificates (PEM) in `./certs`, e.g. your company CA for your load balancer, Keycloak or SMTP relay; set by setup.sh in `internal` mode. See [Company CA](./https.md#company-ca). |
| `GOAT_HTTP_PORT` | `80` | Port for HTTP; set by setup.sh from the URL or `--http-port` |
| `GOAT_HTTPS_PORT` | `443` | Port for HTTPS; set by setup.sh from the URL |
| `GOAT_HOSTNAME`, `GOAT_NETWORK_ALIAS`, `GOAT_SITE_ADDRESS`, `GOAT_HTTPS_PUBLISH`, `GOAT_KEYCLOAK_SSL_REQUIRED` | | Derived; set by setup.sh |

## Profiles {#profiles}

| Setting | Default | Meaning |
|---|---|---|
| `COMPOSE_PROFILES` | `garage,keycloak` | The bundled components to run: `garage` (object storage), `keycloak` (login server), `backup` (nightly backups) |

## Authentication {#authentication}

| Setting | Default | Meaning |
|---|---|---|
| `AUTH` | `True` | `True`: users log in through Keycloak. `False`: no login, everybody acts as one built-in administrator (local and demo installs only). |
| `GOAT_ADMIN_EMAIL` | asked by setup.sh | The first GOAT user, created in the bundled Keycloak on the first start |
| `GOAT_ADMIN_PASSWORD` | set by setup.sh | Password of the first user |
| `REALM_NAME` | `goat` | Keycloak realm GOAT uses |
| `KEYCLOAK_CLIENT_ID` | `goat` | Keycloak client GOAT uses |
| `KEYCLOAK_CLIENT_SECRET` | set by setup.sh | Secret of that client |
| `KEYCLOAK_ADMIN_PASSWORD` | set by setup.sh | Password of the user `admin` in the Keycloak admin console |
| `KEYCLOAK_PROVISION_INVITED_USERS` | `true` | Create the login account in Keycloak when someone is invited whose email has none yet |
| `ALLOW_ORGANIZATION_CREATION` | `true` | `true`: anyone who signs in without an organization can set one up. `false`: only accounts with the Keycloak realm role `superuser` can; everyone else waits for an invitation. See [Who sets up organizations](./operations.md#organizations). |
| `KEYCLOAK_DB_PASSWORD` | set by setup.sh | Database password of the bundled Keycloak |
| `KEYCLOAK_PUBLIC_URL`, `KEYCLOAK_INTERNAL_URL` | *(commented out)* | Your own Keycloak; see [Your own Keycloak](./external_services.md#keycloak) |
| `AUTH_ALLOWED_CLIENTS` | *(commented out)* | Keycloak clients whose tokens GOAT's APIs accept, comma-separated; empty accepts every client of the realm. A list must include `KEYCLOAK_CLIENT_ID`. See [A realm shared with other applications](./external_services.md#keycloak-shared-realm) |

## Object storage (S3) {#storage}

| Setting | Default | Meaning |
|---|---|---|
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | set by setup.sh | Access key for the bundled Garage, or your own S3 key |
| `GARAGE_RPC_SECRET`, `GARAGE_ADMIN_TOKEN` | set by setup.sh | Internal secrets of the bundled Garage |
| `S3_ENDPOINT_URL`, `S3_PUBLIC_ENDPOINT_URL`, `S3_REGION`, `S3_BUCKET_NAME`, `S3_FORCE_PATH_STYLE` | *(commented out)* | Your own S3; see [Your own S3 storage](./external_services.md#s3) |
| `ASSETS_S3_ENDPOINT_URL`, `ASSETS_BUCKET_NAME`, `ASSETS_URL` | *(commented out)* | The publicly readable bucket for avatars and images on your own S3 |
| `ASSETS_SERVED_BY_CORE` | `false` | `true`: images in the uploads bucket, served by GOAT, for S3 without a public bucket |

## Database {#database}

The memory defaults suit a 16 GB machine. As a rule of thumb, set `POSTGRES_SHARED_BUFFERS` to about 1/4 and `POSTGRES_EFFECTIVE_CACHE_SIZE` to about 3/4 of the RAM you give PostgreSQL.

| Setting | Default | Meaning |
|---|---|---|
| `POSTGRES_PASSWORD` | set by setup.sh | Password of the GOAT database |
| `WINDMILL_DB_PASSWORD` | set by setup.sh | Password of the Windmill database |
| `POSTGRES_SHARED_BUFFERS` | `1GB` | PostgreSQL `shared_buffers` |
| `POSTGRES_EFFECTIVE_CACHE_SIZE` | `3GB` | PostgreSQL `effective_cache_size` |
| `POSTGRES_MAX_CONNECTIONS` | `200` | PostgreSQL `max_connections` |
| `POSTGRES_POOL_SIZE` | `5` | Connection pool size of the Core API |
| `POSTGRES_MAX_OVERFLOW` | `10` | Extra connections the Core API may open beyond the pool |

GOAT's services name their database sessions after themselves (`goat-core`, `goat-geoapi`, `goat-processes`, `goat-tools`, …), so `pg_stat_activity` shows which one holds a connection. On the Windmill database, sessions without a `goat-` name are Windmill's own. Windmill holds at most 10 connections to its database for the server and 3 for every worker (`DATABASE_CONNECTIONS` in `compose.yaml`).

## Jobs (Windmill) {#jobs}

| Setting | Default | Meaning |
|---|---|---|
| `WINDMILL_ADMIN_PASSWORD` | set by setup.sh | Password of `admin@windmill.dev` in the Windmill interface |
| `GOAT_TOOLS_WORKERS` | `2` | Number of analysis jobs that run in parallel; each tools worker may use up to 4 GB of RAM |
| `WINDMILL_LOCAL_PORT` | `8110` | Port of the Windmill interface, bound to `127.0.0.1` only; see [Windmill](./operations.md#windmill) |
| `GOAT_BASE_DATA_URL` | `https://goat-base-data.plan4better.de/` | Source of the routing and public transport base data; see [Routing base data](./operations.md#base-data) |

## Web app secrets {#web}

| Setting | Default | Meaning |
|---|---|---|
| `NEXTAUTH_SECRET` | set by setup.sh | Signing key for the web app's login sessions |

## Optional integrations {#integrations}

| Setting | Default | Meaning |
|---|---|---|
| `NEXT_PUBLIC_MAPTILER_KEY` | empty | MapTiler key for the satellite/hybrid basemap (hidden when empty) |
| `NEXT_PUBLIC_MAPBOX_TOKEN` | empty | Mapbox token for the place search |
| `CATALOG_S3_BUCKET`, `CATALOG_S3_ENDPOINT_URL`, `CATALOG_S3_ACCESS_KEY_ID`, `CATALOG_S3_SECRET_ACCESS_KEY`, `CATALOG_S3_REGION` | empty | The GOAT data catalog (read-only bucket with the harmonised datasets). The OpenStreetMap and Overture Maps panes under *Add layer › Connect service* read their mirror from the same bucket; see [OpenStreetMap and Overture Maps](./external_services.md#open-data-mirror). |
| `GEOCODING_URL`, `GEOCODING_AUTHORIZATION` | empty | Geocoding service used by analysis tools |
| `NEXT_PUBLIC_WEBSITE_URL` | empty | A website that publishes GOAT's blog and changelog feeds. It fills the news on the Home page and provides the welcome video and the privacy link in the menu; while empty, none of these are shown. |
| `NEXT_PUBLIC_STATUS_FEED_URL` | empty | Status feed shown in the app |
| `NEXT_PUBLIC_SUPPORT_EMAIL` | empty | Email address behind *Report a problem* while [support tickets](./external_services.md#support) are off, and in the message shown when support is temporarily unavailable. Defaults to `support@plan4better.de`; set your own address for a white-label installation. An invalid address is ignored and the default is used. |
| `NEXT_PUBLIC_DOCS_URL` | `https://goat.plan4better.de/docs` | Documentation link in the app |
| `STATIC_ASSETS_URL` | *(commented out)* | A mirror or CDN for the product artwork (icons, default thumbnails, email images). While unset, GOAT serves the artwork itself under `/assets`. |
| `ODOO_URL`, `ODOO_DB` | *(commented out)* | Plan4Better's Odoo, shared by GOAT's Odoo integrations. Only with access issued by Plan4Better. |
| `ODOO_SUPPORT_API_KEY`, `ODOO_SUPPORT_TEAM_ID` | *(commented out)* | Optional support tickets in an Odoo Helpdesk; on only when these and `ODOO_URL`, `ODOO_DB` are set. The key is a secret issued by Plan4Better. See [Support tickets](./external_services.md#support). |
| `ODOO_SUPPORT_POST_ACTION` | `GOAT: post message as ticket participant` | Odoo server action that posts a message as the ticket participant |
| `OTEL_ENABLED` | `false` | Export traces, metrics and logs through OpenTelemetry |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | empty | Your OpenTelemetry (OTLP) endpoint |

## Email {#email}

See [Email](./external_services.md#email) for how these work together.

| Setting | Default | Meaning |
|---|---|---|
| `SMTP_HOST` | empty | Mail server; email is off while empty |
| `SMTP_PORT` | `587` | Port of the mail server |
| `SMTP_SECURITY` | `starttls` | `starttls`, `ssl` or `none` |
| `SMTP_USER`, `SMTP_PASSWORD` | empty | Login; leave both empty for a relay without login |
| `SMTP_FROM` | empty | Sender address; `SMTP_USER` when empty |
| `EMAILS_FROM_NAME` | `GOAT` | Sender name |
| `SMTP_STARTTLS`, `SMTP_SSL` | `true`, `false` | Derived from `SMTP_SECURITY`; set by setup.sh |
| `EMAIL_BRAND_NAME`, `EMAIL_LOGO_URL`, `EMAIL_CONTACT_URL`, `EMAIL_PRIVACY_URL` | *(commented out)* | Optional branding of GOAT's and Keycloak's emails: name, logo instead of the name, footer links. See [Email branding](./external_services.md#email-branding). |

## Backups {#backups}

These apply when the `backup` profile is on; see [Backups](./operations.md#backups).

| Setting | Default | Meaning |
|---|---|---|
| `BACKUP_TIME` | `02:30` | Time of the nightly backup (UTC) |
| `BACKUP_RETENTION_DAYS` | `7` | Backups older than this many days are removed |
