---
sidebar_position: 1
sidebar_label: Installation
description: "Install GOAT on one Linux server with the Docker Compose bundle: requirements, download, setup.sh configuration, first start, smoke.sh checks and first login."
---

# Installation

The Docker Compose bundle runs a complete GOAT on **one Linux server**: the web app and its APIs, the login server (Keycloak), object storage (Garage), the database (PostgreSQL with PostGIS), the job engine (Windmill) and a proxy (Caddy) that handles HTTPS. An installation takes three commands:

```bash
./setup.sh && docker compose up -d && ./smoke.sh
```

This page walks you through them, from the requirements to your first login.

## Requirements {#requirements}

| | Minimum (trial) | Recommended |
|---|---|---|
| **CPU / RAM** | 4 vCPU / 8 GB | 8 vCPU / 16 GB |
| **Disk** | 50 GB | 200 GB or more (grows with your data) |
| **Operating system** | Any Linux with Docker Engine 24+ and Docker Compose 2.24+ | Ubuntu 24.04 LTS |

In addition, you need:

- **Open port 443**, plus port 80 for the redirect from `http://` to HTTPS, or the one port you choose for plain HTTP. Nothing else has to be reachable from outside.
- **A DNS name pointing at the server** if you want automatic HTTPS with Let's Encrypt.
- **Outgoing internet access** to pull the images from `ghcr.io`, and for the routing base data, the basemaps and the optional integrations.
- **`openssl`** for `setup.sh`, and **`curl` and `jq`** for `smoke.sh`.

