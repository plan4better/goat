# GOAT on a single server

Everything GOAT needs, on one Linux machine, with Docker Compose: the web app and
its APIs, a login server (Keycloak), object storage (Garage), the database
(PostgreSQL with PostGIS), the job engine (Windmill) and a proxy (Caddy) that
handles HTTPS.

This file is the short version. The full guide is in the GOAT documentation:
[Installation](https://goat.plan4better.de/docs/self_hosting/docker_compose/installation) ·
[HTTPS and addresses](https://goat.plan4better.de/docs/self_hosting/docker_compose/https) ·
[External services](https://goat.plan4better.de/docs/self_hosting/docker_compose/external_services) ·
[Operations](https://goat.plan4better.de/docs/self_hosting/docker_compose/operations) ·
[Configuration reference](https://goat.plan4better.de/docs/self_hosting/docker_compose/configuration)

## Requirements

| | Minimum (trial) | Recommended |
|---|---|---|
| CPU / RAM | 4 vCPU / 8 GB | 8 vCPU / 16 GB |
| Disk | 50 GB | 200 GB+ (grows with your data) |
| OS | any Linux with Docker Engine 24+ and Docker Compose 2.23+ | Ubuntu 24.04 LTS |

- Open ports: **443**, plus 80 for the redirect from `http://` (or the one port you
  choose for plain HTTP). Nothing else needs to be reachable.
- For automatic HTTPS: a DNS name pointing at the server.
- Outgoing internet access for the base data download, the basemaps and the
  optional integrations.
- `openssl` for `setup.sh`, `curl` and `jq` for `smoke.sh`.

The bundle does not install or upgrade Docker: install it from
[Docker's own packages](https://docs.docker.com/engine/install/) (the
distribution's `docker.io` package is often too old). `setup.sh` checks the
versions and stops if one is missing or too old.

## Install

```bash
tar xzf goat-compose-<version>.tar.gz && cd goat-compose
./setup.sh             # asks for the address, TLS mode and admin email; writes .env
docker compose up -d   # first start takes a few minutes
./smoke.sh             # checks the whole installation
```

`setup.sh` prints the first administrator's login. Open the public URL and sign in.

## Address and HTTPS

Set with `./setup.sh --public-url <url> --tls <mode>` (or interactively).

| Mode | Use when | What happens |
|---|---|---|
| `auto` | the server has a public DNS name | Caddy gets and renews a Let's Encrypt certificate |
| `custom` | you have your own certificate | put `cert.pem` (full chain) and `key.pem` into `./certs` |
| `internal` | intranet test installs | Caddy issues its own certificate; browsers warn until its root CA is trusted (`docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt .`) |
| `off` | local installs over plain HTTP, e.g. `http://10.0.0.5` | no TLS |
| `off` behind your load balancer | TLS ends at your LB | `./setup.sh --public-url https://goat.example.org --tls off --http-port 8080`; point the LB at port 8080 and list its addresses in `GOAT_TRUSTED_PROXIES` |

The public URL must be a bare origin (no path). All services live under it:
`/` web app, `/api` core, `/geoapi`, `/processes`, `/catalog`, `/keycloak`.

**Company CA.** If your servers use a certificate from a private CA, put the CA
certificate into `./certs` and set `GOAT_CA_BUNDLE=/certs/<file>.pem` in `.env`.
This also covers an SMTP relay whose certificate comes from that CA: GOAT and
Keycloak verify the relay's certificate against the public CAs and this file.

More in the docs: [HTTPS and addresses](https://goat.plan4better.de/docs/self_hosting/docker_compose/https)

## Using your own S3 or Keycloak

- **S3:** remove `garage` from `COMPOSE_PROFILES` and set `S3_*` and `ASSETS_*` in
  `.env` (see the comments there). Your bucket's CORS rules must allow `PUT` with a
  `Content-Type` header from the GOAT URL; the assets bucket must be publicly
  readable at `ASSETS_URL`.
- **Keycloak:** remove `keycloak` from `COMPOSE_PROFILES`, set `KEYCLOAK_PUBLIC_URL`,
  `KEYCLOAK_INTERNAL_URL`, `REALM_NAME`, `KEYCLOAK_CLIENT_ID` and
  `KEYCLOAK_CLIENT_SECRET`. The client must be confidential, with redirect URI
  `<GOAT URL>/*`, and its service account needs the realm-management roles
  `view-users` and `manage-users`.
- **A realm shared with other applications:** every client of the realm can get
  a token that GOAT's APIs would accept. Set `AUTH_ALLOWED_CLIENTS` to the
  clients GOAT should accept tokens from, comma-separated. It must include
  `KEYCLOAK_CLIENT_ID`; core refuses to start otherwise. A token issued to any
  other client then gets a `401`. The list checks the client, not the user: a
  group restriction on GOAT's client must cover every flow the client allows
  (or turn its direct access grants off).
- **No login at all** (local demos only): `AUTH=False`. Everybody acts as one
  built-in administrator.

More in the docs: [External services](https://goat.plan4better.de/docs/self_hosting/docker_compose/external_services)

## Optional integrations

In `.env`: `NEXT_PUBLIC_MAPTILER_KEY` (satellite basemap), `NEXT_PUBLIC_MAPBOX_TOKEN`
(place search), `SMTP_*` (email, below), `CATALOG_S3_*` (GOAT data catalog, and the OpenStreetMap and Overture mirror for Add layer › Connect service),
`GEOCODING_URL` / `GEOCODING_AUTHORIZATION`, `ODOO_*` (Odoo connection and support tickets, below),
`NEXT_PUBLIC_SUPPORT_EMAIL` (address of "Report a problem" without tickets, default `support@plan4better.de`),
`OTEL_*` (telemetry export).
Apply changes with `docker compose up -d`.

**Email.** GOAT sends invitations and Keycloak sends password resets through one
SMTP server. Email is off while `SMTP_HOST` is empty.

| Setting | Meaning |
|---|---|
| `SMTP_HOST`, `SMTP_PORT` | the mail server, e.g. `smtp.example.org` and `587` |
| `SMTP_SECURITY` | `starttls` (usually port 587), `ssl` (usually 465) or `none` (e.g. an internal relay on 25) |
| `SMTP_USER`, `SMTP_PASSWORD` | login; leave both empty for a relay that accepts mail without one |
| `SMTP_FROM` | sender address (defaults to `SMTP_USER`; required for a relay) |
| `EMAILS_FROM_NAME` | sender name, default `GOAT` |

Run `./setup.sh` after changing `SMTP_SECURITY`: it sets `SMTP_STARTTLS` and
`SMTP_SSL`, which Keycloak needs. Keycloak gets the same settings: on every
`docker compose up -d` the `keycloak-sync` step copies them, the public URL and
the client secret from `.env` into the realm. GOAT's emails show the name `GOAT` and no
links by default; `EMAIL_BRAND_NAME`, `EMAIL_LOGO_URL`, `EMAIL_CONTACT_URL` and
`EMAIL_PRIVACY_URL` add your own name, logo and footer links.

**Support tickets.** Optional and off by default. GOAT can hand problem reports to an
Odoo Helpdesk; without it the app shows "Report a problem" as an email address plus the
documentation. Set all four of `ODOO_URL`, `ODOO_DB` (Plan4Better's Odoo, shared by
GOAT's Odoo integrations), `ODOO_SUPPORT_API_KEY` and `ODOO_SUPPORT_TEAM_ID` to turn it on; with any of them
empty the `/api/v2/support` routes answer 404, except `/api/v2/support/summary`, which tells the app that support is off. The API key is a secret that Plan4Better
issues for its own Odoo, so leave all four empty on your own installation unless you have
received one. `ODOO_SUPPORT_POST_ACTION` names the Odoo server action used to post a
message as the ticket participant (default `GOAT: post message as ticket participant`).
Ticket messages can carry up to 55 MiB of attachments in one request: the bundled Caddy
sets no request body limit, so keep it that way for `/api/v2/support` if you put another
proxy in front.

More in the docs: [External services → Optional integrations](https://goat.plan4better.de/docs/self_hosting/docker_compose/external_services#integrations)

## Routing base data

Catchment areas, heatmaps and the public-transport tools need the street
network and public-transport data. They are not downloaded automatically: the
full set is tens of GB, so choose the region you work in.

```bash
./base-data.sh --dry-run --bbox 11.3,48.0,11.8,48.3   # what would be fetched, and how much
./base-data.sh --bbox 11.3,48.0,11.8,48.3             # download (min_lon,min_lat,max_lon,max_lat)
./base-data.sh --bbox 11.3,48.0,11.8,48.3 --weekly on # same, and repeat it every week
```

The data comes from `GOAT_BASE_DATA_URL` (Plan4Better's public base-data
server by default; point it at an internal mirror if needed).

More in the docs: [Operations → Routing base data](https://goat.plan4better.de/docs/self_hosting/docker_compose/operations#base-data)

## Administration

- **Users** are added by inviting them in GOAT. For an email without a login
  account, GOAT creates one and Keycloak emails a link to set the password (with
  SMTP configured; without it, set the password in the admin console). Accounts
  live in Keycloak at
  `<GOAT URL>/keycloak/admin` (user `admin`, password `KEYCLOAK_ADMIN_PASSWORD` in
  `.env`). Restrict that page with `GOAT_ADMIN_ALLOW_CIDRS`.
- **Organizations** are set up by whoever signs in without one. With
  `ALLOW_ORGANIZATION_CREATION=false` only accounts with the Keycloak realm role
  `superuser` may, and everyone else waits for an invitation.
- **Job engine (Windmill)** is reachable only from the server itself:
  `ssh -L 8110:127.0.0.1:8110 <server>` and open http://localhost:8110
  (user `admin@windmill.dev`, password `WINDMILL_ADMIN_PASSWORD`).
- **Parallel analyses:** `GOAT_TOOLS_WORKERS` (each worker may use up to 4 GB).
- **Memory per service:** each service's limit is in `compose.yaml`; geoapi's and
  processes' DuckDB budgets are set next to it to fit under it. Raise a limit and
  its budgets together, in a `compose.override.yaml`.
- **Logs:** `docker compose logs -f <service>`; they rotate automatically.

More in the docs: [Operations](https://goat.plan4better.de/docs/self_hosting/docker_compose/operations)

## Backups

Add `backup` to `COMPOSE_PROFILES` and run `docker compose up -d`. Every night at
`BACKUP_TIME` (UTC) the databases and data volumes are written to
`./backups/<timestamp>`; backups older than `BACKUP_RETENTION_DAYS` are removed.
Copy `./backups` off the server with your usual tooling (e.g. `rclone`, `restic`).

- Backup now: `docker compose run --rm backup --now`
- Restore: `./restore.sh backups/<timestamp>` (replaces all current data)

Keep a copy of `.env` with your backups: the restored databases and storage
expect the passwords and keys it holds.

More in the docs: [Operations → Backups](https://goat.plan4better.de/docs/self_hosting/docker_compose/operations#backups)

## Upgrade

```bash
# in the directory of your installation: unpack the new release over it.
# .env, certs/ and backups/ are not part of the archive and stay as they are.
tar xzf goat-compose-<new-version>.tar.gz --strip-components=1
./setup.sh             # switches GOAT_VERSION to the new release, adds new settings, keeps the rest
docker compose pull
docker compose up -d   # database migrations run automatically
./smoke.sh --quick
```

More in the docs: [Operations → Upgrades](https://goat.plan4better.de/docs/self_hosting/docker_compose/operations#upgrade)

## Troubleshooting

- `./smoke.sh` names the failing step and prints the logs of the service involved.
- `docker compose ps -a`: every `*-init`, `*-migrate`, `*-bootstrap` and `*-sync`
  service should show `Exited (0)`; everything else `healthy` or `running`.
- Let's Encrypt fails: check that port 443 reaches the server and the DNS name
  resolves to it; `docker compose logs caddy`.

More in the docs: [Operations → Troubleshooting](https://goat.plan4better.de/docs/self_hosting/docker_compose/operations#troubleshooting)
