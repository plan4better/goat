# GOAT Helm Chart

Helm chart for deploying GOAT (Geo Open Accessibility Tool) on Kubernetes.

## Scope (v0.8.0)

| Service | Default | Notes |
|---|---|---|
| **core** | ✅ enabled | Main API server |
| **web** | ✅ enabled | Next.js frontend |
| **catalog** | ✅ enabled | STAC API + MCP server; serves the catalog mirror |
| **geoapi** | ✅ enabled | Tiles + features (default changed in 0.5.0) |
| **processes** | ✅ enabled | OGC API Processes (default changed in 0.5.0) |
| **windmill** server + default worker | ✅ enabled | Workflow engine |
| **windmill** print/tools/workflows workers | ❌ opt-in | Heavier requirements (chromium / tainted nodes) |
| **caddy** custom-domains | ❌ opt-in | LoadBalancer Service + public DNS + ACME |

## Installing

```sh
helm install goat oci://ghcr.io/plan4better/charts/goat \
  --version 0.8.0 \
  --namespace goat --create-namespace \
  --values your-values.yaml
```

## Quick start — bundled deps (development)

The chart ships with sensible defaults: a CloudNativePG-managed Postgres
cluster, a bundled Redis, and the 7 GOAT service Deployments (`core`, `web`,
`catalog`, `geoapi`, `processes`, `windmill` server + one default worker). To
install with everything bundled (good for local k3d/kind testing):

```sh
helm install goat oci://ghcr.io/plan4better/charts/goat \
  --namespace goat --create-namespace \
  --set web.publicUrls.api=http://127.0.0.1:8000 \
  --set web.publicUrls.geoapi=http://127.0.0.1:8100 \
  --set web.publicUrls.processes=http://127.0.0.1:8300 \
  --set web.publicUrls.catalog=http://127.0.0.1:8400/stac \
  --wait --timeout 25m

# then, to open it locally (one terminal each, or background them):
kubectl -n goat port-forward svc/goat-web       3000:80
kubectl -n goat port-forward svc/goat-core      8000:80
kubectl -n goat port-forward svc/goat-geoapi    8100:80
kubectl -n goat port-forward svc/goat-processes 8300:80
kubectl -n goat port-forward svc/goat-catalog   8400:80
# -> http://127.0.0.1:3000
```

