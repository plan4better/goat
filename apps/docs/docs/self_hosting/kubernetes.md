---
sidebar_position: 3
sidebar_label: Kubernetes (Helm)
description: "Install GOAT with the Helm chart and set what it leaves to you: public URLs, S3 storage, Keycloak login, the analysis workers and multi-node storage."
---

# Kubernetes (Helm)

GOAT has a Helm chart for Kubernetes clusters, published at `oci://ghcr.io/plan4better/charts/goat`. This page summarises what the chart includes and what you have to provide. The [chart README](https://github.com/plan4better/goat/tree/main/deploy/helm/goat) is the full reference for all values.

:::tip One server? Use Docker Compose
For a single server, the [Docker Compose bundle](./docker_compose/installation.md) is the recommended path. It includes the login server, object storage and HTTPS, which the Helm chart leaves to you.
:::

This page describes chart version **0.8.0**, which installs GOAT **v3.0.9** by default.

## Install {#install}

```bash
helm install goat oci://ghcr.io/plan4better/charts/goat \
  --version 0.8.0 \
  --namespace goat --create-namespace \
  --values your-values.yaml \
  --wait --timeout 25m
```

A first install pulls several large images, which is why the timeout is long. A fresh cluster needs this one command only.

## What the chart includes {#included}

| Component | Default |
|---|---|
| core, web, geoapi, processes, catalog | on |
| Windmill server and the default worker | on |
| Windmill workers `tools`, `workflows` and `print` | **off** |
| PostgreSQL through CloudNativePG (operator and cluster) | on, optional sub-chart |
| Redis | on, optional |
| A shared data volume (`data`, 200 Gi, `ReadWriteOnce`) | on |
| Caddy for custom domains | off |

The chart does **not** include:

- **Object storage.** GOAT needs an S3-compatible store: your own, or the Garage the chart can run for you.
- **Keycloak.** If users should log in, you need an external Keycloak.

You can also point the chart at an existing PostgreSQL or Redis instead of the bundled ones; the chart README lists the SQL your PostgreSQL needs. If `postgresql.external.host` is a connection pooler in transaction mode, set `postgresql.external.transactionPooler: true` (`POSTGRES_TRANSACTION_POOLER`), so GOAT prepares no statements on the server and sends no settings the pooler might refuse, and set `postgresql.external.ducklakeHost` to the database itself: DuckLake keeps its catalog connections open, so they bypass the pooler. If the pooler listens on another port than the database (PgBouncer's default is 6432), also set `postgresql.external.ducklakePort` to the database's port.

Every service has memory requests and limits by default, and a CPU request without a limit. The chart README lists them; raise them under `<service>.resources` if a service needs more, for example geoapi on a large catalog, and set requests and limits together.

## What you have to set {#required-values}

### Public URLs {#public-urls}

The browser calls core, geoapi, processes and catalog directly, so the web app needs their public addresses. Give each service an Ingress with a host (`<service>.ingress.*`), and the URLs are derived from it, or set them explicitly in `web.publicUrls.api`, `.geoapi`, `.processes` and `.catalog`.

:::warning
Without these URLs, the web app shows a blank page.
:::

### Object storage {#storage}

Describe your S3 store once in `global.s3`: the bucket for uploads, the provider, endpoint, region and whether it needs path-style URLs, and a Secret with the access key pair (`global.s3.existingSecret`). Core, geoapi, processes and the analysis workers (below) all get these settings.

Uploaded images, such as project and dataset thumbnails, avatars and dashboard images, go to a second bucket in the same store (`global.s3.assets.bucket`). Browsers load them straight from that bucket, so make it publicly readable and set its public URL in `global.s3.assets.publicUrl`. Outside AWS the URL is required. GOAT's own artwork ships in the web app and needs neither.

If your store allows no publicly readable bucket, set `global.s3.assets.servedByCore: true` instead (`ASSETS_SERVED_BY_CORE`). GOAT then keeps the images in the uploads bucket under `assets/`, and core serves them through its API, so you need no assets bucket and no public URL. Core must run GOAT v3.0.9 or later, newer than the chart's default: set `core.image.tag`. The image links point to core's API on the web app's host; if core has a host of its own, set `global.s3.assets.publicUrl` to `<core's public URL>/api/v2/asset/file`.

Without a store of your own, set `garage.enabled: true`: the chart runs a single-node Garage, as the Docker Compose bundle does, creates both buckets and a key pair, and fills `global.s3` for it. Browsers reach it on the web app's host, uploads at `/<bucket>` and images at `/<assets bucket>`; `garage.ingress.enabled: true` sets up both routes for ingress-nginx. With another ingress controller, route them yourself (see the chart's README). It is one node without replication: back up its data volume.

### Login {#auth}

Login is **off** by default (`global.auth.enabled: false`): every service then acts as one default user, so put such an installation behind your own access control. To switch login on, set `global.auth.enabled: true` and `global.auth.existingSecret` to a Secret with the keys `server-url`, `realm`, `client-id`, `client-secret` and `nextauth-secret`. One Secret serves all five services.

If other applications use the same realm, their tokens also pass GOAT's signature check. Set `global.auth.allowedClients` to the clients whose tokens GOAT accepts, for example `[goat-web]`, and core, geoapi, processes and catalog answer a token of any other client with `401`. The list must include GOAT's own client (`client-id` in the Secret): the web app signs users in with it, and the print worker and the services pass those tokens on. Without it core refuses to start. The list checks which client issued a token, not who the user is: if only some users may use GOAT, enforce that on GOAT's client for every flow it allows, or turn its *Direct access grants* off. See [A realm shared with other applications](./docker_compose/external_services.md#keycloak-shared-realm).

### Email and invitations {#email}

- **`email`** sets the SMTP server core sends invitations through, with the password from a Secret (`email.existingSecret`). The links in these emails are built from the public web and API URLs.
- **Keycloak** sends its own emails, such as password resets, with the SMTP settings of its realm. Configure the same server there.
- **`global.auth.provisionInvitedUsers: true`** lets an invitation create the Keycloak account, and Keycloak emails a link to set the password. Use it when your realm has self-registration off. Core's Keycloak client then needs the realm-management roles `view-users` and `manage-users`.
- **`global.auth.allowOrganizationCreation: false`** lets only accounts with the Keycloak realm role `superuser` create organizations; everyone else sees <code>Waiting for an invitation</code> until they are invited. This keeps people who sign in before their invitation from setting up an organization of their own, after which they could no longer be invited. Set up your organization, or give an account that role, before switching it off. A superuser can delete an organization that has at most one member and nothing in it with `DELETE /api/v2/organizations/{organization_id}/permanent`, so that its member can be invited; with Stripe billing on, cancel the Stripe customer named in the answer's `stripe_id` in Stripe.
- **`global.caBundle`** names a ConfigMap or Secret with a company CA certificate, for an SMTP relay, a Keycloak or pages the print worker opens that use a certificate from a private CA. The chart mounts it into core, web and the `print`, `tools` and `workflows` workers.

### Support tickets {#support}

Optional and **off by default**. Support tickets hand problem reports from your users to an Odoo Helpdesk. The block `odoo` holds the connection (`odoo.url`, `odoo.db`), `odoo.support` the Helpdesk team (`odoo.support.teamId`) and the API key from a Secret (`odoo.support.existingSecret`). Tickets are on only when all of these are set. The key is issued by Plan4Better for its own Odoo, so leave the block empty on your own installation unless you have received one.

Without tickets, *Report a problem* opens an email to the address in `web.supportEmail`, which is also named in the message shown when support is temporarily unavailable. It defaults to `support@plan4better.de`; set your own address for a white-label installation.

Ticket messages can carry attachments of up to 55 MiB in one request. The Ingress in front of core must accept bodies of at least 56 MB on `/api/v2/support` and allow generous read timeouts. ingress-nginx limits bodies to 1 MB by default; raise it with `nginx.ingress.kubernetes.io/proxy-body-size: "56m"` and `proxy-read-timeout` in `core.ingress.annotations`.

### OpenStreetMap and Overture Maps {#open-data-mirror}

Optional. The OpenStreetMap and Overture Maps panes under *Add layer › Connect service* read from a mirror of both datasets that a separate pipeline publishes in the catalog bucket, under `mirror/osm` and `mirror/overture`; it is not part of the chart. The chart hands `catalog.s3` to processes and the `tools`, `workflows` and `print` workers, so nothing else needs setting. Without `catalog.s3.bucket`, the two panes find no data; see [OpenStreetMap and Overture Maps](./docker_compose/external_services.md#open-data-mirror).

### Analysis workers {#workers}

The default Windmill worker only handles small jobs. **Analysis tools, dataset imports and workflows need the `tools` and `workflows` workers, and PDF printing needs the `print` worker.** All three are off by default. To use them:

- Enable them with `windmill.workers.tools.enabled`, `windmill.workers.workflows.enabled` and `windmill.workers.print.enabled`.
- The `tools` and `workflows` workers are pinned to nodes labelled `node.kubernetes.io/server-usage: geodata` with the toleration `geodata=true:NoSchedule`. Prepare such nodes, or override `nodeSelector` and `tolerations` for these workers. Otherwise their pods stay `Pending` and `helm install --wait` times out.
- The chart gives these workers what GOAT's jobs need: the GOAT database, the S3 store, the catalog bucket (which also holds the OpenStreetMap and Overture mirror), the address of the web app for printing and, with login on, the Keycloak client the print worker signs in with. Windmill passes only the variables listed in `WHITELIST_ENVS` on to the jobs; the chart builds that list, including every variable you add to a worker's `config` or `extraEnv`.
- Enable `windmill.scriptSync.enabled` to register GOAT's analysis tools and tasks in Windmill after the install. It is off by default.
- Each Windmill container holds at most a few connections to its database: the server 10 and every worker 3 (`windmill.server.config.DATABASE_CONNECTIONS`, `windmill.workers.databaseConnections`). Upgrading to a GOAT release with a newer Windmill migrates the Windmill database on start, one way: back it up first.

### Storage for several nodes {#rwx}

The shared data volume defaults to `ReadWriteOnce`, which works on a single node. On a cluster with several nodes, set `data.accessMode: ReadWriteMany` with an RWX-capable storage class (`data.storageClassName`), or supply your own claim with `data.existingClaim`.

geoapi, processes and the Windmill workers all write to this volume, and a fresh RWX volume belongs to root, so they run as root. If your cluster does not allow that, see the chart README ("The shared data volume").

## Further reading {#further-reading}

The [chart README](https://github.com/plan4better/goat/tree/main/deploy/helm/goat) covers the details: bootstrapping a fresh cluster, the external PostgreSQL setup, authentication precedence, the shared data volume, the region new projects open in (`DEFAULT_PROJECT_VIEW_STATE`), schema migrations and the upgrade notes between chart versions.
