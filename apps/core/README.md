# GOAT Core API

The main backend: who may do what, and the metadata of everything a user works with.

## Overview

Core owns the Postgres schema (`customer` by default) and serves it under `/api/v2`:

- **People and organizations**: users, organizations, teams, members and invitations, custom domains, organization analytics. A user belongs to one organization. `DELETE /organizations/{id}` only suspends one; `DELETE /organizations/{id}/permanent` (superusers) removes an organization that has at most one member and nothing in it, so that member can be invited elsewhere (`crud_organization.delete_permanently` lists what counts). Its Stripe customer stays in Stripe until someone cancels it there; the Stripe webhook sends no trial email to a customer no organization is billed under (at signup the customer exists a moment before its organization, so other events still do their Stripe-side work).
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
- **A template's datasets reach its users in one of three ways** (`TemplateInput.mode`, `src/core/schemas/template.py`). *Ship* links the author's layer into every project made from the template: read-only for the user unless it is also shared with them as editor. *Ask* (workflow templates) leaves a slot the user fills on use. *Copy* gives every user their own editable layer: `POST /template/{id}/use` links the author's layer like *ship*, then starts one `layer_copy` job per copied dataset through processes (`crud_template._start_copy_jobs`) and returns the job ids in `copy_jobs`. The job keeps the project entry and points it at the copy, so dashboards, layouts, filters and workflow nodes, which all name the entry, follow; until it finishes, the entry shows the author's layer. Many saved workflow nodes name their layer without an entry, so a project copy gives such a node the entry when its layer has exactly one, and the job also repoints nodes by layer while no other entry of the project shows the source. The entry's `template_copy` stamp says where the copy stands (`pending`, `done`, `failed` with the reason); a later use of a workflow template in the same project binds to that entry again, and restarts its copy if it never arrived. A copy (with rows, or empty with the same columns) is made from the layer as it is at use time: a copy frozen when the template is saved is not built yet. Ship datasets, and copies with their rows, are readable by whoever may read the template, however it reached them (a grant on it, a folder shared above it, its space): rule 6c of `effective_role` reads the template's inputs live, so that read ends when the dataset leaves the template, the template stops reaching the user, or the author may no longer share the dataset (a dataset the author may only view never travels on). Saving checks the author may read them; a template grant or a team/organisation destination also grants viewer on them (T6), and those grants stay when the dataset leaves the template; publishing makes them public. An empty copy (`TemplateInput.empty_copy`) takes only the columns, field settings and style, so its dataset stays private: no grant, never made public; the job is started for whoever may read the template, and processes runs it only for a template that has that dataset as an empty copy.
- **A slim image.** Core installs goatlib's light base only: no GDAL, no geospatial stack. The data volume is not mounted except the read-only catalog mirror and the GeoIP database. Anything that needs the heavy stack (validating an upload, promoting a catalog item) runs as a job in a worker. `tests/unit/test_runs_without_the_geospatial_stack.py` guards this, after two production incidents.

## Authorization

A token counts only once it verifies: signed with the realm's key and, when `AUTH_ALLOWED_CLIENTS` is set, issued to one of those clients (goatlib's `KeycloakAuth`, see `packages/python/goatlib/README.md`). Every route that needs a login verifies it through `core.deps.auth.decode_token`, so a token of another application of the realm gets a 401 before either layer below runs.

Two layers, both in SQL:

1. **Route level.** `auth_z` calls the `authorization()` SQL function, which looks the request up in the seeded `customer.resource` table and applies the organization's quotas. **A new route needs a seeded pattern in `RESOURCES_PERMISSIONS` (`src/core/db/seed_roles.py`), or it answers 401 when auth is on.**
2. **Resource level.** `effective_role()` / `can()` (`src/core/core/authz.py`, `src/core/db/sql/functions/authz/effective_role.sql`) decide access to a layer, project, folder, bundle or template. Access can come from the space, a direct grant in `resource_grant`, an ancestor folder, a bundle, a shared project, a template that ships the layer or public read; the highest role wins. Grants stop at editor: only the resource itself makes someone its owner. A grant only reaches users, teams and the organization of the granter's own organization: every route that writes one calls `crud_share.assert_grantees_in_organization` before the row is written.

With `AUTH=False` both layers let everything through and every request runs as the built-in default user (`DEFAULT_USER_*` settings), who is seeded only in that mode.

