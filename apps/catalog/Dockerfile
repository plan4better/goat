# ==== STAGE 1: General debian environment ====
FROM debian:bookworm-slim AS linux-base

LABEL org.opencontainers.image.source=https://github.com/plan4better/goat
LABEL org.opencontainers.image.description="Goat Catalog API"
LABEL org.opencontainers.image.licenses="GPL-3.0"

ARG PYTHON_VERSION=3.11


ENV LC_CTYPE=C.utf8 \
    UV_PROJECT_ENVIRONMENT="/venv" \
    UV_COMPILE_BYTECODE=1 \
    UV_PYTHON_INSTALL_DIR="/python" \
    UV_PYTHON=python$PYTHON_VERSION

ENV PATH="$UV_PROJECT_ENVIRONMENT/bin:$PATH"

# ca-certificates is what OpenSSL's default verify paths read: the build
# stage needs it to download the DuckDB extensions, the runtime for any HTTPS
# the service makes. Installed in the shared base so both stages have it.
RUN apt-get update && apt-get upgrade -y \
    && apt-get install --no-install-recommends -y tzdata ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ===== STAGE 2: Python environment ====
# catalog needs no GDAL/routing and no build toolchain -- it only reads the
# pre-built catalog.parquet/nuts.parquet files via DuckDB (no ducklake writes,
# no Postgres); it depends on goatlib for shared STAC/DuckDB helpers only.
FROM linux-base AS python-base
# Install uv
COPY --from=ghcr.io/astral-sh/uv:0.9.2 /uv /usr/local/bin/uv
WORKDIR /app

# Third-party dependencies first, from the lockfile and the workspace manifests
# alone, so a source change reuses this layer and reinstalls only the
# workspace packages below.
COPY pyproject.toml uv.lock /app/
COPY apps/catalog/pyproject.toml /app/apps/catalog/
COPY packages/python/goatlib/pyproject.toml /app/packages/python/goatlib/
COPY packages/python/goatobs/pyproject.toml /app/packages/python/goatobs/
RUN uv sync --frozen --no-dev --no-editable --no-install-workspace --package=catalog

# Bake DuckDB extensions into the image so the runtime never fetches them
# from extensions.duckdb.org -- removes the egress/TLS dependency and speeds
# cold start. Needs egress, available only in this build stage. It needs
# nothing from the workspace sources, so it runs before they are copied.
#
# catalog only ever opens a bare `duckdb.connect()` over local parquet files
# (catalog.store._load_extensions) -- no DuckLake attach, no Postgres, no
# S3/httpfs -- so this bakes just `spatial` (geometry columns/predicates)
# instead of goatlib's DuckLake-oriented REQUIRED_DUCKDB_EXTENSIONS list
# (spatial/httpfs/postgres/ducklake), which would bake three extensions this
# image never loads. `fts` was baked here too until the store dropped its
# full-text index in favour of scanning the mirror's `search_text` column.
RUN python -c "import duckdb; con=duckdb.connect(config={'extension_directory':'/opt/duckdb-extensions'}); con.execute('INSTALL spatial')" \
    && chmod -R a+rX /opt/duckdb-extensions

COPY apps/catalog /app/apps/catalog
COPY packages/python/goatlib /app/packages/python/goatlib
COPY packages/python/goatobs /app/packages/python/goatobs
RUN uv sync --frozen --no-dev --no-editable --package=catalog

# ==== STAGE 3: Webapp environment ====
FROM linux-base AS webapp

RUN useradd -m appuser

# Copy python, virtual env and application. --chown here rather than a
# `chown -R` afterwards, which would store every file a second time in another
# layer.
COPY --from=python-base --chown=appuser:appuser $UV_PYTHON_INSTALL_DIR $UV_PYTHON_INSTALL_DIR
COPY --from=python-base --chown=appuser:appuser $UV_PROJECT_ENVIRONMENT $UV_PROJECT_ENVIRONMENT
COPY --from=python-base --chown=appuser:appuser /app /app

# DuckDB extensions baked at build time; goatlib loads them from here at runtime
# (DUCKDB_EXTENSION_DIRECTORY), so no extension is ever downloaded.
COPY --from=python-base --chown=appuser:appuser /opt/duckdb-extensions /opt/duckdb-extensions
ENV DUCKDB_EXTENSION_DIRECTORY=/opt/duckdb-extensions

USER appuser

WORKDIR /app

EXPOSE 8400

CMD ["uvicorn", "catalog.main:app", "--host", "0.0.0.0", "--port", "8400"]
