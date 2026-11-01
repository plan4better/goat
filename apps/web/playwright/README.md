# End-to-end tests

Playwright specs that drive the real app in a browser: content management,
project creation, the dataset picker, templates, workflows, Home. The config
is `playwright.config.ts` at the repo root.

## Where they run

- **CI:** `.github/workflows/e2e.yml`, on every PR that changes the app, a
  service or the suite, on every push to `main`, and on demand ("Run
  workflow" in the Actions tab). It starts Postgres and Redis from
  the root `compose.yaml`, Garage for S3, core, geoapi, processes and catalog
  from source, and a production build of the web app, all with `AUTH=False`. A
  failed run uploads the Playwright report and every service's log as the
  `e2e-report` artifact. It is not a required check yet.
- **Locally:** against a running app on port 3000, for example
  `pnpm exec playwright test --config=playwright.config.ts` from the repo
  root (pass the config explicitly when running from a worktree).

## What the specs assume

- `AUTH=False`: every request is the built-in default user (first name
  "GOAT"), so nothing logs in.
- Two datasets owned by that user, one of them a feature layer. A fresh
  database gets them from `python -m core.scripts.seed_e2e` (in `apps/core`,
  after `initial_data`); the CI stack does not run Windmill, so they cannot be
  created through the app.
- The specs create what else they need (projects, folders, the shared team
  "Design QA") and remove it again, except the team, which stays on purpose.

## Workflows that route

`workflows/workflow-chains.e2e.ts` runs workflows with routing steps through
processes and Windmill, on datasets it uploads (the assistant eval's workflow
project, in Leipzig). It needs Leipzig's street network in the stack's data
directory, and the public transport data for its public transport test, and
runs only where `E2E_BASE_DATA` (and `E2E_PUBLIC_TRANSPORT`) say they are
there; elsewhere, the E2E workflow included, it is skipped. CI runs it in its
own workflow (`.github/workflows/workflow-chains.yml`), which installs the
data with goatlib's `sync_base_data` and caches it by version: the street
network on every run, public transport on main and nightly only. Workflows
without routing are covered faster by goatlib's workflow chain tests. The spec
takes its walk and public transport workflows from the routing cases of the
assistant's regression set (`apps/assistant/evals/workflow_runs.json`) and
checks them by what each contains; its heatmap is written in the spec.

That workflow runs this checkout's goatlib on the newest release's worker
image, with the router built into it: a PR that changes the C++ router
(`packages/cpp/routing`) together with goatlib fails there until a release
publishes the worker image with that router.

## The assistant

`assistant/catalog-proposal.e2e.ts` needs the assistant service answering
with a fake model (`apps/assistant/e2e/fake_openai.py`), which gives the same
answer on every run. `apps/assistant/e2e/run.sh` starts both and sets
`E2E_ASSISTANT`; elsewhere, the E2E workflow included (it starts no
assistant, so no page offers "Ask AI"), the spec is skipped.
