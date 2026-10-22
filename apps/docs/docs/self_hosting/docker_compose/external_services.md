---
sidebar_position: 3
sidebar_label: External services
description: "Replace the bundled Garage and Keycloak with your own S3 storage and Keycloak, connect an SMTP server for email, and switch on optional integrations in .env."
---

# External services

Out of the box, the bundle runs everything itself. You can replace the bundled object storage and the bundled login server with your own, connect an email server, and switch on optional integrations. All of this is configured in `.env`; apply every change with:

```bash
docker compose up -d
```

The bundled components are chosen with `COMPOSE_PROFILES`:

| Profile | Component |
|---|---|
| `garage` | Bundled S3 object storage. Remove it to use your own S3. |
| `keycloak` | Bundled login server. Remove it to use your own Keycloak. |
| `backup` | Nightly backups (see [Backups](./operations.md#backups)). |

The default is `COMPOSE_PROFILES=garage,keycloak`.

## Your own S3 storage {#s3}

GOAT stores uploaded files in an S3 bucket, and avatars and images in a second, publicly readable bucket. Any S3-compatible storage works.

:::tip Decide before the first start
Set up your own storage before you start GOAT for the first time. Data already in the bundled Garage is not moved to your storage.
:::

### 1. Prepare the buckets {#s3-buckets}

- **Uploads bucket** (`S3_BUCKET_NAME`, default `goat-uploads`). Browsers upload files straight to this bucket, so its CORS rules must allow `PUT` with a `Content-Type` header from the GOAT URL. The bundled Garage uses this rule, which you can adapt:

  ```json
  [
    {
      "AllowedOrigins": ["https://goat.example.org"],
      "AllowedMethods": ["GET", "HEAD", "PUT"],
      "AllowedHeaders": ["*"],
      "ExposeHeaders": ["ETag"],
      "MaxAgeSeconds": 3600
    }
  ]
  ```

- **Assets bucket** (`ASSETS_BUCKET_NAME`, default `goat-assets`) for avatars and images. It must be readable without credentials at the address you set as `ASSETS_URL`. If your storage allows no publicly readable bucket, skip it: set `ASSETS_SERVED_BY_CORE=true` and `ASSETS_URL=<GOAT_PUBLIC_URL>/api/v2/asset/file`. GOAT then keeps the images in the uploads bucket under `assets/` and serves them itself.

Both buckets are accessed with the same access key.

### 2. Configure `.env` {#s3-env}

Remove `garage` from `COMPOSE_PROFILES`, then set:

| Setting | Meaning |
|---|---|
| `S3_ENDPOINT_URL` | The S3 endpoint as the server reaches it, e.g. `https://s3.example.org` |
| `S3_PUBLIC_ENDPOINT_URL` | The S3 endpoint as browsers reach it; upload links point here |
| `S3_REGION` | The region, e.g. `eu-central-1` |
| `S3_BUCKET_NAME` | The uploads bucket |
| `S3_FORCE_PATH_STYLE` | `true` for path-style addresses (`endpoint/bucket/key`), `false` for virtual-hosted style (`bucket.endpoint/key`) |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Your access key. Replace the values that `setup.sh` generated for Garage. |
| `ASSETS_S3_ENDPOINT_URL` | Endpoint of the assets bucket; defaults to `S3_ENDPOINT_URL` |
| `ASSETS_BUCKET_NAME` | The assets bucket |
| `ASSETS_URL` | Public address of the assets bucket, e.g. `https://assets.example.org` |
| `ASSETS_SERVED_BY_CORE` | `true` keeps the images in the uploads bucket and lets GOAT serve them, for storage without a public bucket |

`GARAGE_RPC_SECRET` and `GARAGE_ADMIN_TOKEN` are not used without the bundled Garage.

## Your own Keycloak {#keycloak}

GOAT can use a Keycloak you already run instead of the bundled one.

### Client requirements {#keycloak-client}

Create a client for GOAT in your realm with these settings:

| Setting | Value |
|---|---|
| Client type | Confidential (client authentication on), with the standard flow enabled |
| Valid redirect URIs | `<GOAT URL>/*`, e.g. `https://goat.example.org/*` |
| Web origins | `<GOAT URL>` |
| Service account | Enabled, with the `realm-management` roles **`view-users`** and **`manage-users`** |

GOAT uses the service account to read user accounts, to keep a user's name and email in Keycloak in step with their GOAT profile, and to delete an account when its user deletes it in GOAT.

### Configure `.env` {#keycloak-env}

Remove `keycloak` from `COMPOSE_PROFILES`, then set:

| Setting | Meaning |
|---|---|
| `KEYCLOAK_PUBLIC_URL` | Keycloak as browsers reach it, e.g. `https://login.example.org` |
| `KEYCLOAK_INTERNAL_URL` | Keycloak as the GOAT containers reach it; often the same URL |
| `REALM_NAME` | Your realm |
| `KEYCLOAK_CLIENT_ID` | The client ID |
| `KEYCLOAK_CLIENT_SECRET` | The client secret. Replace the value that `setup.sh` generated. |

Both URLs include Keycloak's relative path if yours uses one, such as `/auth`: `https://login.example.org/auth`.

:::info The first administrator and smoke.sh
With your own Keycloak, GOAT creates no user there. `smoke.sh` signs in with `GOAT_ADMIN_EMAIL` and `GOAT_ADMIN_PASSWORD` through a direct password login. To use it, set both to an existing user of your realm and enable *Direct access grants* on the client.
:::

If your Keycloak uses a certificate from a private CA, see [Company CA](./https.md#company-ca).

### A realm shared with other applications {#keycloak-shared-realm}

Every client of a realm can get a token signed with the realm's key, and by default GOAT's APIs accept such a token even when Keycloak issued it to another application. A rule that lets only some users sign in to GOAT, such as a group check on GOAT's client, then guards the login page but not the APIs.

Set `AUTH_ALLOWED_CLIENTS` to the clients whose tokens GOAT accepts, comma-separated:

```bash
AUTH_ALLOWED_CLIENTS=goat
```

GOAT then checks each token's `azp` claim, the client Keycloak issued it to, and answers a token of any other client with `401`. The list must include `KEYCLOAK_CLIENT_ID`: the web app signs users in with that client, and the print worker and GOAT's services pass those tokens on. Without it nobody could use GOAT, so the `core` container refuses to start and names both settings. Add any other client whose tokens should reach GOAT's APIs, such as one your own scripts sign in with. The check needs no change to the realm. Apply it with `docker compose up -d`.

:::warning What the check does not cover
The check is about the application a token was issued to, not about the user.

- If only some users may use GOAT, for example the members of a group, enforce that on GOAT's client for every way it issues tokens: the browser login and, if enabled, *Direct access grants* (a direct password login, which Keycloak runs through its own flow). Otherwise turn *Direct access grants* off on the client. A user outside the group could else get a token of GOAT's client through the grant your rule does not cover, and GOAT's APIs would accept it. `smoke.sh` needs *Direct access grants* (see above).
- The web app keeps users signed in with a refresh token, so a user removed from that group stays signed in until the session ends. To end it at once, sign the user out in Keycloak, including the user's offline sessions.
:::

## Email {#email}

GOAT sends invitations, and Keycloak sends password resets, through **one SMTP server**. Email is off while `SMTP_HOST` is empty.

| Setting | Meaning |
|---|---|
| `SMTP_HOST`, `SMTP_PORT` | The mail server, e.g. `smtp.example.org` and `587` |
| `SMTP_SECURITY` | `starttls` (usually port 587), `ssl` (usually port 465) or `none` (e.g. an internal relay on port 25) |
| `SMTP_USER`, `SMTP_PASSWORD` | The login. Leave both empty for a relay that accepts mail without one. |
| `SMTP_FROM` | Sender address. Defaults to `SMTP_USER`, so it is required for a relay without login. |
| `EMAILS_FROM_NAME` | Sender name, default `GOAT` |

For example, a relay inside your network:

```bash
SMTP_HOST=mail.internal.example.org
SMTP_PORT=25
SMTP_SECURITY=none
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM=goat@example.org
```

After changing `SMTP_SECURITY`, run `./setup.sh` once: it derives the two flags `SMTP_STARTTLS` and `SMTP_SSL` that Keycloak needs. Then apply the change with `docker compose up -d`.

With `starttls` or `ssl`, GOAT and Keycloak check the relay's certificate against the public certificate authorities. If your relay's certificate comes from a company CA, set `GOAT_CA_BUNDLE` as described under [Company CA](./https.md#company-ca); otherwise sending fails with a certificate error.

:::info One place for the email settings
The bundled Keycloak uses the same SMTP settings: on every `docker compose up -d`, the step `keycloak-sync` copies them from `.env` into the realm. Change them in `.env` only; changes made in the Keycloak admin console under *Realm settings → Email* are replaced on the next start.
:::

### Email branding {#email-branding}

By default, the emails from GOAT and from Keycloak show the name `GOAT` and no footer links. These optional settings add your own, in both:

| Setting | Meaning |
|---|---|
| `EMAIL_BRAND_NAME` | Name shown in the emails |
| `EMAIL_LOGO_URL` | Address of a logo image, shown instead of the name |
| `EMAIL_CONTACT_URL` | Contact link in the footer. The app uses it too, for its <code>Contact us</code> links. |
| `EMAIL_PRIVACY_URL` | Privacy policy link in the footer. The login page links to it too. |

The images in the emails come from GOAT's public URL (`<public URL>/assets`), or from `STATIC_ASSETS_URL` if you set it. Recipients' mail clients load them from there, so the address must be reachable for them.

## Support tickets {#support}

GOAT can hand problem reports and questions from its users to an Odoo Helpdesk, where they appear as tickets with replies. This is optional and **off by default**. Without it, *Report a problem* in the app shows an email address and the *Documentation* link, and the routes under `/api/v2/support` answer 404, except `/api/v2/support/summary`, which tells the app that support is off. The address defaults to `support@plan4better.de`; set your own with `NEXT_PUBLIC_SUPPORT_EMAIL`, see the [configuration reference](./configuration.md#integrations).

| Setting | Meaning |
|---|---|
| `ODOO_URL` | Address of the Odoo, e.g. `https://odoo.example.org`. Shared by GOAT's Odoo integrations. |
| `ODOO_DB` | The Odoo database. Shared by GOAT's Odoo integrations. |
| `ODOO_SUPPORT_API_KEY` | API key of the support user in that Odoo. This is a secret. |
| `ODOO_SUPPORT_TEAM_ID` | Numeric ID of the Helpdesk team that receives the tickets |
| `ODOO_SUPPORT_POST_ACTION` | Optional. Name of the Odoo server action that posts a message as the ticket participant. Default `GOAT: post message as ticket participant`. |

Support tickets are on only when the first four settings are all set; with any of them empty, they stay off. The API key is issued by Plan4Better for its own Odoo. Leave all four empty on your own installation unless you have received one.

Ticket messages can carry attachments of up to 55 MiB in one request. The bundled Caddy sets no limit on request bodies. If you put your own proxy or load balancer in front, it must accept bodies of at least 56 MB on `/api/v2/support` and allow generous read timeouts there.

## Login off {#no-login}

For local tests and demos, GOAT can run without any login:

```bash
AUTH=False
```

Everybody who opens GOAT then acts as one built-in administrator.

:::warning
With `AUTH=False`, anyone who can reach the URL has full access to all data. Use it only for local or demo installations.
:::

## Optional integrations {#integrations}

GOAT works without any of these. Each one switches on a feature that needs an outside service.

| Setting | What it enables | Without it |
|---|---|---|
| `NEXT_PUBLIC_MAPTILER_KEY` | The satellite/hybrid basemap from MapTiler | That basemap is hidden; the other basemaps work |
| `NEXT_PUBLIC_MAPBOX_TOKEN` | Place search in the map's search box (Mapbox) | The search box finds no places |
| `CATALOG_S3_BUCKET`, `CATALOG_S3_ENDPOINT_URL`, `CATALOG_S3_ACCESS_KEY_ID`, `CATALOG_S3_SECRET_ACCESS_KEY`, `CATALOG_S3_REGION` | The GOAT data catalog: a read-only bucket with the harmonised datasets, mirrored on a schedule. It also holds the OpenStreetMap and Overture Maps mirror ([details](#open-data-mirror)) | The catalog stays empty, its sync is switched off, and the OpenStreetMap and Overture Maps panes find no data |
| `GEOCODING_URL`, `GEOCODING_AUTHORIZATION` | The geocoding service used by analysis tools | Analysis steps that need geocoding cannot run |
| `OTEL_ENABLED`, `OTEL_EXPORTER_OTLP_ENDPOINT` | Export of traces, metrics and logs to your OpenTelemetry collector | Nothing is exported |

Links shown in the app and the source of the product artwork are listed in the [configuration reference](./configuration.md#integrations). The source of the routing base data is described under [Routing base data](./operations.md#base-data).

### OpenStreetMap and Overture Maps {#open-data-mirror}

The OpenStreetMap and Overture Maps panes under *Add layer › Connect service* copy the features of an area into a GOAT layer. They read from a mirror of both datasets, stored as GeoParquet in the catalog bucket (`CATALOG_S3_*`) under `mirror/osm` and `mirror/overture`. The mirror is not part of a GOAT installation; it is published there by a separate pipeline, next to the catalog. Two parts of GOAT read it: `processes` fills the attribute and value lists in the dialog, and the Windmill `tools` worker runs the copy. Nothing else needs setting: without a catalog bucket, the two panes find no data.

The licence is recorded on each new layer: ODbL 1.0 for OpenStreetMap, CDLA-Permissive 2.0 for Overture places and ODbL 1.0 for the other Overture types.