> ⚠️ **A bare `helm install` with no URLs white-screens the web UI.** The
> browser calls core, geoapi, processes and catalog directly, so it needs
> their *public* (browser-reachable) URLs; the web image ships literal
> `APP_NEXT_PUBLIC_*_URL` placeholders that its entrypoint replaces with
> the values it is given (and blanks otherwise), and a missing
> `NEXT_PUBLIC_API_URL` makes `new URL(...)` throw on first load. Set the four `web.publicUrls.*` as above
> (the port-forward addresses), or give `core`/`geoapi`/`processes`/`catalog`
> an ingress with a host — each URL is then derived from it (see "Key
> values"). The install NOTES print a WARNING when `api` cannot be resolved.

This deploys 7 Deployments: `goat-core`, `goat-web`, `goat-catalog`,
`goat-geoapi`, `goat-processes`, `goat-windmill-server`,
`goat-windmill-worker-default` (plus the CNPG operator's own Deployment, a
`goat-data` PersistentVolumeClaim (200Gi by default — see "The shared data
volume" below), and the bundled Redis Deployment `goat-redis`). It requires the CloudNativePG
operator's CRDs to be installable in your cluster.

A cluster that has never seen this chart before installs with that one
command too — see "Bootstrapping onto a fresh cluster" below for why no
sequencing is needed. `--wait` blocks until every pod is Ready; a first
install pulls several large images, hence the 25-minute timeout.

### Bootstrapping onto a fresh cluster

A fresh cluster needs **one** `helm install`, `--wait` included:

```sh
helm install goat oci://ghcr.io/plan4better/charts/goat \
  --namespace goat --create-namespace \
  --values your-values.yaml --wait --timeout 25m
```

`deploy/helm/smoke-k3d.sh` in the GOAT repository runs exactly that against a throwaway
k3d cluster with the full bundled profile (`ci/values-smoke.yaml`) and then
checks every service. (Before chart 0.5.0 this took three sequenced
`helm install`/`helm upgrade` calls; no phases remain.) Three things make it
work:

- **The CNPG operator's CRDs are vendored under `crds/`** (see the comment
  above `dependencies:` in `Chart.yaml`). Helm applies a chart's `crds/`
  directory BEFORE rendering or installing any templates, so the operator,
  its CRDs and this chart's Postgres `Cluster` CR are created in the same
  call. Without that, Helm resolves every resource's kind against the
  cluster's API discovery before creating anything and fails with `no
  matches for kind "Cluster" in version "postgresql.cnpg.io/v1"`.
- **The one-time bootstrap is done by init containers, not hooks.**
  geoapi and processes attach the DuckLake catalog read-only and cannot
  start until it exists; the windmill server and workers cannot start until
  their `windmill` database exists. Each of those Deployments carries an
  init container that creates (or finds) its dependency before the main
  container starts — `ducklake-init` on geoapi/processes (see "DuckLake
  catalog bootstrap" below) and `windmill-db-init` on the windmill server
  and every worker (see the windmill database notes below). Until 0.5.0
  both were post-install hooks, and with `--wait` Helm holds post-install
  hooks until every resource is Ready — while the pods that needed those
  hooks could not go Ready until they had run. That deadlock is what the
  old phases worked around. The init containers are idempotent: on an
  existing cluster they find everything in place and exit, and several
  pods racing on first start are safe (the loser retries and finds the
  work done).
- **`core.migrate` stays a hook** (post-install / pre-upgrade), which is
  fine: nothing needs the alembic schema to become Ready (core's
  `/api/healthz` is a static ping), so the migration runs once the
  release's pods are up.

On a fresh install, expect geoapi, processes and the windmill pods to sit in
`Init:0/1` for a minute or two while Postgres initialises — their init
containers are waiting for it. If one stays there, its logs say why:
`kubectl -n goat logs deploy/goat-geoapi -c ducklake-init` or
`kubectl -n goat logs deploy/goat-windmill-server -c windmill-db-init`.

If the CNPG operator/CRDs already exist in the cluster (a shared cluster
where another release owns them, or `postgresql.operator.enabled: false`
to use a pre-existing operator), nothing changes — vendored CRDs are a
no-op if the CRD already exists; Helm's `crds/` mechanism does not fail or
overwrite in that case.

**Caveat inherent to Helm's `crds/` mechanism, not this chart:** `crds/`
is install-only. Helm **never** upgrades or deletes CRDs from it on `helm
upgrade` — this is intentional, documented Helm behavior, to avoid an
upgrade silently deleting a CRD (and the custom resources depending on it)
out from under a running cluster. That means:
- Bumping the `cloudnative-pg` dependency version in `Chart.yaml` does
  **not** update an already-installed cluster's CRDs as part of `helm
  upgrade`. If a new chart version bumps that dependency, apply the new
  vendored CRDs yourself first: `kubectl apply -f
  deploy/helm/goat/crds/cloudnative-pg-crds.yaml` (or your own copy from the
  new `cloudnative-pg` subchart version), then run the upgrade.
- The vendored copy has to be kept in sync with the pinned
  `cloudnative-pg` version by hand — there is no automation for this. See
  the comment above `dependencies:` in `Chart.yaml` for the exact
  re-extraction steps.

When `postgresql.cluster.enabled: true` (the CNPG cluster is managed by
the chart) and `windmill.db.reuseGoatConnection: false` (the default),
the chart **automatically**, independently of whether
`windmill.server.enabled` is currently true (deliberately — see below):

- declares `windmill_user`, `windmill_admin` (BYPASSRLS, IN ROLE windmill_user),
  and `windmill_owner_user` (IN ROLES windmill_admin + windmill_user,
  CREATEDB) as CNPG `managed.roles`, reconciled continuously — they exist
  (and stay in sync) regardless of when `postgresql.cluster.enabled` first
  turned on relative to anything else
- generates the `windmill_owner_user` password (once, persisted via
  `helm.sh/resource-policy: keep`) into the K8s Secret
  `<release>-pg-windmill-cred`
- creates the separate `windmill` database via a `windmill-db-init` init
  container on the windmill server and on every worker. It runs `psql` from
  the Postgres image the Cluster itself runs (`postgresql.cluster.image`,
  as that image's `postgres` user, uid 26), waits until it can log in as
  `windmill_owner_user`, and — only if `pg_database` has no `windmill` row —
  self-serves `CREATE DATABASE` using that role's `CREATEDB` grant ("already
  exists" from a racing sibling pod counts as success), then pins the role's
  `search_path` in it. No extra image, no PyPI egress, no hook.
- wires the windmill server + workers at it automatically — no extra values
  needed

Leaving `postgresql.cluster.image` empty is not supported while the chart
creates the windmill database — rendering fails with a message saying so.

The database is deliberately **not** created via CNPG's
`bootstrap.initdb.postInitSQL` (a very early version of this chart tried
that). `postInitSQL` runs once, as part of the Postgres cluster's one-shot
initdb Job — before the cluster is even up, and before the operator's
`managed.roles` reconciliation has run for the first time. A
`postInitSQL` statement that references `windmill_owner_user` as the new
database's owner therefore fails initdb outright with `role
"windmill_owner_user" does not exist`, every time, regardless of any other
timing: `managed.roles` is never reconciled before `postInitSQL`, contrary
to what an earlier comment in this chart assumed. The `windmill-db-init`
init container sidesteps this by running later, and retrying until the role
genuinely exists. Both this and the non-existent-database problem it
replaces were found running this chart's k3d smoke test against a genuinely
fresh install.

### Windmill workspace + token bootstrap (post-install hook)

On `helm install` / `helm upgrade`, a one-shot Job (controlled by
`windmill.bootstrap.enabled`, default `true`) runs after the windmill
server is up and:

- waits for `goat-windmill-server` to return `200` on `/api/version`
- logs in as the superadmin (`windmill.bootstrap.adminEmail`, default
  `admin@windmill.dev`)
- rotates the default `changeme` password to a chart-managed value (random
  32-char; preserved across upgrades), or to an operator-supplied secret
  named in `windmill.bootstrap.adminPasswordSecret`
- creates the `windmill.bootstrap.workspace` workspace (default `goat`)
  if missing
- keeps the token already stored in K8s Secret `<release>-windmill-token`
  (`token` key) while windmill still accepts it; otherwise mints a
  non-expiring API token and writes it there
- restarts the `processes` Deployment when its pods don't have that token
  yet (tracked by the pod-template annotation
  `goat.plan4better.de/windmill-token-sha256`, a fingerprint of the token)

`processes` gets `WINDMILL_URL`, `WINDMILL_WORKSPACE` and `WINDMILL_TOKEN`
(from that Secret) automatically. It reads the token at pod start, and on a
fresh install its pods are up before this hook runs — hence the restart. An
upgrade that keeps the token restarts nothing. Set
`processes.windmillAutoWire: false` to wire these yourself through
`processes.extraEnv` (e.g. against an external windmill); the hook then
leaves `processes` alone.

Hook RBAC is minimal — a release-namespace `Role` granting `create` on
Secrets in the namespace, `get/patch/update` scoped to the token Secret's
name, and `get/patch` on the `processes` Deployment only (omitted with
`processes.windmillAutoWire: false`).

The hook runs in GOAT's core image (`core.image`, so `global.imageRegistry`,
`global.imagePullSecrets` and the GOAT version apply as for core), since the
script needs only Python's standard library. Keys set in
`windmill.bootstrap.image` win over `core.image`.

Set `windmill.bootstrap.enabled: false` if you bootstrap windmill out-of-band
(e.g. via your own provisioning pipeline) — the hook then doesn't run.

### Optional: script sync

Set `windmill.scriptSync.enabled: true` to run a second post-install hook
(weight 20, after bootstrap) that uses the `windmill-worker-tools` image
to call `python -m goatlib.tools.sync_windmill` and
`python -m goatlib.tasks.sync_windmill`, pre-loading plan4better's
scripts/tasks into the workspace.

### DuckLake catalog bootstrap (init container)

`geoapi` and `processes` attach to the DuckLake catalog **read-only**;
DuckDB refuses to attach if the catalog doesn't exist, so without it both
crashloop on a fresh install with "Existing DuckLake at metadata catalog
... does not exist".

With `ducklakeBootstrap.enabled: true` (**the default since 0.5.0**) both
Deployments get a `ducklake-init` init container that runs GOAT's own
idempotent bootstrap, `python -m goatlib.storage.ducklake_init` (GOAT
v3.0.2+): a read-write ATTACH that creates the catalog if missing and is a
no-op against an existing one. It runs in the component's **own image**
(DuckDB, goatlib and the DuckLake extensions are baked in, so nothing is
downloaded at run time and the catalog is created in exactly the metadata
format the service attaches), with the same ConfigMap, Postgres
credentials, `<component>.extraEnv` and `data` mount as the service. It
works against the chart-managed CNPG cluster or an external Postgres alike.

The catalog location is pinned explicitly, so the init container creates it
exactly where the services look: the geoapi and processes ConfigMaps and the
print, tools and workflows workers all carry

| Env var | Default | Set by |
|---|---|---|
| `DUCKLAKE_POSTGRES_SERVER` | the Postgres host (geoapi and processes: unset, so they use `POSTGRES_SERVER`) | `postgresql.external.ducklakeHost` |
| `DUCKLAKE_POSTGRES_PORT` | the Postgres port (geoapi and processes: unset, so they use `POSTGRES_PORT`) | `postgresql.external.ducklakePort` |
| `DUCKLAKE_DATA_DIR` | `/app/data/ducklake` | `ducklakeBootstrap.dataDir` |
| `DUCKLAKE_CATALOG_SCHEMA` | `ducklake` | `ducklakeBootstrap.catalogSchema` |

(the same defaults GOAT's own `geoapi`/`processes` settings use). A
`geoapi.config.*` / `processes.config.*` key of the same name wins for that
component, and a worker's own `config` or `extraEnv` wins for that worker.

The init container retries for a couple of minutes (Postgres may still be
starting). One failure is not retried: a **DuckLake catalog version
mismatch** — a catalog created by an older duckdb (metadata format 0.3) that
this image's DuckDB (format 1.0) refuses to attach. That one-way migration
is never done automatically; the init container prints guidance pointing at
`docs/ducklake-15-upgrade.md` in the main goat repo and fails, leaving the
pod in `Init:CrashLoopBackOff` until the catalog is migrated.

Set `ducklakeBootstrap.enabled: false` only if you manage the catalog
out-of-band.

> Before 0.5.0 this key switched a post-install hook Job (off by default)
> that ran a copy of the bootstrap script on `python:3.11-slim` and
> `pip install`ed duckdb at run time. That hook is gone. Its
> `ducklakeBootstrap.s3.*` values are no longer read: the init container
> takes S3 settings from the component's own config/`extraEnv`, like the
> service does.

## Quick start — external Postgres

When deploying alongside a pre-existing Postgres cluster you have to
provision the goat (and, if you want windmill, the windmill) database +
users yourself, *then* point the chart at them. The chart only takes
operational connections — it never connects as superuser.

### 1. Run this SQL as your Postgres superuser

```sql
-- ===== goat database =====
CREATE USER goat WITH PASSWORD '<picked-by-you>';
CREATE DATABASE goat OWNER goat;
\c goat
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ===== windmill database (skip if windmill.server.enabled=false) =====
\c postgres
CREATE USER windmill_owner_user WITH PASSWORD '<picked-by-you>';
CREATE DATABASE windmill OWNER windmill_owner_user;

-- These role names are HARDCODED by windmill's migrations — do not rename.
-- Without them the windmill server's first migration aborts with
-- "role 'windmill_admin' does not exist".
CREATE ROLE windmill_user  WITH NOLOGIN;
CREATE ROLE windmill_admin WITH NOLOGIN BYPASSRLS;

-- windmill_admin must inherit windmill_user's table grants because
-- windmill runs runtime queries with `SET ROLE windmill_admin`.
GRANT windmill_user  TO windmill_admin;
GRANT windmill_admin TO windmill_owner_user;
GRANT windmill_user  TO windmill_owner_user;

-- windmill's sqlx pool ignores Postgres' default-search_path resolution,
-- so the migrations land in `public` only if we pin it explicitly here.
ALTER ROLE windmill_owner_user IN DATABASE windmill SET search_path = public;
```

### 2. Create K8s Secrets for the chart

```sh
kubectl create secret generic goat-postgres-creds \
  --from-literal=username=goat \
  --from-literal=password='<the goat password>'

kubectl create secret generic windmill-postgres-creds \
  --from-literal=username=windmill_owner_user \
  --from-literal=password='<the windmill password>'
```

### 3. Helm install

```yaml
postgresql:
  operator:
    enabled: false
  cluster:
    enabled: false
  external:
    host: "your-postgres.example.svc.cluster.local"
    database: goat
    existingSecret: goat-postgres-creds

windmill:
  db:
    reuseGoatConnection: false
    external:
      host: "your-postgres.example.svc.cluster.local"
      database: windmill
      existingSecret: windmill-postgres-creds

redis:
  enabled: true
```

The `existingSecret`s must contain `username` and `password` keys (or
override the key names via the `existingSecretUserKey` /
`existingSecretPasswordKey` fields).

> **Zalando-style installs (postgres-operator):** instead of running the SQL
> manually, declare `goat` and `windmill` as `preparedDatabases` in your
> `postgresql.acid.zalan.do` Cluster CR with `defaultUsers: true` (and for
> windmill, `schemas: public: defaultRoles: false` to suppress the
> Zalando-default `data` schema). The civitas-goat-addon does this; copy
> its `tasks/01_db.yml` for a working reference.

## Key values

| Key | Type | Default | Description |
|---|---|---|---|
| `core.enabled` | bool | `true` | Deploy `goat-core`. |
| `core.replicaCount` | int | `1` | Replicas. |
| `core.image.repository` | string | `plan4better/goat/core` | Image repository. |
| `core.image.tag` | string | `""` | Image tag; empty = `.Chart.AppVersion` (the GOAT release the chart is pinned to). |
| `global.auth.enabled` | bool | `false` | ONE auth switch for core, web, geoapi, processes and catalog (see "Authentication"). |
| `global.auth.existingSecret` | string | `""` | ONE Keycloak Secret for every service; keys named by `global.auth.existingSecretKeys` (`server-url`, `realm`, `client-id`, `client-secret`, `nextauth-secret`). |
| `<service>.auth.enabled` | bool/null | `null` | Per-service override for `core`, `web`, `geoapi`, `processes`, `catalog`; null inherits `global.auth.enabled`. |
| `<service>.auth.existingSecret` / `.existingSecretKeys` | string / map | `""` / `{}` | Per-service Secret / key names; empty inherits `global.auth`. |
| `global.auth.provisionInvitedUsers` | bool | `false` | Invitations to an email without a Keycloak account create the account, and Keycloak emails a set-password link (`KEYCLOAK_PROVISION_INVITED_USERS`). For realms with self-registration off; core's client needs the realm-management roles `view-users` and `manage-users`. |
| `global.auth.allowOrganizationCreation` | bool | `true` | Who may create an organization (`ALLOW_ORGANIZATION_CREATION`): `true` anyone who signs in without one; `false` only accounts with the Keycloak realm role `superuser`, everyone else waits for an invitation. Set up your organization, or give an account that role, before switching it off. |
| `global.auth.allowedClients` | list | `[]` | Keycloak clients whose tokens core, geoapi, processes and catalog accept (`AUTH_ALLOWED_CLIENTS`, matched against the token's `azp`). For a realm shared with other applications; must include GOAT's own client (core refuses to start otherwise). Empty accepts every client of the realm (see "Authentication"). |
| `global.caBundle.existingConfigMap` / `.existingSecret` / `.key` | string | `""` / `""` / `ca.crt` | A company CA certificate (PEM), mounted at `/etc/goat/ca/ca.pem` in core, web and the print, tools and workflows workers (see "Email and a company CA"). |
| `email.host` | string | `""` | SMTP server for GOAT's invitations; email is off while empty. |
| `email.port` / `.security` | int / string | `587` / `starttls` | `security`: `starttls`, `ssl` or `none`. |
| `email.user` / `.from` / `.fromName` | string | `""` / `""` / `GOAT` | Login, sender address (defaults to `user`; required for a relay without login) and sender name. |
| `email.existingSecret` / `.existingSecretKey` | string | `""` / `smtp-password` | Secret holding the SMTP password. |
| `email.brandName` / `.logoUrl` / `.contactUrl` / `.privacyUrl` | string | `GOAT` / `""` | Name, logo and footer links of GOAT's emails. |
| `odoo.url` / `.db` | string | `""` | Plan4Better's Odoo, shared by GOAT's Odoo integrations (`ODOO_URL`, `ODOO_DB`); optional, SaaS only. |
| `odoo.support.teamId` | string / int | `""` | Odoo Helpdesk team that receives support tickets (`ODOO_SUPPORT_TEAM_ID`); off while this, `odoo.url`, `odoo.db` or the key is empty (see "Support tickets"). |
| `odoo.support.postAction` | string | `GOAT: post message as ticket participant` | Odoo server action that posts a message as the ticket participant (`ODOO_SUPPORT_POST_ACTION`). |
| `odoo.support.existingSecret` / `.existingSecretKey` | string | `""` / `api-key` | Secret holding the support bridge's Odoo API key (`ODOO_SUPPORT_API_KEY`). |
| `core.ingress.enabled` | bool | `false` | Create Ingress resource for core API. |
| `core.ingress.className` | string | `""` | Ingress controller name (`nginx`, `traefik`, …). |
| `core.config.*` | map | see values.yaml | Non-secret env vars (rendered as ConfigMap). `MAX_UPLOAD_DATASET_FILE_SIZE` caps browser uploads (bytes, default 5 GB); set it in the Windmill workers' `config` too, for the jobs that import the files. |
| `global.s3.bucket` | string | `""` | S3 bucket for uploads; setting it gives core, geoapi, processes and the print, tools and workflows workers the store below (see "Object storage"). |
| `global.s3.provider` / `.endpointUrl` / `.publicEndpointUrl` / `.region` / `.forcePathStyle` | string / bool | `""` / `false` | The store: provider (`minio` forces path-style URLs), in-cluster endpoint (empty = AWS), browser-facing endpoint for upload links, region, path-style URLs. |
| `global.s3.existingSecret` / `.existingSecretKeys` | string / map | `""` / `access-key-id`, `secret-access-key` | Secret with the access key pair. |
| `global.s3.assets.bucket` / `.publicUrl` | string | `goat-assets` / `""` | Bucket for uploaded images in the same store and its public URL (`ASSETS_URL`); `publicUrl` is required with an `endpointUrl`. |
| `global.s3.assets.servedByCore` | bool | `false` | For a store without a publicly readable bucket: images go to `global.s3.bucket` under `assets/`, and core serves them (`ASSETS_SERVED_BY_CORE`). |
| `web.enabled` | bool | `true` | Deploy `goat-web` (Next.js frontend). |
| `web.ingress.enabled` | bool | `false` | Create Ingress for the web UI (requires `hosts` populated). |
| `geoapi.enabled` | bool | `true` | Deploy `goat-geoapi`. Its `ducklake-init` init container creates the DuckLake catalog (see below). |
| `processes.enabled` | bool | `true` | Deploy `goat-processes`. Same `ducklake-init` init container as geoapi. |
| `ducklakeBootstrap.enabled` | bool | `true` | Render the `ducklake-init` init container on geoapi/processes (was a hook, off by default, before 0.5.0). |
| `ducklakeBootstrap.dataDir` / `.catalogSchema` | string | `/app/data/ducklake` / `ducklake` | DuckLake location, emitted as `DUCKLAKE_DATA_DIR` / `DUCKLAKE_CATALOG_SCHEMA` to geoapi, processes and their init containers. |
| `core.migrate.enabled` | bool | `true` | Run `alembic upgrade head` + `initial_data` as a Helm hook (post-install / pre-upgrade). |
| `core.migrate.waitForDbSeconds` | int | `300` | How long the migrate hook waits for Postgres on fresh installs. |
| `postgresql.cluster.enabled` | bool | `true` | Create CNPG Cluster CR. |
| `postgresql.cluster.image` | string | `ghcr.io/cloudnative-pg/postgis:18-3.6-system-trixie` | Postgres image for the bundled CNPG Cluster. **New in 0.5.0.** CNPG's own default image has no PostGIS, which GOAT's schema requires, so the bundled-Postgres path does not work without a PostGIS-capable image here; `""` falls back to the operator's own default (broken for this chart's `postInitApplicationSQL`). |
| `postgresql.cluster.resources` | object | requests 512Mi / 100m, no limit | Resources of the bundled Postgres. **New in 0.7.0.** |
| `postgresql.operator.enabled` | bool | `true` | Install CNPG operator sub-chart. |
| `postgresql.external.host` | string | `""` | External Postgres host; required if cluster disabled. |
| `postgresql.external.ducklakeHost` | string | `""` | The database itself for DuckLake's catalog connections (geoapi, processes, their DuckLake init, the workers) when `host` is a transaction pooler. `""` = `host`. |
| `postgresql.external.ducklakePort` | int | `null` | The database's port for those connections when the pooler listens on another one (PgBouncer's 6432, the database's 5432). `null` = `port`. |
| `postgresql.external.transactionPooler` | bool | `false` | `host` is a pooler in transaction mode: core, geoapi, processes and the workers prepare no statements on the server and send no keepalive startup settings (`POSTGRES_TRANSACTION_POOLER`), so a pooler with stock settings works. Needs `ducklakeHost`, and Windmill on its own database connection (`windmill.db.reuseGoatConnection: false`); the chart refuses otherwise. |
| `postgresql.external.existingSecret` | string | `""` | K8s Secret with `username`+`password`. |
| `redis.enabled` | bool | `true` | Bundled Redis, geoapi's cache: the official `redis` image, nothing kept on disk, least recently used keys evicted at `redis.maxmemory` (`256mb`). |
| `redis.image.repository` / `.tag` | string | `redis` / `7.4-alpine` | The official Redis image, the one the Docker Compose bundle runs. |
| `redis.auth.existingSecret` / `.existingSecretPasswordKey` | string | `""` / `redis-password` | Secret with the password; empty = generated on install and kept on upgrades. Set one when Argo CD or `helm template` renders the chart. |
| `garage.enabled` | bool | `false` | Bundled S3 store: a single-node Garage, as in the Docker Compose bundle. Fills every empty key of `global.s3` (see "Garage — a bundled S3 store"). |
| `garage.image.repository` / `.tag` | string | `dxflrs/garage` / `v2.4.1` | Garage's image, the one the Docker Compose bundle runs. |
| `garage.existingSecret` | string | `""` | Secret with Garage's `rpc-secret` and `admin-token`; empty = generated on install and kept on upgrades. Set one when Argo CD or `helm template` renders the chart. |
| `garage.persistence.meta` / `.data` | map | `1Gi` / `50Gi` | Size and `storageClassName` of Garage's metadata and data volumes (ReadWriteOnce). |
| `garage.ingress.enabled` / `.className` / `.annotations` | bool / string / map | `false` / `""` / `{}` | Routes `/<bucket>` and `/<assets bucket>` on `web.ingress`'s host to Garage (ingress-nginx). |
| `windmill.server.enabled` | bool | `true` | Deploy windmill server (workflow engine). |
| `windmill.bootstrap.image` | object | `{}` = `core.image` | Image of the post-install bootstrap Job; keys set here win over `core.image`. **New in 0.7.0;** before, `python:3.11-slim` from Docker Hub, fixed. |
| `windmill.workers.default.enabled` | bool | `true` | Deploy default windmill worker. |
| `windmill.workers.default.replicaCount` | int | `1` | Scale workers via this knob. |
| `windmill.workers.print.enabled` | bool | `false` | Heavier worker for PDF/atlas generation (chromium). |
| `windmill.workers.tools.enabled` | bool | `false` | Geodata pipelines; needs tainted node + PVC. |
| `windmill.workers.workflows.enabled` | bool | `false` | Same as tools (different WORKER_GROUP). |
| `caddy.enabled` | bool | `false` | Custom-domains feature (LoadBalancer + ACME on-demand TLS). |
| `caddy.acmeEmail` | string | `admin@example.com` | Email for Let's Encrypt issuance — override per deployment. |
| `global.imageRegistry` | string | `""` | Mirror override for airgap deployments. |
| `data.enabled` | bool | `true` | Create/mount the shared `data` volume (see below). |
| `data.existingClaim` | string | `""` | Use a pre-provisioned claim instead of creating one. |
| `data.accessMode` | string | `ReadWriteOnce` | **Set `ReadWriteMany` on multi-node clusters** with an RWX-capable StorageClass. |
| `data.size` | string | `200Gi` | PVC size when the chart creates it. |
| `data.storageClassName` | string | `""` | Falls back to `global.storageClass`, then the cluster default. |
| `catalog.enabled` | bool | `true` | Deploy `goat-catalog` (STAC API + MCP server). |
| `catalog.s3.bucket` | string | `""` | Catalog bucket for previews/assets, and the OpenStreetMap and Overture mirror (`mirror/osm`, `mirror/overture`) read by processes and the workers for Add layer › Connect service; unset means those routes 404 and the two panes find no data. |
| `catalog.config.CATALOG_MCP_ALLOWED_HOSTS` | string | `'["*"]'` | `/mcp` Host allow-list (DNS-rebinding protection); narrow once you have a real hostname. |
| `web.publicUrls.api` / `.geoapi` / `.processes` / `.catalog` | string | `""` | Browser-facing service URLs; each is derived from that service's own ingress (scheme from its TLS, host from its first entry) when empty. |
| `web.websiteUrl` | string | `""` | Home's blog + changelog feeds; the surfaces hide when empty. |
| `web.supportEmail` | string | `""` | Address of "Report a problem" (a mailto link while support tickets are off) and of the "support unavailable" messages (`NEXT_PUBLIC_SUPPORT_EMAIL`). Defaults to `support@plan4better.de`; set your own address for a white-label installation. |
| `redis.external.host` | string | `""` | External Redis host, used when `redis.enabled: false`. |
| `redis.external.existingSecret` | string | `""` | Secret holding the external Redis password; omit for an unauthenticated Redis. |

For the full schema see `values.yaml` and `values.schema.json`.

## Authentication

One switch, `global.auth`, drives all five services that check logins —
core, web, geoapi, processes and catalog. Each one always gets an explicit
`AUTH=true|false` from the chart; none is left on its code default.

```yaml
global:
  auth:
    enabled: true
    existingSecret: goat-keycloak      # one Secret for every service
    existingSecretKeys:                # the defaults; rename if your Secret differs
      serverUrl: server-url            # https://idm.example.com (no /realms/...)
      realm: realm
      clientId: client-id
      clientSecret: client-secret
      nextauthSecret: nextauth-secret  # NextAuth.js signing key (web)
```

What each service reads from that Secret (by `secretKeyRef`):

| Service | Env from the Secret |
|---|---|
| core | `AUTH=true`, `KEYCLOAK_SERVER_URL`, `REALM_NAME`, `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET` |
| web | `AUTH=true`, `NEXT_PUBLIC_AUTH=true`, `NEXT_PUBLIC_KEYCLOAK_ISSUER` (server-url + realm), `NEXT_PUBLIC_KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET`, `NEXTAUTH_SECRET` |
| geoapi, processes, catalog | `AUTH=true`, `KEYCLOAK_SERVER_URL`, `REALM_NAME` |

With `enabled: true` and no Secret, services get `AUTH=true` only. geoapi and
processes then take `KEYCLOAK_SERVER_URL` / `REALM_NAME` from
`core.config.KEYCLOAK_SERVER_URL` / `core.config.REALM_NAME` (the catalog does
the same, whether auth is on or off); core and web keep what their `config`
holds. Set real values there — the shipped `core.config.KEYCLOAK_SERVER_URL`
is a placeholder.

With `enabled: false` (the default) nothing needs a Keycloak: core seeds a
default user and organization and every service acts as that user. Put such an
install behind your own access control.

**Precedence**, highest first:

1. **`<service>.config` / `<service>.extraEnv`.** `AUTH`, `KEYCLOAK_SERVER_URL`
   or `REALM_NAME` set there is used as is, and the chart renders that key
   nowhere else for that service — never twice, and never as a Secret-backed
   env var that would silently shadow your ConfigMap value (Kubernetes gives
   `env` precedence over `envFrom`). One exception, kept from 0.5.0: the
   Keycloak *placeholders* that `core.config` and `web.config` ship by default
   (`KEYCLOAK_SERVER_URL`, `KEYCLOAK_ISSUER`, `KEYCLOAK_CLIENT_*`,
   `NEXTAUTH_*`, `NEXT_PUBLIC_AUTH`) are replaced by the Secret whenever that
   service is wired to one.
2. **`<service>.auth`**: `enabled: true|false` beats the global switch (null or
   unset inherits it), a non-empty `existingSecret` beats the global one, and
   each `existingSecretKeys.<key>` beats the global key name.
3. **`global.auth`.**

Examples: `global.auth.enabled: true` with `geoapi.auth.enabled: false` runs
everything but geoapi with auth; `processes.auth.existingSecret:
processes-kc` points processes alone at another Secret.

**A realm shared with other applications.** Every client of the realm can get
a token signed with the realm's key, and without a list GOAT's APIs accept it.
`global.auth.allowedClients` limits that to the clients you name, matched
against the token's `azp` claim (the client Keycloak issued it to); a token of
any other client gets a `401`. The list must include GOAT's own client
(`client-id` in the Secret): the web app signs users in with it, and the print
worker and the services pass those tokens on. Without it core refuses to start,
naming `AUTH_ALLOWED_CLIENTS` and `KEYCLOAK_CLIENT_ID`.

```yaml
global:
  auth:
    allowedClients: [goat-web]
```

The chart renders it as `AUTH_ALLOWED_CLIENTS` (comma-separated) for core,
geoapi, processes and catalog, and leaves it out while the list is empty. A
value in `<service>.config` or `<service>.extraEnv` wins for that service. The
check works with Keycloak's defaults: no audience mapper is needed.

The list checks which client issued a token, not who the user is. If only some
users may use GOAT (a group check on GOAT's client, say), that rule must apply
to every flow the client allows, the browser login and, if enabled, *Direct
access grants*; otherwise turn those grants off on the client. A user removed
from the group stays signed in until the session ends in Keycloak (the web app
holds an offline refresh token).

## Email and a company CA

Core sends invitations through the SMTP server in `email`, with the password
from a Secret:

```bash
kubectl -n goat create secret generic goat-smtp --from-literal=smtp-password='…'
```

```yaml
email:
  host: smtp.example.org
  port: 587
  security: starttls        # ssl on 465, none for a relay on 25
  user: goat@example.org
  existingSecret: goat-smtp
```

The links in those emails come from the public web URL (`web.auth.publicUrl`,
else web's ingress) and the public API URL (`web.publicUrls.api`, else core's
ingress, plus `/api/v2`), rendered as `CLIENT_URL` and `API_URL`; set either
in `core.config` to override.

Keycloak sends its own emails — password resets, and the set-password link
for accounts created by `global.auth.provisionInvitedUsers` — with the SMTP
settings of its realm (*Realm settings → Email*). Configure the same server
there; the chart does not manage Keycloak.

When the relay, Keycloak or the pages the print worker opens use a
certificate from a private CA, put the CA certificate (PEM) into a ConfigMap
or Secret and name it in `global.caBundle`:

```bash
kubectl -n goat create configmap corporate-ca --from-file=ca.crt=corporate-ca.pem
```

```yaml
global:
  caBundle:
    existingConfigMap: corporate-ca
    key: ca.crt
```

The chart mounts it at `/etc/goat/ca/ca.pem` and sets `GOAT_CA_BUNDLE` in core
and the print, tools and workflows workers and `NODE_EXTRA_CA_CERTS` in web.
Each of them trusts it in addition to the public CAs. A variable you set
yourself in that service's `config` or `extraEnv` wins.

## Support tickets

Optional and off by default. GOAT can hand problem reports to an Odoo
Helpdesk; with the block empty the app shows "Report a problem" as an email
address plus the documentation, and every `/api/v2/support` route answers 404
except `/api/v2/support/summary`, which tells the app that support is off.
It is on only when `odoo.url`, `odoo.db`, `odoo.support.teamId` and the API
key are all set. The key is a secret that Plan4Better issues for its own
Odoo, so leave the `odoo` block empty on your own installation unless you
received one.

```bash
kubectl -n goat create secret generic goat-support --from-literal=api-key='…'
```

```yaml
odoo:
  url: https://odoo.example.org
  db: odoo-db
  support:
    teamId: 7
    existingSecret: goat-support
```

Ticket messages can carry up to 55 MiB of attachments in one request. An
ingress or proxy in front of core must accept bodies of at least 56 MB on
`/api/v2/support` and give the request time to finish. ingress-nginx limits
bodies to 1 MB by default, so with it set on `core.ingress.annotations`:

```yaml
core:
  ingress:
    annotations:
      nginx.ingress.kubernetes.io/proxy-body-size: "56m"
      nginx.ingress.kubernetes.io/proxy-read-timeout: "300"
      nginx.ingress.kubernetes.io/proxy-send-timeout: "300"
```

A variable you set yourself in `core.config` or `core.extraEnv` wins over the
block.

## Object storage — `global.s3`

GOAT keeps uploads (datasets, exports, prints) in one S3 bucket and uploaded
images (project and dataset thumbnails, avatars, dashboard images) in a
second one. `global.s3` describes the store once:

```bash
kubectl -n goat create secret generic goat-s3 \
  --from-literal=access-key-id='…' --from-literal=secret-access-key='…'
```

```yaml
global:
  s3:
    bucket: goat-uploads
    provider: hetzner                            # or aws, garage, …
    endpointUrl: https://s3.example.org          # empty on AWS
    publicEndpointUrl: https://s3.example.org    # how browsers reach it, if different
    region: us-east-1
    forcePathStyle: true
    existingSecret: goat-s3
    assets:
      bucket: goat-assets
      publicUrl: https://s3.example.org/goat-assets
```

Once `bucket` is set, core, geoapi, processes and the Windmill print, tools
and workflows workers get `S3_*` from it; core also gets the assets bucket
(`AWS_S3_ASSETS_BUCKET`, `ASSETS_URL`, `ASSETS_S3_ENDPOINT_URL`,
`ASSETS_S3_FORCE_PATH_STYLE` and the same key pair as `AWS_*`). Browsers load
uploaded images straight from `assets.publicUrl`, so that bucket must be
publicly readable. Outside AWS (`endpointUrl` set) `assets.publicUrl` is
required: core refuses to start without it, and the chart stops the install
first. On AWS it defaults to `https://<bucket>.s3.<region>.amazonaws.com`.

When the store has no publicly readable bucket, set `assets.servedByCore:
true` instead (GOAT v3.0.9 or later). Images then go to `global.s3.bucket`
under `assets/`, and links point at core's `/asset/file/<key>`, which answers
with a redirect to a short-lived signed URL on `publicEndpointUrl`. The links
default to core's API path on `CLIENT_URL`'s host; with core on another host,
set `assets.publicUrl` to `<core's public URL><API_V2_STR>/asset/file`.

A variable set in a service's own `config` or `extraEnv` wins, for example
`core.config.ASSETS_URL` for a CDN in front of the images, or an assets
bucket in another store with its own `AWS_*` key pair in `core.extraEnv`.
GOAT's own artwork ships in the web image under `/assets` and needs none of
this.

### Garage — a bundled S3 store

Without an S3 store of your own, `garage.enabled: true` runs a single-node
[Garage](https://garagehq.deuxfleurs.fr/) in the release, as the Docker
Compose bundle does: a Deployment on two ReadWriteOnce volumes
(`garage.persistence`), a Service with the S3 API on port 3900, the website
endpoint on 3902 and the admin API on 3903. It is GOAT's store: the chart
fills every key of `global.s3` you leave empty.

| `global.s3` key | With Garage |
|---|---|
| `bucket` / `assets.bucket` | `goat-uploads` / `goat-assets` |
| `endpointUrl`, `provider`, `region` | `http://<release>-goat-garage:3900`, `garage`, `garage`; path-style |
| `existingSecret` | `<release>-goat-garage-s3`, a key pair the chart generates once (Garage's format: `GK` and 24 hex digits, a 64-digit secret) |
| `publicEndpointUrl` | the web app's URL (`web.auth.publicUrl` or `web.ingress`) |
| `assets.publicUrl` | the web app's URL + `/goat-assets` |

A Job after every install and upgrade (`goatlib.storage.garage_init`, in
core's image, which ships it from GOAT v3.0.9 on; older images fail the Job)
assigns Garage's layout, creates both buckets, imports the key
pair and sets the uploads bucket's CORS rule. Set `global.s3.existingSecret`
to bring your own key pair; it has to be in Garage's format.

Browsers reach Garage on the web app's host, as in the compose bundle:
`/<bucket>` goes to the S3 API unchanged (presigned uploads are signed over
host and path), and `/<assets bucket>` to the website endpoint without the
prefix and with the Host `<assets bucket>.web.garage.internal`, for public
reads of images. `garage.ingress.enabled: true` creates both routes on
`web.ingress`'s hosts and TLS for ingress-nginx. With another controller,
route them yourself; without the second route, uploaded images do not load.

One node, no replication: back up its data volume
(`<release>-goat-garage-data`) as you back up the shared data volume. Both
volumes carry `helm.sh/resource-policy: keep`: turning Garage off or
uninstalling the release leaves them, and the files on them, in place.

## The shared data volume

One volume, seven mounts. The windmill **tools** and **workflows** workers write
to it — the catalog mirror (`sync_catalog`), the geoip database (`sync_geoip`),
materialized catalog layers and their PMTiles — and **catalog**, **core**,
**geoapi** and **processes** read from it (geoapi and processes read-write:
see the table below). Without a volume they all share, those features
silently do nothing: the catalog serves an empty STAC, core skips the geoip
lookup when placing a new project, and geoapi/processes find no materialized
layers.

| Component | Mount | Mode |
|---|---|---|
| catalog | `/app/data/catalog` (subPath `catalog`) | read-only |
| core | `/app/data/catalog`, `/app/data/geoip` (subPaths `catalog`, `geoip`) | read-only |
| geoapi | `/app/data` | read-write |
| processes | `/app/data` | read-write |
| windmill tools, workflows | `/app/data` | read-write |

**Who may write it.** geoapi, processes and the windmill workers all write to
the volume. The workers run as root, and a fresh RWX volume (NFS, CephFS)
belongs to root, so geoapi and processes, and their DuckLake init container,
run as root too (`podSecurityContext.runAsUser: 0`, as in the compose bundle).
`fsGroup` is not applied by many NFS drivers, so it is no way around this. A
cluster that enforces the restricted pod security standard needs a volume all
of them may write, and `geoapi.podSecurityContext` / `processes.podSecurityContext`
set to that user. Set `runAsUser` itself: `{}` merges with the default and
keeps root.

> ⚠️ **Multi-node clusters need `ReadWriteMany`.** The default is
> `ReadWriteOnce`, which works out of the box on single-node and
> default-StorageClass clusters. On more than one node an RWO volume can only be
> mounted by one node, and pods scheduled elsewhere will not start. Set
> `data.accessMode: ReadWriteMany` **and** point `data.storageClassName` at an
> RWX-capable class (NFS, CephFS, Longhorn RWX), or supply your own claim with
> `data.existingClaim`. `helm install`/`upgrade` NOTES print a NOTE (not a
> failure — RWO is correct on a single node) whenever `data.accessMode` is
> `ReadWriteOnce` and more than one component would mount the shared volume —
> it cannot detect your node count, so review it on every install.


```yaml
data:
  enabled: true
  existingClaim: ""          # BYO claim; skips PVC creation
  accessMode: ReadWriteMany
  size: 200Gi
  storageClassName: nfs-csi
```

## Enabling optional services

### `geoapi` and `processes` — DuckLake bootstrap

Both default to enabled since chart 0.5.0. GOAT has no self-creating DuckLake
schema variable — `DUCKLAKE_CREATE_IF_NOT_EXISTS` does not exist in GOAT and
must not be reintroduced. Both services attach the DuckLake catalog
**read-only** at startup and cannot start until it exists; their
`ducklake-init` init container (`ducklakeBootstrap.enabled`, default `true`)
creates it first, so they need no extra step on a fresh cluster — see
"DuckLake catalog bootstrap (init container)" above. Set `geoapi.enabled:
false` / `processes.enabled: false` if you don't want them.


### `catalog` — STAC API and MCP server

Enabled by default since chart 0.5.0. Database-less: it serves the mirror
parquet from the shared `data` volume (see "The shared data volume" above).
With no mirror present it serves an empty but valid STAC API, so it is safe to
run before `sync_catalog` has ever run.

**Data previews and assets** (`/stac/items/{id}/preview`, thumbnails, styles)
are the only routes that read the catalog *bucket*. Leave `catalog.s3` unset and
they answer 404 — deliberately: an endpoint a deployment does not offer simply
is not there. The rest of the STAC API is unaffected.

```yaml
catalog:
  s3:
    bucket: goat-catalog
    endpointUrl: https://s3.example.com
    region: auto
    existingSecret: catalog-s3-credentials   # keys: access_key, secret_key
```

**MCP host allow-listing.** The `/mcp` Streamable HTTP transport has
DNS-rebinding protection. The default `'["*"]'` disables the check, since a
fresh deployment's hostname is not known ahead of time. Once you have one:

```yaml
catalog:
  config:
    CATALOG_MCP_ALLOWED_HOSTS: '["catalog.goat.example.com"]'
```

### Where new projects open — `DEFAULT_PROJECT_VIEW_STATE`

GOAT places a new project near whoever created it, by geolocating their IP
against the geoip database on the shared `data` volume (populated by the
windmill `sync_geoip` task). **In a self-hosted install that never fires**:
users arrive from private addresses, which are never geolocated. Pin your
deployment to its own region instead:

```yaml
core:
  config:
    DEFAULT_PROJECT_VIEW_STATE: '{"latitude":48.14,"longitude":11.57,"zoom":11,"min_zoom":0,"max_zoom":20,"bearing":0,"pitch":0}'
```

**All seven fields are required.** `InitialViewState`
(`apps/core/src/core/schemas/project.py` in the main goat repo) declares
`latitude`, `longitude`, `zoom`, `min_zoom`, `max_zoom`, `bearing` and `pitch`
with no defaults — a value missing any of them fails Pydantic validation. That
failure is **silent**: `configured_view_state()` catches it, logs "
`DEFAULT_PROJECT_VIEW_STATE is not a valid view state; ignoring it`", and
returns `None` — no startup error, no merge with defaults. An incomplete value
just quietly stops pinning the region, and new projects keep falling through
to the world view.

### Schema migrations — `core.migrate` (default on)

Every install/upgrade runs a Helm hook Job (`<release>-core-migrate`) before
the new pods start: `alembic upgrade head` followed by
`core.scripts.initial_data` (SQL functions, triggers, authz seed data — and
the default user/organization when `core.auth.enabled: false`). On fresh
installs it waits up to `core.migrate.waitForDbSeconds` for the bundled
Postgres to come up. A failed migration aborts the release and leaves the
running version untouched. Set `core.migrate.enabled: false` to manage the
schema out-of-band.

### Heavy windmill workers — `tools` and `workflows`

These workers pin to a tainted node (`node.kubernetes.io/server-usage=geodata`, toleration `geodata=true:NoSchedule`). They only run on clusters that have such a node pool. To enable:

```yaml
windmill:
  workers:
    tools:
      enabled: true
      replicaCount: 1
    workflows:
      enabled: true
      replicaCount: 1
```

Storage comes from the shared `data` volume (see "The shared data volume"
above) whenever `data.enabled: true` (the default) — both workers mount it
full read-write at `/app/data`. Each worker's own `persistence.*` block is
only used as a fallback when `data.enabled: false`, and creates a separate,
worker-specific PVC instead.

**What the jobs get.** Windmill runs GOAT's tools, imports, workflows and
prints as scripts inside the `tools`, `workflows` and `print` workers, and
hands a script only the variables named in `WHITELIST_ENVS`. The chart gives
these three workers what the scripts read and builds that list itself:

- the GOAT database (`POSTGRES_*`, from `postgresql.*`) and DuckLake
  (`DUCKLAKE_*`, from `ducklakeBootstrap.*`);
- S3 from `global.s3` and the catalog bucket from `catalog.s3`;
- `PRINT_BASE_URL`, the in-cluster web service the print worker renders;
- with `global.auth` wired to a Secret, the Keycloak client the print worker
  logs in with (`KEYCLOAK_*`, `REALM_NAME`);
- `GOAT_CA_BUNDLE` with `global.caBundle`.

Each worker also gets a `JOB_DEFAULT_TIMEOUT`, the seconds a job may run
before Windmill cancels it: 2500 for `tools`, 1800 for `workflows`, 300 for
`print` and `default`. Raise it in the worker's `config` for longer analyses.

Every name in a worker's `config` and `extraEnv` joins the list too, so a
setting added there (e.g. `GEOCODING_URL`) reaches the scripts. A variable set
there wins over the chart's; a `WHITELIST_ENVS` set there replaces the built
list. The `default` worker runs only Windmill's own small jobs and gets none
of this.

Without a tainted node available, the worker pods will sit in `Pending` and the chart's `helm install --wait` will time out. Don't enable them unless you've prepared the node side.

### `caddy` — custom-domains feature

Caddy fronts the web UI for customers who point their own DNS at GOAT. On-demand TLS issues Let's Encrypt certs only for domains that `goat-core /api/v2/custom-domain-lookup` approves. Requires:
- A `LoadBalancer` service (cluster must support it — metallb / cloud LB)
- Public DNS pointing at the LB IP for any customer domain
- A real email for ACME issuance (LE uses it for rate-limit notices)

```yaml
caddy:
  enabled: true
  acmeEmail: "ops@your-org.example"
  service:
    type: LoadBalancer
    loadBalancerIP: "203.0.113.5"   # optional, if you have a reserved IP
```

The chart creates a persistent volume for ACME state by default (1Gi); losing it triggers re-issuance of every cert, which hits Let's Encrypt rate limits. **Don't disable persistence in production.**

## Portability

The chart targets any conformant Kubernetes cluster:
- Standard `networking.k8s.io/v1 Ingress` only (no Traefik `IngressRoute`).
- StorageClass never hardcoded; defaults to cluster default.
- ServiceMonitor templates guarded on `monitoring.coreos.com/v1` CRD presence.
- Node selectors/tolerations always from values.

## Development

```sh
# install helm-unittest plugin — same version CI pins (.github/workflows/helm.yml).
# The tests use `kubernetesProvider` and `failedTemplate.errorPattern`, which
# older plugin versions silently ignore; v1.x itself needs Helm >= 3.17.
helm plugin install https://github.com/helm-unittest/helm-unittest --version v1.1.0

# run unit tests
helm unittest deploy/helm/goat/

# render with external-deps fixture
helm template my-release deploy/helm/goat/ -f deploy/helm/goat/ci/values-external-deps.yaml
```

## Resource defaults

Every service has memory requests and limits, and a CPU request without a
limit (a CPU limit throttles). The limits are the ones GOAT's own production
runs with. DuckDB spills to disk only when it reaches its own `memory_limit`,
and a service holds several DuckDB connections with a budget each, so the
budgets stay under 3/4 of each limit, leaving room for what DuckDB keeps
outside them: `geoapi.config` sets geoapi's (`GEOAPI_DUCKLAKE_POOL_SIZE`,
`GEOAPI_DUCKDB_MEMORY_LIMIT`), `processes.config` the budget of each of its
three connections (`PROCESSES_DUCKDB_MEMORY_LIMIT`), and catalog's store has
`CATALOG_DUCKDB_MEMORY_LIMIT`. Raise a budget and its limit together. In the
tools and workflows workers a job's analysis gets half the container's limit
and its DuckLake connection a quarter, so there the budgets follow the limit.

| Service | Request (memory / CPU) | Memory limit |
|---|---|---|
| core, web | 256Mi / 100m | 1Gi |
| geoapi | 1Gi / 250m | 4Gi |
| processes, catalog | 512Mi / 100m | 4Gi |
| windmill server | 256Mi / 100m | 2Gi |
| windmill default and workflows workers | 256Mi / 100m | 1Gi |
| windmill print worker | 512Mi / 100m | 4Gi |
| windmill tools worker | 1Gi / 250m | 4Gi |
| bundled Postgres (`postgresql.cluster.resources`) | 512Mi / 100m | none |
| bundled Garage (`garage.resources`, off by default) | 256Mi / 50m | 512Mi |

A default install requests about 3.8Gi of memory and 1 CPU. A rollout starts
each new pod before it stops the old one, so keep a pod's request free on top
(1Gi for geoapi).

Override them per service under `<service>.resources`. Helm merges what you
set with these defaults: set requests and limits together, since a lower limit
alone keeps the default request and a request above a limit is rejected. To
drop them, set `<service>.resources: null`; `{}` keeps the defaults. With a CPU
limit on geoapi, keep `GEOAPI_DUCKDB_THREADS` × `GEOAPI_DUCKLAKE_POOL_SIZE` at
about its CPUs.

### Windmill's database connections

Each Windmill container holds at most `DATABASE_CONNECTIONS` connections to its
database: the server 10 (`windmill.server.config.DATABASE_CONNECTIONS`; unset,
its pool grows to 50 under load) and every worker 3
(`windmill.workers.databaseConnections`; a worker runs one job at a time). Not
below 3 for the workers: Windmill 1.607 workers stop at start with fewer.

## Compatibility / version history

| Chart version | Adds | Notes |
|---|---|---|
| `0.8.0` | processes gets the catalog bucket (`catalog.s3`, `CATALOG_S3_*`) and reads the OpenStreetMap and Overture mirror goat-data publishes there (`mirror/osm`, `mirror/overture`) for Add layer › Connect service | No values change needed |
| `0.7.0` | GOAT v3.0.9 (Windmill 1.751). Memory requests and limits and CPU requests for every service, and geoapi's and processes' DuckDB budgets to fit them (see "Resource defaults"); `postgresql.cluster.resources`; geoapi and processes run as root, so their DuckLake init can create the catalog directory on a fresh RWX volume; `postgresql.external.ducklakeHost` and `ducklakePort` for DuckLake's catalog connections and `transactionPooler` for the services when `host` is a transaction pooler; `windmill.bootstrap.image` (GOAT's core image instead of `python:3.11-slim` from Docker Hub); `POSTGRES_*` keys in a service's `config` render once and win; `global.auth.allowOrganizationCreation` (`ALLOW_ORGANIZATION_CREATION`: false lets only superusers create organizations); `global.auth.allowedClients` (`AUTH_ALLOWED_CLIENTS` for core, geoapi, processes and catalog: only tokens issued to the listed Keycloak clients are accepted); Windmill's database pools: the server at most 10 connections, every worker 3 (`windmill.workers.databaseConnections`); core's migrate hook gets the Keycloak settings and `core.extraEnv` like the core Deployment (with auth on, GOAT v3.0.5+ failed at the hook); pods roll when their ConfigMap changes (`checksum/config`), so a settings-only upgrade takes effect without a manual restart; `garage` (optional bundled S3 store, as in the Docker Compose bundle; `goatlib.storage.garage_init` replaces the bundle's init script) | Pods now have memory limits, geoapi and processes get smaller DuckDB budgets (geoapi two pooled queries instead of four), and geoapi and processes run as root — see "Upgrading 0.6.0 → 0.7.0" |
| `0.6.0` | `global.s3` (one S3 store for core, geoapi, processes and the workers, uploads and uploaded images); the print, tools and workflows workers get GOAT's database, DuckLake, S3, catalog bucket, `PRINT_BASE_URL` and Keycloak client, with `WHITELIST_ENVS` built by the chart, and job timeouts per worker (`JOB_DEFAULT_TIMEOUT`); the chart's own Redis on the official image instead of the Bitnami sub-chart; `email` (SMTP for invitations, password from a Secret, email branding) with `CLIENT_URL` / `API_URL` derived for the links in emails; `global.auth.provisionInvitedUsers`; `odoo` (Plan4Better's Odoo, optional: the shared connection and `odoo.support` for support tickets, API key from a Secret) and `web.supportEmail`; `global.caBundle` (company CA for core, web and the print, tools and workflows workers) | The S3 and assets placeholders are gone from `core`, `geoapi` and `processes`, and the workers' fixed `WHITELIST_ENVS` is replaced by a built one — see "Upgrading 0.5.1 → 0.6.0" |
| `0.5.1` | GOAT v3.0.3 (no runtime downloads in the workers, `ROOT_PATH`, `sync_base_data`); `global.auth`: one auth switch + one Keycloak Secret for core, web, geoapi, processes, catalog; `geoapi.auth` / `processes.auth` | Fixes: geoapi + processes ran auth ON at chart defaults (401 on feature edits and every job route) and, with auth on, validated tokens against plan4better's dev Keycloak; a fresh install's processes had no windmill token (every tool run failed until a manual restart); `processes.windmillAutoWire: false` was ignored. No values change needed — see "Upgrading 0.5.0 → 0.5.1" |
| `0.5.0` | GOAT v3.0.2: `catalog` service (STAC API + MCP); shared `data` volume; single-command fresh install (DuckLake + windmill DB bootstrap moved from hooks to init containers); `REDIS_URL`, web `NEXT_PUBLIC_*` and windmill `WHITELIST_ENVS` fixes; bundled Postgres image moves from CNPG's default major 17 to 18 (`ghcr.io/cloudnative-pg/postgis:18-3.6-system-trixie`) | BREAKING: `helm upgrade` DELETES `<fullname>-windmill-tools-data` and `<fullname>-windmill-workflows-data` unless you first `kubectl annotate` them `helm.sh/resource-policy=keep` (worker `persistence` superseded by `data`, no automatic migration; the upgrade fails until you do or set `windmill.workers.legacyPersistence.acknowledgeDeletion` — see upgrade note 1 below); geoapi + processes now default on |
| `0.4.0` | automatic schema migrations (`core.migrate.*` hook); `NEXT_PUBLIC_AUTH_DISABLED` → `NEXT_PUBLIC_AUTH` | BREAKING: flip the web auth flag in your values |
| `0.2.0` | windmill (server + 4 workers), caddy (custom-domains) | Both off by default for opt-in; one knob each to enable |
| `0.1.0` | initial — core, web, geoapi, processes templates | First public release |

### Upgrading 0.6.0 → 0.7.0

1. **Memory limits.** Every service gets the requests and limits in "Resource
   defaults". A deployment whose pods used more (geoapi on a large catalog,
   big analyses in the tools worker) should raise `<service>.resources` before
   upgrading, or set it to `null` to keep running without limits. Values that
   set only a limit, or only a request, now merge with the other default; a
   request above its limit fails the upgrade, so set both.
2. **DuckDB budgets.** `geoapi.config` now sets
   `GEOAPI_DUCKLAKE_POOL_SIZE: "2"` and `GEOAPI_DUCKDB_MEMORY_LIMIT: "768MB"`,
   and `processes.config` `PROCESSES_DUCKDB_MEMORY_LIMIT: "1GB"`, so DuckDB fits
   the 4Gi limits; before, the code defaults applied (a pool of 4 at 1GB,
   1.2GB). With more memory, raise the limit and the budgets together.
3. **geoapi and processes run as root.** Before, they ran as the image's
   non-root user, and their DuckLake init failed with a `PermissionError` on a
   fresh root-owned RWX volume. To keep a non-root user, set
   `geoapi.podSecurityContext.runAsUser` and
   `processes.podSecurityContext.runAsUser`, and make sure that user may write
   the whole data volume, files the workers created included. Values that set
   `runAsNonRoot: true` must set `runAsUser` too, or the pods are refused. On
   a cluster that assigns user ids itself (OpenShift) or forbids root, set
   `geoapi.podSecurityContext.runAsUser: null` and the same for processes.
4. **Windmill 1.751 and its database pools.** GOAT's images move from Windmill
   1.607 to 1.751. Its server migrates the Windmill database on start, one
   way: back that database up before upgrading, and don't go back to older
   images afterwards. The server holds at most 10 database connections and
   every worker 3 (see "Windmill's database connections").

### Upgrading 0.5.1 → 0.6.0

1. **S3 moves to `global.s3`.** `core.config`, `geoapi.config` and
   `processes.config` no longer ship S3 placeholders (`S3_PROVIDER: minio`,
   `S3_ENDPOINT_URL: http://placeholder-s3`, `S3_BUCKET_NAME:
   goat-placeholder`, `AWS_REGION`, `AWS_S3_ASSETS_BUCKET: placeholder`,
   `ASSETS_URL: https://example.com/assets`), and their `extraEnv` defaults no
   longer carry placeholder key pairs. Real S3 values you set in those blocks
   keep working and win. To set the store once, move them into `global.s3`
   and drop the per-service copies. Without either, the services start but
   uploads fail, as before. Uploaded images whose URL was stored on
   example.com keep that URL.
2. **Workers.** The print, tools and workflows workers now get the GOAT
   database, DuckLake, S3, the catalog bucket and `PRINT_BASE_URL` from the
   chart, and a `WHITELIST_ENVS` it builds. If your values set
   `windmill.workers.<worker>.config.WHITELIST_ENVS`, that list still replaces
   the built one; remove it to let the chart keep the list complete. Worker
   `config` / `extraEnv` entries for the same variables keep winning.
3. **Redis** is the chart's own Deployment on the official `redis` image;
   the Bitnami sub-chart and its `bitnamilegacy/redis` image, which no longer
   gets updates, are gone. The upgrade replaces the old Redis StatefulSets
   and Secret with a new Redis and a new generated password, so geoapi's
   cache starts empty once. Sub-chart values (`redis.architecture`,
   `redis.master.*`, `redis.replica.*`, `global.security.allowInsecureImages`)
   are no longer read; `redis.external.*` is unchanged.
4. **Email** is new and off until `email.host` is set. SMTP settings you
   already pass through `core.config` or `core.extraEnv` keep working and win
   over the `email` block.
5. **Core gets `CLIENT_URL` and `API_URL`** from the public web and API URLs,
   where it used to fall back to `http://localhost:3000` and
   `http://localhost:8000/api/v2`. Values you set in `core.config` win.

6. **Support tickets** are new, optional and off until the `odoo` block
   and `odoo.support` are set. If you turn them on, raise the body size limit of the ingress in
   front of core to at least 56 MB (see "Support tickets").

### Upgrading 0.5.0 → 0.5.1

No values change is required; explicit per-service values keep working. What
changes on the pods:

1. **geoapi and processes now get an explicit `AUTH`.** 0.5.0 set none for
   them, so their code default applied: AUTH **on**, while core, web and
   catalog ran with it off at chart defaults. With web auth off there is no
   login and no token, so on a bare install maps displayed (geoapi's read
   routes accept anonymous requests) but saving feature edits and every
   processes route that needs a user — running tools, listing jobs — answered
   401. At chart defaults they now get `AUTH=false`, like the rest. If you
   depended on them enforcing auth while core ran without, set
   `geoapi.auth.enabled: true` / `processes.auth.enabled: true` (plus a
   Keycloak Secret) explicitly.
2. **geoapi and processes now get the Keycloak URL and realm.** 0.5.0 never
   passed them, so an auth-on install validated tokens against the code
   default — plan4better's own development Keycloak — rejecting every token
   from your Keycloak and calling out to it at pod start (fatal air-gapped).
   They now read `KEYCLOAK_SERVER_URL` / `REALM_NAME` from the Keycloak Secret
   (`global.auth.existingSecret` or `<service>.auth.existingSecret`), or from
   `core.config` when no Secret is set.
3. **Hand-set values win.** If you worked around (2) by setting `AUTH`,
   `KEYCLOAK_SERVER_URL` and `REALM_NAME` in `geoapi.config` /
   `processes.config` (the civitas addon does), those values are kept and
   rendered once; the chart adds nothing for those keys. You can drop them in
   favour of `global.auth` when convenient.
4. **`<service>.auth.enabled` defaults to null** (inherit `global.auth.enabled`,
   default `false`) instead of `false`, and `<service>.auth.existingSecretKeys`
   to `{}` (inherit `global.auth.existingSecretKeys`, same key names as
   before). An explicit `true`/`false` behaves exactly as in 0.5.0. To keep a
   0.5.0-style values file with one Secret per service, change nothing; to
   simplify, replace the per-service blocks with one `global.auth`.
5. **No duplicate keys.** `core.config.AUTH`, `web.config.AUTH` and
   `catalog.config.KEYCLOAK_SERVER_URL` used to be rendered twice in the
   ConfigMap (yours plus the chart's). Yours now wins alone. Likewise, with
   core wired to a Secret, a Keycloak key you set in `core.extraEnv` is no
   longer also emitted from the Secret (your value won before too). And with
   the catalog wired to a Secret, `catalog.config.KEYCLOAK_SERVER_URL` now
   wins over the Secret instead of being shadowed by it. The catalog also gets
   `REALM_NAME` from `core.config.REALM_NAME` when set and no Secret is.
6. **processes gets its windmill token on a fresh install.** processes reads
   `WINDMILL_TOKEN` from the bootstrap hook's Secret at pod start, but the
   hook runs after `helm install --wait` has brought processes up, and
   nothing restarted it: on 0.5.0 every tool run and job listing failed
   (500) until processes was restarted by hand. The hook now restarts the
   processes Deployment whenever the token is new to it, and keeps the stored
   token while windmill accepts it — 0.5.0 minted another non-expiring token
   on every upgrade (old ones stay valid; revoke them in windmill's user
   settings if you like, label `goat-chart-bootstrap`). The first upgrade to
   0.5.1 restarts processes once more after the upgrade itself, when the hook
   stamps the token fingerprint annotation for the first time.
7. **`processes.windmillAutoWire: false` works.** It was ignored (the chart
   always injected `WINDMILL_URL`/`WINDMILL_WORKSPACE`/`WINDMILL_TOKEN`); with
   it, processes now gets none of them and the hook leaves processes alone.

### Upgrading 0.4.x → 0.5.0

1. **Worker storage moved — `helm upgrade` WILL DELETE your old worker data
   unless you annotate the old claims FIRST.**
   `windmill.workers.{tools,workflows}.persistence` is superseded by the
   top-level `data` volume (default `data.enabled: true`), and those workers
   now mount the shared claim at `/app/data` instead of their own PVC. At that
   default the old per-worker PVC templates render nothing, and Helm deletes
   every resource the previous revision had that the new one does not render:
   the claims `<fullname>-windmill-tools-data` and
   `<fullname>-windmill-workflows-data` — and, with the usual `Delete` reclaim
   policy, their PVs and data. `<fullname>` is `<release>-goat`, or just
   `<release>` when the release name already contains `goat` (release `goat`
   → `goat-windmill-tools-data`), or `fullnameOverride` when set; list them with
   `kubectl -n <ns> get pvc | grep windmill-`.

   **Step 1, BEFORE `helm upgrade`:** put the keep policy on the LIVE claims.
   Helm reads `helm.sh/resource-policy` from the object in the cluster at the
   moment it would delete it, so this is what stops the deletion (verified on
   k3d: an annotated claim survived the upgrade, an unannotated one went
   `Terminating`):

   ```sh
   kubectl -n <ns> annotate pvc \
     <fullname>-windmill-tools-data <fullname>-windmill-workflows-data \
     helm.sh/resource-policy=keep
   ```

   (Name only the claims that exist.) The annotation this chart's own
   `pvc.yaml` sets does not help on this hop: 0.4.x never set it, and a
   template the new release no longer renders applies nothing to the live
   claim.

   **Step 2:** run the upgrade. The claims are left in place, no longer
   managed by the release. Then either copy their data onto the shared
   volume, or reuse one of them as the shared volume with `data.existingClaim`
   — that is safe **only after step 1**: `data.existingClaim` on its own does
   not stop the deletion (the claim is still absent from the manifest, so
   Helm still deletes it; pvc-protection merely holds it `Terminating` while
   the old pod uses it, and the new pods cannot mount a `Terminating` claim),
   and naming one claim leaves the other one unprotected. Patching the bound
   PV(s) to `persistentVolumeReclaimPolicy: Retain` additionally keeps the
   volume if a claim is ever deleted, but the data is then only reachable by
   re-binding the PV to a new claim by hand.

   **The chart refuses the unsafe upgrade.** While
   `windmill.workers.legacyPersistence.acknowledgeDeletion` is `false` (the
   default), `helm upgrade` looks the legacy claims up (Helm `lookup`) and
   FAILS before touching anything if one of them belongs to this release,
   will not be rendered, and lacks the annotation; the error prints the exact
   `kubectl annotate` command. Set it to `true` only if you want the claims
   deleted. `lookup` returns nothing under `helm template` and client-side
   `--dry-run`, so offline rendering never trips the check (`--dry-run=server`
   does run it). The NOTES printed after an upgrade repeat the warning but
   come too late to act on; the annotation has to happen before.

   GitOps: Argo CD renders the chart with `helm template` (no `lookup`, so
   the guard never fires) and prunes by its own rules, which do not read
   `helm.sh/resource-policy`. Under Argo CD, disable pruning for those
   claims (`argocd.argoproj.io/sync-options: Prune=false` on the live
   claims) or copy the data out before syncing 0.5.0. Flux's
   helm-controller runs a real `helm upgrade`, so the steps above apply.

2. **geoapi and processes now default on.** If you were relying on the
   lightweight core+web default, set `geoapi.enabled: false` and
   `processes.enabled: false` explicitly.
3. **`GOAT_GEOAPI_HOST` → `GOAT_PROCESSES_URL`.** The chart no longer sets the
   old name. Core still reads it as a fallback, so an explicit override keeps
   working — but move it to `core.config.GOAT_PROCESSES_URL`.
4. **Check `data.accessMode`.** It defaults to `ReadWriteOnce`. On a
   multi-node cluster set `ReadWriteMany` with an RWX-capable StorageClass —
   see "The shared data volume" above.
5. **DuckLake bootstrap is now an init container, on by default.**
   `ducklakeBootstrap.enabled` now defaults to `true` and renders a
   `ducklake-init` init container on geoapi and processes instead of the old
   post-install hook; `ducklakeBootstrap.s3.*` is no longer read. The init
   container runs on every pod start, in the geoapi/processes image
   (DuckDB 1.5.4, DuckLake metadata format 1.0). If your catalog was created
   by an older bootstrap (duckdb 1.4.3, format 0.3), that DuckDB refuses to
   attach it: the init container stops with guidance and the pods stay in
   `Init:CrashLoopBackOff` — migrate first, per `docs/ducklake-15-upgrade.md`
   in the main goat repo (the services themselves would refuse that catalog
   too). The windmill database likewise moved from a hook to a
   `windmill-db-init` init container; `windmill.db.bootstrapImage` is gone.
6. **`postgresql.cluster.image` now has a default; it had none before.**
   0.4.x never set `spec.imageName` on the bundled CNPG `Cluster`, so CNPG
   applied its own default image — plain Postgres 17, no PostGIS. But
   0.4.x's `postInitApplicationSQL` already unconditionally ran `CREATE
   EXTENSION postgis` against that database, so *every* bundled-Postgres
   install's initdb Job failed outright with `extension "postgis" is not
   available`, and the Cluster never left initdb — this is the exact
   failure this chart's own k3d smoke test caught, run against the
   unmodified 0.4.x template before `postgresql.cluster.image` existed at
   all. In practice there is no working 0.4.x bundled-Postgres deployment
   to migrate, so setting this default in 0.5.0
   (`ghcr.io/cloudnative-pg/postgis:18-3.6-system-trixie`, Postgres 18) is
   not a live-upgrade hazard for anyone actually running the bundled path
   — there is nothing in the field it could break. It only matters if you
   worked around the 0.4.x bug yourself with your own custom
   `postgresql.cluster.image` override: CNPG does not perform a Postgres
   major-version change as a rolling update when `imageName` changes on an
   existing `Cluster`, so if your workaround image's major version differs
   from 18, keep your existing override in place through the upgrade
   rather than letting the new default apply underneath you.

## License

GPLv3, like the rest of GOAT (see [`LICENSE`](../../../LICENSE)).
