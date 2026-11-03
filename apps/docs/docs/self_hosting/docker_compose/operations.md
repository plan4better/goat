---
sidebar_position: 5
sidebar_label: Operations
description: "Run GOAT with Docker Compose day to day: add users through Keycloak, reach Windmill, load routing base data, back up and restore, upgrade, and troubleshoot."
---

# Operations

This page covers the everyday tasks of running GOAT with Docker Compose: managing users, loading the routing base data, backups, upgrades and troubleshooting. Run all commands from the bundle folder.

## Users and the Keycloak admin console {#users}

User accounts live in Keycloak; organizations, teams and roles live in GOAT.

The Keycloak admin console is at `<GOAT URL>/keycloak/admin`. Sign in with the user `admin` and the password `KEYCLOAK_ADMIN_PASSWORD` from `.env`. GOAT's users are in the realm `goat` (`REALM_NAME`).

To add a user, invite them in GOAT: open <code>Settings</code> → <code>Organization</code> → <code>Members</code>, click <code>New Member</code>, enter the email address, choose the role and click <code>Send Invite</code>.

Self-registration is switched off in the bundled realm, so GOAT creates the login account for an address that does not have one yet:

- **With [email](./external_services.md#email) set up**, the invited person receives two emails: GOAT's invitation and a message from Keycloak with a link to set their password. After setting it they sign in, GOAT shows the invitation, and they click <code>Accept</code> to join the organization.
- **Without email**, the account is created but nobody is told. GOAT shows a warning after the invitation; set a password for the new user in the Keycloak admin console (realm `goat`, *Users*) and pass it on. On their first sign-in Keycloak asks them to choose their own.

Accounts can also be created directly in the admin console; the invitation then only adds the person to the organization. With your own Keycloak, GOAT creates the accounts there as well, provided its service account may manage users; set `KEYCLOAK_PROVISION_INVITED_USERS=false` to turn this off.

### Who sets up organizations {#organizations}

A user belongs to exactly one organization. Whoever signs in without an organization and without a pending invitation is asked to set one up, so a person who signs in before their invitation was sent ends up in an organization of their own and can no longer be invited.

To prevent this, set `ALLOW_ORGANIZATION_CREATION=false`. Only accounts with the Keycloak realm role `superuser` can then create organizations; everyone else sees the page <code>Waiting for an invitation</code> until an invitation arrives, which then opens by itself. The bundled realm gives no account that role, so set up your organization before you switch creation off, or create the realm role `superuser` in the admin console and assign it to your account.

If someone already set up an organization by mistake, a superuser can delete it permanently with `DELETE /api/v2/organizations/{organization_id}/permanent` (`GET /api/v2/organizations` lists all organizations with their ids). This works only while the organization has at most one member and nothing in it: no content in its space or in the member's personal space (trash included), no teams, no pending invitations, no custom domains and no analytics settings. Otherwise GOAT answers `409` and names what is left. The person keeps their account and can then be invited. An organization whose last member is gone can be deleted the same way. <code>Delete Organization</code> in the organization settings only suspends an organization.

Billing is not touched. With Stripe billing on, the organization's Stripe customer and its subscription stay in Stripe; the answer names the customer in `stripe_id`. Cancel that customer in Stripe. Until then, Stripe's events for it find no organization to change, and its former owner gets no email.

:::tip Restrict the admin console
List the networks that may open `/keycloak/admin` in `GOAT_ADMIN_ALLOW_CIDRS`, for example your office network. Requests from other addresses get `403`. The default allows every address.

```bash
GOAT_ADMIN_ALLOW_CIDRS=192.168.10.0/24 10.20.0.0/16
```
:::

## Windmill, the job engine {#windmill}

Windmill runs the analysis tools, dataset imports, PDF printing and scheduled tasks. Its interface is not published; it listens on `127.0.0.1` of the server only. Reach it through an SSH tunnel:

```bash
ssh -L 8110:127.0.0.1:8110 <server>
```

Then open `http://localhost:8110` and sign in as `admin@windmill.dev` with the password `WINDMILL_ADMIN_PASSWORD` from `.env`. The port is set by `WINDMILL_LOCAL_PORT`.

**Parallel analyses:** `GOAT_TOOLS_WORKERS` (default `2`) sets how many analysis jobs run at the same time. Each tools worker may use up to 4 GB of RAM, so size it to your server.

**Memory per service:** `compose.yaml` gives each service a memory limit. geoapi and processes also set DuckDB's memory budgets there (`GEOAPI_DUCKLAKE_POOL_SIZE`, `GEOAPI_DUCKDB_MEMORY_LIMIT`, `PROCESSES_DUCKDB_MEMORY_LIMIT`) so that they fit under it: DuckDB moves work to disk only when it reaches its own budget, and a service above its limit is stopped. To give a service more memory, raise its limit and its budgets together in a `compose.override.yaml`.

## Routing base data {#base-data}

Catchment areas, heatmaps and the public transport tools need a **street network** and **public transport data**. They are not downloaded automatically: the full set is tens of GB, so you choose the region you work in with a bounding box (`min_lon,min_lat,max_lon,max_lat`).

```bash
# Show what would be fetched, and how much
./base-data.sh --dry-run --bbox 11.3,48.0,11.8,48.3

# Download
./base-data.sh --bbox 11.3,48.0,11.8,48.3

# Download, and repeat this download every week
./base-data.sh --bbox 11.3,48.0,11.8,48.3 --weekly on
```

The download runs as a job in the running GOAT stack; `base-data.sh` follows it and prints its log until it finishes.

| Option | Meaning |
|---|---|
| `--bbox min_lon,min_lat,max_lon,max_lat` | Fetch only the area around this box. The street network is split into regional tiles; GOAT fetches the tiles covering the box plus a ring of neighbouring tiles. The public transport timetable is always fetched in full. |
| `--datasets a,b` | The data sets to fetch, separated by commas. Default: `street_network,public_transport`. Also available: `traveltime_matrices` (only for the legacy heatmaps), `nuts` and `geoip`. |
| `--dry-run` | Report what would be fetched, without writing anything |
| `--weekly on\|off` | Also repeat this run (with the same region and data sets) every week, on Tuesdays at 03:00 UTC, or stop repeating it |

The data comes from `GOAT_BASE_DATA_URL`, by default Plan4Better's public base data server. If your server has no access to it, point the setting at an internal mirror.

## Backups {#backups}

### Switch on nightly backups {#backup-setup}

Add `backup` to `COMPOSE_PROFILES` in `.env`, for example `COMPOSE_PROFILES=garage,keycloak,backup`, and run `docker compose up -d`.

Every night at `BACKUP_TIME` (UTC, default `02:30`), the backup service writes to `./backups/<timestamp>`:

- a dump of each database: `goat`, `keycloak` and `windmill`;
- an archive of GOAT's data volume (layer data, tiles, base data);
- with the bundled Garage, an archive of the object storage.

Backups older than `BACKUP_RETENTION_DAYS` (default `7`) are removed.

To make a backup right away:

```bash
docker compose run --rm backup --now
```

:::warning Copy backups off the server
Backups in `./backups` are on the same disk as GOAT. Copy the folder to another place with your usual tooling, for example `rclone` or `restic`. Keep a copy of `.env` with them: the restored databases and storage expect the passwords and keys it holds.
:::

If you use your own S3 storage, the files in it are not part of these backups; back them up with your storage provider's means.

### Restore a backup {#restore}

```bash
./restore.sh backups/<timestamp>
```

`restore.sh` asks you to type `restore` to confirm. It then stops GOAT, replaces **all current data** with the backup (databases and volumes), and starts GOAT again. Check the result with `./smoke.sh --quick`.

The same works on a new server: install the bundle of the same version, put the `.env` from your backup into its folder, and run `restore.sh` with the path to the backup folder.

The full cycle of backup, complete wipe and restore has been tested.

## The assistant's key {#assistant-key}

`ASSISTANT_SECRETS_KEY` in `.env` encrypts the model credentials organizations store. Back it up with `.env`: a restored database without it cannot use those connections, and organizations have to enter their keys again.

To replace the key, put a new one in front of the old one, separated by a comma, re-encrypt, then remove the old one:

```bash
new=$(openssl rand -base64 32 | tr '+/' '-_')
sed -i "s|^ASSISTANT_SECRETS_KEY=|ASSISTANT_SECRETS_KEY=$new,|" .env
docker compose up -d assistant
docker compose exec assistant python -m assistant.llm.vault rotate
# then edit .env so ASSISTANT_SECRETS_KEY holds only the new key, and:
docker compose up -d assistant
```

The assistant keeps its conversations in the `assistant` schema of GOAT's database, so the regular backup covers them. Starting an older GOAT version leaves the schema in place; only a database downgrade below the assistant's migrations (`alembic downgrade`) removes it, with its conversations and usage records.

## Upgrades {#upgrade}

1. Make a backup: `docker compose run --rm backup --now` (see [Backups](#backups)).
2. Download `goat-compose-<version>.tar.gz` of the new release and unpack it over your installation. Your `.env`, `certs/` and `backups/` are not part of the archive and stay as they are.
3. Run:

   ```bash
   tar xzf goat-compose-<version>.tar.gz --strip-components=1
   ./setup.sh             # switches GOAT_VERSION to the new release, adds new settings, keeps the rest
   docker compose pull
   docker compose up -d   # database migrations run automatically
   ./smoke.sh --quick
   ```

## Logs {#logs}

```bash
docker compose logs -f <service>    # e.g. core, web, geoapi, processes, assistant, keycloak, caddy
docker compose logs --tail 100 windmill-worker-tools
```

The logs of every service rotate automatically.

## Troubleshooting {#troubleshooting}

**Start with `./smoke.sh`.** It names the failing step and prints the logs of the service involved.

**Check the containers** with `docker compose ps -a`:

- Every one-time service (the names ending in `-init`, `-migrate`, `-bootstrap` and `-sync`) should show `Exited (0)`.
- Every other service should show `healthy` or `running`.

A one-time service with another exit code shows why in its logs, e.g. `docker compose logs core-migrate`.

**Let's Encrypt fails** (`auto` mode): check that port 443 reaches the server from the internet and that the DNS name resolves to it. Then look at `docker compose logs caddy`. See also [Automatic certificate](./https.md#auto).

**Catchment areas, heatmaps or public transport analyses fail:** the [routing base data](#base-data) for the area is probably missing.

**Emails do not arrive:** check the [email settings](./external_services.md#email) and the log of the last email attempt: `docker compose logs core` for GOAT's emails, `docker compose logs keycloak` for password emails. A certificate error there (`CERTIFICATE_VERIFY_FAILED`, `PKIX path building failed`) means the relay's certificate comes from a CA that GOAT does not trust yet; see [Company CA](./https.md#company-ca).

**The assistant does not show up:** no model is configured yet (see [AI assistant](./external_services.md#assistant)), or the service is not ready: `docker compose ps assistant` should show `healthy`, and `docker compose logs assistant` names a missing or invalid setting.
