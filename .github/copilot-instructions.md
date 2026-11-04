This is a Monorepo repository for our GOAT project with a FastAPI/Python backend and a React/NextJS/TypeScript frontend.
Please follow these guidelines when contributing:

## Code Standards

- Run `sh ./scripts/lint-web` before committing any changes to ensure proper code formatting for the frontend projects/libraries
- Run `sh ./scripts/lint-python` before committing any changes to ensure proper code formatting for the FastAPI/Python backend

## Repository Structure

- `.devcontainer/`: Contains configuration for development containers
- `.github/`: GitHub-specific files, including workflows and issue templates
- `.husky/`: Husky hooks for managing Git hooks
- `.vscode/`: VSCode-specific settings and configurations
- `apps/`: Contains the main applications for the project
  - `core/`: The main FastAPI/Python backend application for user management, projects, folders, and content metadata. Does NOT handle file uploads, layer data processing, or analytics tools.
  - `docs/`: Documentation for the project using Docusaurus.
  - `geoapi/`: FastAPI/Python API service implementing OGC API standards. Handles:
    - Layer file uploads and imports (via `/upload` endpoints)
    - Serving geospatial data to the frontend (OGC API Features)
    - Triggering analytics tools via OGC API Processes (jobs run in Windmill)
    - DuckLake data management for user layer data
  - `catalog/`: FastAPI/Python STAC API service for the GOAT data catalog. Database-less: serves a local parquet mirror (`${DATA_DIR}/catalog/`) via DuckDB.
  - `assistant/`: FastAPI/Python service for the AI assistant (conversations, agent runs, tools); hosts the MCP endpoint at `/mcp`.
  - `routing/`: FastAPI/Python API service for routing/navigation services.
  - `storybook/`: React/NextJS/TypeScript application for UI component development and testing.
  - `web/`: The main frontend application built with React/NextJS/TypeScript.
  - `processes/workers/`: Docker configuration for Windmill workers that execute analytics tools.
- `packages/`: Contains shared libraries and components used across the applications.
  - `js/`: Shared JavaScript/TypeScript libraries for frontend applications.
    - `eslint-config-p4b/`: Shared ESLint configuration.
    - `keycloak-theme/`: Shared Keycloak theme for authentication interfaces.
    - `prettier-config/`: Shared Prettier configuration.
    - `tsconfig/`: Shared TypeScript configuration.
    - `types/`: Shared TypeScript types.
    - `ui/`: Shared UI components and libraries.
  - `python/`: Shared Python libraries for backend applications.
    - `goatlib/`: Core Python library containing:
      - `tools/`: All analytics tools (buffer, catchment_area, heatmap, etc.) that run as Windmill jobs
      - `analysis/`: Analysis algorithms and utilities
      - `io/`: Data I/O utilities (DuckLake, file handling)
      - `models/`: Shared Pydantic models
      - `services/`: Shared service classes
- `scripts/`: Various scripts for development, testing, and deployment tasks.

## Creating New Analytics Tools

All analytics tools must be created first in `packages/python/goatlib/src/goatlib/tools/`. The tool definitions in goatlib are then automatically exposed via the Processes API (`apps/processes`), which provides the OGC API Processes interface. Tools run as background jobs in Windmill.

### Tool Structure

1. **Create the tool class** in `goatlib/tools/your_tool.py`:
   - Inherit from `BaseToolRunner[YourToolParams]`
   - Define input parameters as a Pydantic model extending `ToolInputBase`
   - Implement the `process()` method with your analysis logic
   - Set `tool_class`, `output_geometry_type`, and `default_output_name`

2. **Register the tool** in `goatlib/tools/registry.py`

3. **Sync to Windmill** using `goatlib/tools/sync_windmill.py`

## Key Guidelines

1. Follow Python best practices and idiomatic patterns
2. Maintain existing code structure and organization
3. Document public APIs and complex logic. Suggest changes to the `apps/docs/` folder when appropriate
4. Analytics/processing logic belongs in `goatlib`
5. Layer data is stored in DuckLake (managed by `geoapi`), metadata in PostgreSQL (managed by `core`)
