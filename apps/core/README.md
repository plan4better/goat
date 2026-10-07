# GOAT Core API

The main backend: who may do what, and the metadata of everything a user works with.

## Overview

Core owns the Postgres schema (`customer` by default) and serves it under `/api/v2`:

- **People and organizations**: users, organizations, teams, members and invitations, custom domains, organization analytics.
- **Content and access**: spaces, folders, the unified content feed, trash and transfer, favourites, sharing grants.
- **Projects**: projects and their layers, layer groups, workflows, report layouts, publishing.
- **Datasets**: layer and bundle metadata, upload URLs, templates, user assets.
- **Plans and billing**: plan lookup, quotas, the Stripe webhook.
- **Support tickets** (SaaS only): tickets in Plan4Better's Odoo Helpdesk, read and answered from GOAT (`src/core/support`). The Odoo side (the bridge user, its rights, the server action, the GOAT links in ticket emails) is the `goat_support` module in Plan4Better's Odoo.sh repository. The bridge reads no contacts, followers or ratings and posts nothing itself: all of that goes through the server action's operations, which check every input. Core and that module are released together. Who may see and do what in GOAT is decided by core alone (`service.py`); Odoo only sees the one bridge user.

The full, current route list is the OpenAPI document at `/api/docs`. The liveness check is `GET /api/healthz`.

## Why It Is Built This Way

- **Metadata in core, data elsewhere.** Core never reads layer features. Layer data lives in DuckLake and is served by geoapi; analytics run in processes. Core holds only the rows that describe a layer, project or bundle, plus who may see them.
- **Background work goes through processes, never straight to Windmill.** Core submits a job with `execute_process` (`src/core/services/processes.py`) and the caller's token, so processes applies the same ownership rules as for any user request.
- **Odoo through one client, one key per integration.** `src/core/odoo` is the only way core talks to Odoo: each integration builds its own client with its own allow-list of (model, method) calls and its own least-privilege key, and gets time limits, a concurrency cap and a circuit breaker, so a slow Odoo never ties up core. The conventions for adding an integration are in its module docstring.
- **Support tickets have no background job.** The header summary is built from lists cached per user for 60 s in the process; the lists a user opens are always read fresh from Odoo, because a write on one pod cannot drop another pod's cache (only the badge may lag there). Staff replies reach users by Odoo's email. Nothing polls Odoo while nobody is active, and no pod needs to coordinate with another.
- **A slim image.** Core installs goatlib's light base only: no GDAL, no geospatial stack. The data volume is not mounted except the read-only catalog mirror and the GeoIP database. Anything that needs the heavy stack (validating an upload, promoting a catalog item) runs as a job in a worker. `tests/unit/test_runs_without_the_geospatial_stack.py` guards this, after two production incidents.

## Authorization

Two layers, both in SQL:

1. **Route level.** `auth_z` calls the `authorization()` SQL function, which looks the request up in the seeded `customer.resource` table and applies the organization's quotas. **A new route needs a seeded pattern in `RESOURCES_PERMISSIONS` (`src/core/db/seed_roles.py`), or it answers 401 when auth is on.**
2. **Resource level.** `effective_role()` / `can()` (`src/core/core/authz.py`, `src/core/db/sql/functions/authz/effective_role.sql`) decide access to a layer, project, folder, bundle or template. Access can come from the space, a direct grant in `resource_grant`, an ancestor folder, a bundle, a shared project or public read; the highest role wins. Grants stop at editor: only the resource itself makes someone its owner.

With `AUTH=False` both layers let everything through and every request runs as the built-in default user (`DEFAULT_USER_*` settings), who is seeded only in that mode.

## Gotchas

- **The engine runs in AUTOCOMMIT** (`src/core/db/session.py`). Every statement commits on its own and `rollback()` undoes nothing, so a multi-statement write can half-apply. Code that writes several rows validates everything first and orders its statements so a crash leaves an explainable state (see `crud_transfer.py`, `crud_share.py`).
- **Migrations, unlike requests, run in one transaction** (`alembic/env.py`). Revisions 0003 and 0005 rely on that to swap tables and functions atomically.
- **Alembic starts from a squashed baseline.** `init` creates the tables from the models; functions, triggers, roles and seed data come from `src/core/scripts/initial_data.py`, which every deploy runs after `alembic upgrade head`. The numbered revisions are guarded (`alembic/helpers.py`), so they do nothing on a fresh database and still upgrade an older one.
- **A team or organization space contains what is shared into it.** `GET /content?view=space` at such a space's root lists the space's own items *and* the items other spaces granted to its team or organization, sorted and paged together (`crud_content.py`, `_space_view_sql`). Any surface that lists a space must use this one view, not combine views itself: the Content page and the dataset picker once disagreed exactly because the "shared into" part lived in the page.
- **SQL function files must not start with a comment** (`create_functions.py` rejects them) and are installed in dependency order.
- **Settings are case sensitive and have no prefix.** Core loads `apps/core/.env`, then `/app/.env` in containers. In a fresh checkout, link `apps/core/.env` to the root `.env` or export the variables first.

## Development

```bash
uv sync --all-packages                 # from the repo root
ln -s ../../.env apps/core/.env        # once per checkout
docker compose up -d                   # Postgres and the other infrastructure

cd apps/core
uv run alembic upgrade head && uv run python src/core/scripts/initial_data.py
uv run uvicorn core.main:app --reload --port 8000
```

Tests need a running PostgreSQL with PostGIS. Each test process creates its own schema, installs the functions and triggers into it, and forces `AUTH=False`:

```bash
cd apps/core && uv run pytest tests/ -n 4
```

## Configuration

All settings and their defaults are in `src/core/core/config.py`. The ones that change behaviour rather than just connect to something:

- `AUTH` (on unless set to false) and `KEYCLOAK_SERVER_URL`, which is required while auth is on.
- `GOAT_PROCESSES_URL`: without it, bundle import answers 503, and a catalog dataset added to a project stays pending because its materialize job cannot start.
- `STRIPE_SECRET_KEY`: billing is active only when it is set; otherwise the `DEFAULT_PLAN_*` / `DEFAULT_QUOTA_*` values apply.
- `SMTP_HOST`: emails are sent only when it is set.
- `ODOO_URL`, `ODOO_DB` (shared by the Odoo integrations), `ODOO_SUPPORT_API_KEY`, `ODOO_SUPPORT_TEAM_ID`: support tickets are on only when all four are set; otherwise `/api/v2/support` answers 404.
- `CUSTOM_DOMAIN_CNAME_TARGET`: empty turns custom domains off.