The bundle does not install or upgrade Docker. Install it by following the [Docker documentation](https://docs.docker.com/engine/install/), on Ubuntu with [Docker's apt repository](https://docs.docker.com/engine/install/ubuntu/). The distribution's own `docker.io` package is often too old. `setup.sh` checks the Docker Engine and Compose versions before it writes anything, and `smoke.sh` checks for `curl` and `jq`; both stop with a message if something is missing or too old.

:::info
The GOAT images are public. You do not need to log in to a registry.
:::

## 1. Download the bundle {#download}

Every GOAT release publishes the bundle as `goat-compose-<version>.tar.gz` on its [GitHub release page](https://github.com/plan4better/goat/releases). The bundle is pinned to its release: it installs exactly that GOAT version.

```bash
curl -LO https://github.com/plan4better/goat/releases/download/<version>/goat-compose-<version>.tar.gz
tar xzf goat-compose-<version>.tar.gz
cd goat-compose
```

Replace `<version>` with the release tag you want to install. The folder contains:

| File | Purpose |
|---|---|
| `compose.yaml` | All services |
| `.env.example` | Every setting, with comments. `setup.sh` creates `.env` from it. |
| `setup.sh` | Writes and updates `.env` |
| `smoke.sh` | Checks the running installation end to end |
| `base-data.sh` | Downloads the routing and public transport base data |
| `restore.sh` | Restores a backup |
| `certs/` | Your own certificate and CA files, if you use any |
| `init/` | Configuration of the bundled services (proxy, database, login, storage, jobs) |

Run every command on this page from inside this folder.

## 2. Create the configuration {#setup}

`setup.sh` creates the file `.env`, which holds the whole configuration. Run it without options and it asks four questions:

```bash
./setup.sh
```

| Question | Default |
|---|---|
| **Public URL**: the address users type into the browser, such as `https://goat.example.org` or `http://10.0.0.5` | `http://localhost` |
| **TLS mode**: `auto`, `custom`, `internal` or `off` (see [HTTPS and addresses](./https.md)) | `off` for an `http://` URL, otherwise `auto` |
| **Email for Let's Encrypt notices** (only asked in `auto` mode, optional) | empty |
| **Email of the first GOAT administrator** | `admin@<your host>` |

`setup.sh` then generates random passwords and keys for every component, stores them in `.env` (readable only by your user), and prints the first administrator's login:

```text
Wrote .env for https://goat.example.org (TLS: auto).
First login: admin@example.org / <generated password>  (also stored in .env as GOAT_ADMIN_PASSWORD)
Next: docker compose up -d && ./smoke.sh
```

### Without questions {#non-interactive}

For scripted installs, pass the answers as options and add `--non-interactive`:

```bash
./setup.sh --public-url https://goat.example.org --tls auto \
  --acme-email ops@<your-domain> --admin-email admin@<your-domain> \
  --non-interactive
```

| Option | Meaning |
|---|---|
| `--public-url URL` | The public URL, with `http://` or `https://`, without a path |
| `--tls auto\|custom\|internal\|off` | The TLS mode |
| `--acme-email EMAIL` | Contact for Let's Encrypt expiry notices (`auto` only) |
| `--admin-email EMAIL` | Email of the first administrator |
| `--http-port PORT` | Port for plain HTTP when TLS ends at your own load balancer (see [Behind your own load balancer](./https.md#load-balancer)) |
| `--non-interactive` | Ask nothing; use the options and the values already in `.env` |
| `-h`, `--help` | Show the usage |

`setup.sh` stops with a clear message if something does not fit, for example:

- the URL has no `http://` or `https://`, or contains a path (it must be a bare origin such as `https://goat.example.org`);
- an `http://` URL is combined with a TLS mode other than `off`;
- `auto` mode is combined with a port in the URL (Let's Encrypt needs the standard ports);
- the Let's Encrypt email uses a domain that Let's Encrypt rejects (see [Automatic certificate](./https.md#auto));
- Docker Compose is older than 2.24.

### Running setup.sh again {#rerun}

You can run `setup.sh` as often as you like. It saves a copy of the current file as `.env.bak.<timestamp>`, keeps every value already in `.env`, adds settings that are new in `.env.example`, and generates secrets only where they are empty. The only values it rewrites are the ones it derives from the public URL and the TLS mode.

:::warning Keep `.env` safe
`.env` contains every password and key of your installation. Keep a copy with your backups: a restored database and storage expect exactly these values.
:::

## 3. Start GOAT {#start}

```bash
docker compose up -d
```

The first start takes a few minutes: Docker pulls the images, PostgreSQL creates the databases, Keycloak creates the login realm with the first administrator, and the analysis tools are registered in Windmill.

A few services only prepare the installation and then stop: `data-init`, `core-migrate`, `ducklake-init`, `garage-init`, `windmill-bootstrap` and `windmill-sync`. They run on every `docker compose up -d`, are safe to repeat, and apply database migrations after an upgrade. `docker compose ps -a` shows them as `Exited (0)` when they succeeded.

## 4. Check the installation {#smoke}

```bash
./smoke.sh
```

`smoke.sh` checks the whole installation step by step and prints `PASS` or `FAIL` for each step:

1. All one-time services finished successfully, and all long-running services are healthy. Services whose health check has not passed yet, right after `docker compose up -d`, get up to five minutes (`SMOKE_WAIT`, in seconds).
2. The web app, the Core API, GeoAPI, Processes, Catalog and the AI assistant answer under the public URL, and GeoAPI builds its links with the public URL. The MCP endpoint answers at `/assistant/mcp`, and the assistant can read every database table it needs.
3. Keycloak announces the public URL as its issuer, and the first administrator can log in.
4. The administrator belongs to an organization and has a profile.
5. A small GeoJSON file is uploaded, imported as a layer, served as a vector tile, and used in a buffer analysis.

`./smoke.sh --quick` runs steps 1 to 3 only. If a step fails, `smoke.sh` stops, names the step and prints the last log lines of the service involved.

:::info What smoke.sh changes
`smoke.sh` works with the account of the first administrator. It deletes the test datasets it imports again at the end, so nothing stays in <code>My Content</code>. If the administrator has no organization yet, it creates one named **GOAT**; to choose the name yourself, sign in first (step 5) and run `smoke.sh` afterwards, or rename it later under <code>Settings</code> → <code>Organization</code> → <code>Profile</code>. `./smoke.sh --quick` only checks the services and the login and changes nothing.
:::

## 5. Sign in {#first-login}

Open the public URL in your browser and sign in with the email and password that `setup.sh` printed. The password is also stored in `.env` as `GOAT_ADMIN_PASSWORD`.

If the administrator has no organization yet (because you signed in before running `smoke.sh`), GOAT first asks you to create one on the page **Setup a new organization**. It has three steps, <code>Name & Region</code>, <code>Profile</code> and <code>Contact</code>; click <code>Let's get started</code> to finish.

To add more users, see [Users and the Keycloak admin console](./operations.md#users).

## Where the services live {#urls}

All services share the one public URL and are told apart by the path:

| Path | Service |
|---|---|
| `/` | Web app |
| `/api` | Core API (`/api/v2/…`, health check at `/api/healthz`) |
| `/geoapi` | GeoAPI |
| `/processes` | Processes |
| `/catalog` | Catalog (STAC API at `/catalog/stac`) |
| `/assistant` | AI assistant (MCP endpoint for external agents at `/assistant/mcp`) |
| `/keycloak` | Login (Keycloak); admin console at `/keycloak/admin` |

With the bundled object storage, `/goat-uploads` and `/goat-assets` lead to Garage for uploads and public images.

Only Caddy is reachable from outside. PostgreSQL, Redis, the Garage admin interface and the Windmill interface are not exposed; see [Operations](./operations.md#windmill) for how to reach Windmill.

## Next steps {#next-steps}

- Download the [routing base data](./operations.md#base-data) for your region, so that catchment areas, heatmaps and the public transport tools work.
- Set up [email](./external_services.md#email), so that GOAT can send invitations and Keycloak can send password resets.
- Switch on [backups](./operations.md#backups).
