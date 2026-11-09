---
applyTo: "**"
---

# Commit Message Convention

This repository uses [Conventional Commits](https://www.conventionalcommits.org/) enforced by commitlint (`@commitlint/config-conventional`).

## Format

```
type(scope): description
```

## Types

| Type       | When to use                                      |
| ---------- | ------------------------------------------------ |
| `feat`     | A new feature                                    |
| `fix`      | A bug fix                                        |
| `docs`     | Documentation only changes                       |
| `style`    | Formatting, missing semicolons, etc. (no logic)  |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `perf`     | Performance improvement                          |
| `test`     | Adding or updating tests                         |
| `build`    | Build system or external dependencies            |
| `ci`       | CI/CD configuration and scripts                  |
| `chore`    | Other changes that don't modify src or test files |
| `revert`   | Reverts a previous commit                        |

## Scopes

Use a scope to indicate which part of the monorepo is affected:

| Scope        | Package / App                                |
| ------------ | -------------------------------------------- |
| `web`        | `apps/web` — Next.js frontend                |
| `core`       | `apps/core` — Main FastAPI backend           |
| `geoapi`     | `apps/geoapi` — OGC API Features/Tiles service |
| `processes`  | `apps/processes` — OGC API Processes service |
| `catalog`    | `apps/catalog` — STAC API service for the data catalog |
| `routing`    | `apps/routing` — Routing service             |
| `goatlib`    | `packages/python/goatlib` — Shared Python library |
| `ui`         | `packages/js/ui` — Shared UI components      |
| `types`      | `packages/js/types` — Shared TypeScript types |
| `docs`       | `apps/docs` — Documentation site             |
| `docker`     | Docker/compose configuration                 |
| `ci`         | GitHub Actions workflows                     |

### Scope rules

- **Single app/package affected** — use that scope: `feat(web): add layer filter panel`
- **Multiple apps/packages affected** — omit the scope: `feat: add polygon support to tools and map`
- **Shared config or root-level changes** — omit the scope: `chore: update pnpm lockfile`
- **Tool added in goatlib + exposed via processes** — use `goatlib` since that's where the logic lives: `feat(goatlib): add buffer tool`

## Examples

```
feat(web): add report export as PDF
fix(core): handle null geometry in project duplication
refactor(geoapi): simplify tile caching logic
docs: update local development setup guide
feat(goatlib): add catchment area tool
fix(web): correct layer ordering in legend panel
ci: add Python 3.11 to test matrix
chore: bump dependencies
perf(geoapi): optimize feature query for large datasets
test(core): add integration tests for folder endpoints
feat: add heatmap support across frontend and backend
```

## Additional rules

- Use the **imperative mood** in the description ("add", not "added" or "adds")
- Do **not** capitalize the first letter of the description
- Do **not** end the description with a period
- Keep the subject line under 100 characters
- Use the body (separated by a blank line) for additional context when needed
- Reference issue numbers in the body or footer: `Closes #123`
