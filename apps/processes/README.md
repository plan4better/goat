# GOAT Processes API

OGC API - Processes implementation for GOAT's geospatial analysis tools.

## Overview

This service implements [OGC API - Processes - Part 1: Core (OGC 18-062r2)](https://docs.ogc.org/is/18-062r2/18-062r2.html). It does four things:

- **Runs analytics tools asynchronously.** An execution request becomes a Windmill job (`f/goat/tools/<tool>`); the client polls `/jobs/{jobId}` for status and the result.
- **Answers short statistics queries synchronously** (feature counts, class breaks, unique values, histograms, layer search, SQL preview). These run in-process against DuckLake and return in the response.
- **Lists what the OpenStreetMap and Overture mirror holds** for an area (`mirror-values`: tags, attributes and their values for Add layer › Connect service). The one synchronous query that reads S3 instead of DuckLake: the mirror sits in the catalog bucket (`mirror/<osm|overture>/`), so processes needs `CATALOG_S3_*` like the workers. The layout it relies on is in the catalog README's harvester contract.
- **Runs and cleans up workflows.** The `/workflows` routes submit a whole workflow graph as one `workflow_runner` job, finalize its temporary results into layers, and read or delete the per-node temporary outputs.

The full, current route list is the OpenAPI document at `/api/docs`.

## Why a Separate Service?

It was split from geoapi so that long-running analysis can never block tile and feature requests. It scales and is resource-limited on its own, and a heavy query here cannot slow down map rendering.

## Where Things Are Defined

| What | Source of truth |
|------|-----------------|
| Async tools (names, categories, beta and hidden flags, worker tag) | `TOOL_REGISTRY` in `packages/python/goatlib/src/goatlib/tools/registry.py` |
| Sync analytics listed by `GET /processes` | `ANALYTICS_DEFINITIONS` in `src/processes/services/analytics_registry.py` |
| Which sync processes are callable without a token | `PUBLIC_ALLOWED_PROCESSES` in `src/processes/routers/processes.py` |
| Settings and their defaults | `src/processes/config.py` |

## Access Rules

- **Async tools always need a user.** The server sets `user_id` in the job inputs from the token, so a client cannot submit a job as someone else.
- **Jobs are private to their owner.** Status, results and dismiss compare the job's `user_id` with the caller and answer 404, not 403, for someone else's job.
- **Everything a request names is checked before it runs** (`src/processes/services/access.py`). Tools and analytics read with service credentials, so they never check the caller themselves. Every layer a request reads must be readable by the caller: in a published project, or allowed by `customer.can`. Every project and folder a tool writes to must be writable, and every bundle readable. A refusal answers 404, like a missing resource; a check that cannot run answers 503. The same rule covers `/workflows/{id}/execute` (dataset nodes and tool configs).
- **A tool's result goes into the folder of the project it runs in**, which belongs to the project's owner. Writing there is allowed to whoever may edit a project the same request names and that lives in that folder, so an editor of a shared project can run tools in it; any other folder needs the caller's own write access.
- **A workflow tool input that an edge feeds is not checked**: the runner replaces it with the upstream node's layer, so whatever id its saved config still holds is never read. The upstream dataset's layer is checked instead.
- **Which inputs name a layer** comes from each tool's schema (`widget="layer-selector"`), plus `EXTRA_LAYER_FIELDS` in `access.py`, plus every key shaped like a layer reference at any depth (`LAYER_KEY_RE`), because the workflow runner folds numbered handles (`input_layer_7_id`, `input_path_3`) and camelCase keys into tool inputs. `tests/test_access.py` fails when a tool gains a layer-shaped field that none of these covers.
- **A project entry a request names** (`layer_project_ids`, `opportunities[].layer_project_id`) is checked as a read of the layer it shows. `layer_copy`, which points entries at a copy, also refuses an entry that is not in the project it names, which is checked for write. An empty template copy (`copy_content` false with a `template_id`) is checked as a read of the template instead of its dataset and of the entries showing it, and runs only if that template has the dataset as an empty copy (`access.empty_copy_of_template`): the author's rows stay private.
- **A layer input must be a layer id** (checked) or a workflow temp-layer id (resolved in the caller's own temp directory). File locations (`*_path`, `*_url` and the like) are filled by the runner; a caller-supplied one is refused, except `wfs_url`. An `s3_key` must be exactly `<bucket path>/users/<caller>/imports/uploads/<file>`, the key core's upload endpoint hands out.
- **A workflow may only name registered tools.** A tool node with any other `processId` is refused before anything runs.
- **User SQL reads its declared inputs and nothing else.** `preview-sql`, `validate-sql`, the `custom_sql` tool and the workflow if node run on a connection with DuckLake attached, so goatlib's validators (`packages/python/goatlib/src/goatlib/utils/sql_validation.py`) allow only the declared aliases and the query's own CTEs, and refuse qualified tables, files, table functions and the file, settings and catalog functions. `preview-sql` resolves a temp-layer id only in the caller's own temp directory.
- **Some sync analytics are public**, so anonymous viewers of a published dashboard get their statistics, for layers of a published project only. `layer-search` and `preview-sql` are allowed anonymously only when scoped to a published project's own layers; `validate-sql` always needs a token.
- **Beta tools** are hidden from `GET /processes` unless the caller's email domain is listed in the Windmill variable named by `BETA_USER_EMAIL_DOMAINS_WM_PATH`.
- **A token must verify**, and with `AUTH_ALLOWED_CLIENTS` set it must be issued to one of those clients (goatlib's `KeycloakAuth`). core and geoapi start jobs here with the caller's own token, so no service account needs to be on the list.
- With `AUTH=False` every caller is the built-in development user and sees that user's jobs.

## Gotchas

- `preview-sql` and `validate-sql` can be executed but are not in `ANALYTICS_DEFINITIONS`, so `GET /processes` does not list them and `GET /processes/{id}` answers 404.
- `GET /jobs` inlines the full Windmill result of every successful job it returns, and fetches details for export, print and workflow jobs concurrently. Large results make this endpoint memory-heavy.
- `DELETE /jobs/{jobId}` cancels a queued or running job. For a finished job it only answers "dismissed"; nothing is deleted.
- Workflow variables pass through `/workflows/{id}/execute` unvalidated. The runner resolves `{{@name}}` by `name` alone (`variable_map` in `packages/python/goatlib/src/goatlib/tools/workflow_runner.py`); a variable's optional `label` and `description` are for the editor only and never change a run.
- Workflow temporary results live under the hardcoded `/app/data/temporary`, which processes reads directly. The processes container must share `/app/data` with the Windmill workers.
- `TRAVELTIME_MATRICES_DIR` is passed to jobs as a path, so it must be valid on the **worker's** filesystem, not on the processes container.
- `WINDMILL_TOKEN` is read from the process environment, then from the file named by `WINDMILL_TOKEN_FILE`, then from `/app/data/windmill/.token`. A `WINDMILL_TOKEN` line in a `.env` file is not picked up.
- Settings declared with an `os.getenv(...)` default (for example `WINDMILL_URL`, `PROCESSES_DUCKDB_MEMORY_LIMIT`) read that environment name only from the real environment, not from `.env`.
- The three DuckDB connections that query layers (analytics, SQL previews, layer search) get `PROCESSES_DUCKDB_MEMORY_LIMIT` each; the small ones for published-project lookups and SQL validation hold no layer data. The OpenStreetMap/Overture key and value lists (`mirror-values`) read only the mirror on S3, so they run on their own 256 MB database instead of queueing on the analytics lock. DuckDB spills only at its own budget, so keep three budgets well under the container's memory limit, or the pod is killed before DuckDB spills.
- When `POSTGRES_SERVER` is a pooler in transaction mode, set `POSTGRES_TRANSACTION_POOLER`: the query pool then caches no prepared statements, which a pooler with stock settings loses track of. DuckLake keeps its own, direct host (`DUCKLAKE_POSTGRES_SERVER`).
- The default `WINDMILL_URL` (`http://windmill-server:8000`) only resolves inside the compose network. A run on the host must point it at the published Windmill port.

## Development

The service needs Postgres (for the DuckLake catalog) and, with auth on, `KEYCLOAK_SERVER_URL`; it fails at startup otherwise. Load the repo's root `.env` and run it on port 8300, which is what the web app expects:

```bash
set -a && . ./.env && set +a          # from the repo root
cd apps/processes
uv run fastapi dev src/processes/main.py --port 8300

uv run pytest tests/                  # fully mocked, needs no services
ruff check .
```

## Docker

```bash
docker build -t goat-processes -f apps/processes/Dockerfile .   # from the repo root
```

The image runs `fastapi run` on port 8000 as a non-root user, with the DuckDB extensions baked in. It needs the same environment as a local run, plus the shared `/app/data` volume.

`apps/processes/workers/Dockerfile` builds the Windmill server and worker images (`server`, `worker-default`, `worker-tools`, `worker-print`) that execute the jobs this service submits.

`worker-print` renders layouts in Chromium, which uses only fonts installed in the image. The layout font picker offers fonts the image has no file of (Verdana, Garamond, Consolas), so open fonts stand in for them under their names (`workers/fonts/60-goat-print-fonts.conf`): Chromium takes a fontconfig font only when it carries the requested name, never through a plain alias. A font added to the picker needs one there too, or it prints in the generic fallback, as Georgia does (Liberation Serif); the release smoke test checks that each of the three resolves.