## Gotchas

- **The engine runs in AUTOCOMMIT** (`src/core/db/session.py`). Every statement commits on its own and `rollback()` undoes nothing, so a multi-statement write can half-apply. Code that writes several rows validates everything first and orders its statements so a crash leaves an explainable state (see `crud_transfer.py`, `crud_share.py`). Where no order is safe, `session_manager.transaction()` gives a connection with a real transaction: the permanent organization delete takes the member out of the organization before deleting it (`user.organization_id` cascades, so the other order would delete the account), and a failure between the two must not leave an organization without its member.
- **Behind a connection pooler in transaction mode set `POSTGRES_TRANSACTION_POOLER`.** psycopg prepares a statement on the server once it ran a few times on a connection, and the next query may land on a server connection where it is missing or already taken; with the setting it prepares nothing (`engine_connect_args` in `src/core/db/session.py`, used by the migrations too). It needs the psycopg driver, the default.
- **Organization roles are not tied to an organization.** `user_role` holds only the user and the role, and a user belongs to one organization (`user.organization_id`). Accepting an invitation therefore refuses a user who already has an organization and replaces their organization roles with the invited one (`crud_role.remove_organization_roles`). Anything else that moves a user into or out of an organization must do the same (the permanent organization delete does), or an owner role carries over.
- **Migrations, unlike requests, run in one transaction** (`alembic/env.py`). Revisions 0003 and 0005 rely on that to swap tables and functions atomically.
- **Alembic starts from a squashed baseline.** `init` creates the tables from the models; functions, triggers, roles and seed data come from `src/core/scripts/initial_data.py`, which every deploy runs after `alembic upgrade head`. The numbered revisions are guarded (`alembic/helpers.py`), so they do nothing on a fresh database and still upgrade an older one.
- **A team or organization space contains what is shared into it.** `GET /content?view=space` at such a space's root lists the space's own items *and* the items other spaces granted to its team or organization, sorted and paged together (`crud_content.py`, `_space_view_sql`). Any surface that lists a space must use this one view, not combine views itself: the Content page and the dataset picker once disagreed exactly because the "shared into" part lived in the page.
- **`layer_serial_counter` is core's table but geoapi's data.** It holds the highest number each serial column ever handed out, so a deleted feature's number is never reused. Only geoapi writes it (under its per-layer advisory lock), plus two goatlib tools: the filtered-copy tool, which copies a source's rows to the copy, and `finalize_layer` when a workflow's "Save as dataset" adds rows to an existing dataset (under the same lock); the foreign key removes it when its layer is purged. Core never reads it.
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
- `AUTH_ALLOWED_CLIENTS`: empty accepts a token of every client of the realm; set, only tokens issued to the listed clients. Read the same way by geoapi, processes and catalog. A list without `KEYCLOAK_CLIENT_ID` would refuse every user, so core refuses to start with it (core is the only service that knows its client).
- `GOAT_PROCESSES_URL`: without it, bundle import answers 503, and a catalog dataset added to a project stays pending because its materialize job cannot start.
- `STRIPE_SECRET_KEY`: billing is active only when it is set; otherwise the `DEFAULT_PLAN_*` / `DEFAULT_QUOTA_*` values apply.
- `SMTP_HOST`: emails are sent only when it is set.
- `ODOO_URL`, `ODOO_DB` (shared by the Odoo integrations), `ODOO_SUPPORT_API_KEY`, `ODOO_SUPPORT_TEAM_ID`: support tickets are on only when all four are set. Otherwise `GET /api/v2/support/summary` answers `enabled: false`, which is how the web app learns that support is off, and every other `/api/v2/support` route answers 404.
- `ASSETS_SERVED_BY_CORE`: for a store without a publicly readable bucket. Uploaded images go to the data bucket under `assets/`, and the anonymous `GET /api/v2/asset/file/<key>` redirects to a short-lived signed URL; it signs keys under `assets/` only, never user uploads. `ASSETS_URL` then defaults to that route on `CLIENT_URL`'s host.
- `CUSTOM_DOMAIN_CNAME_TARGET`: empty turns custom domains off.
- `ALLOW_ORGANIZATION_CREATION` (default true): false lets only superusers create organizations, so nobody who signs in before their invitation sets up one of their own. The web app learns it from `GET /users/me/organization-creation` and shows a page that waits for an invitation instead of the setup form.
