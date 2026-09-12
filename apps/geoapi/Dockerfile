# ==== STAGE 1: General debian environment ====
FROM debian:bookworm-slim AS linux-base

LABEL org.opencontainers.image.source=https://github.com/plan4better/goat
LABEL org.opencontainers.image.description="Goat GeoAPI"
LABEL org.opencontainers.image.licenses="GPL-3.0"

ARG PYTHON_VERSION=3.11


ENV LC_CTYPE=C.utf8 \
    UV_PROJECT_ENVIRONMENT="/venv" \
    UV_COMPILE_BYTECODE=1 \
    UV_PYTHON_INSTALL_DIR="/python" \
    UV_PYTHON=python$PYTHON_VERSION

ENV PATH="$UV_PROJECT_ENVIRONMENT/bin:$PATH"

RUN apt-get update
RUN apt-get upgrade -y

# Install general required dependencies
RUN apt-get install --no-install-recommends -y tzdata

# ==== STAGE 2: Build tippecanoe ====
FROM linux-base AS tippecanoe-builder

ARG TIPPECANOE_VERSION=2.79.0

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    curl \
    libsqlite3-dev \
    zlib1g-dev \
    && curl -fsSL https://github.com/felt/tippecanoe/archive/refs/tags/${TIPPECANOE_VERSION}.tar.gz -o /tmp/tippecanoe.tar.gz \
    && tar -xzf /tmp/tippecanoe.tar.gz -C /tmp \
    && cd /tmp/tippecanoe-${TIPPECANOE_VERSION} \
    && make -j$(nproc) \
    && make install \
    && rm -rf /tmp/tippecanoe*

# ===== STAGE 3: Python environment ====
# geoapi only uses goatlib's light "serving" surface (storage/query/models), so
# no GDAL, routing or build toolchain is needed — all deps ship manylinux wheels.
FROM linux-base AS python-base
# Install uv
COPY --from=ghcr.io/astral-sh/uv:0.9.2 /uv /usr/local/bin/uv

# Create virtual environment and install dependencies
COPY apps/geoapi /app/apps/geoapi
COPY packages/python/goatlib /app/packages/python/goatlib
COPY packages/python/goatobs /app/packages/python/goatobs
COPY pyproject.toml uv.lock /app/

WORKDIR /app

RUN uv sync --frozen --no-dev --no-editable --package=geoapi

# Bake DuckDB extensions (spatial/httpfs/postgres/ducklake + community h3) into the
# image so the runtime never fetches them from the DuckDB repositories — removes
# the egress/TLS dependency and speeds cold start. Needs ca-certificates+egress,
# available only in this build stage.
RUN apt-get update && apt-get install --no-install-recommends -y ca-certificates \
    && python -c "import duckdb; from goatlib.storage.ducklake import REQUIRED_DUCKDB_EXTENSIONS as X, COMMUNITY_DUCKDB_EXTENSIONS as C; con=duckdb.connect(config={'extension_directory':'/opt/duckdb-extensions'}); [con.execute(f'INSTALL {e}') for e in X]; [con.execute(f'INSTALL {e} FROM community') for e in C]" \
    && rm -rf /var/lib/apt/lists/*

# ==== STAGE 4: Webapp environment ====
FROM linux-base AS webapp

# Install zlib runtime needed by tippecanoe, and ca-certificates for TLS
# (DuckDB extension downloads via httpfs verify against the system CA store).
RUN apt-get update && apt-get install --no-install-recommends -y zlib1g ca-certificates && rm -rf /var/lib/apt/lists/*

# Copy tippecanoe binaries (tippecanoe-overzoom for variable-depth tile pyramids)
COPY --from=tippecanoe-builder /usr/local/bin/tippecanoe-overzoom /usr/local/bin/

RUN useradd -m appuser

# Copy python, virtual env and static assets
COPY --from=python-base $UV_PYTHON_INSTALL_DIR $UV_PYTHON_INSTALL_DIR
COPY --from=python-base $UV_PROJECT_ENVIRONMENT $UV_PROJECT_ENVIRONMENT
COPY --from=python-base /app /app

# DuckDB extensions baked at build time into DuckDB's default extension
# directory ($HOME/.duckdb/extensions), so every connection finds them without
# configuration and nothing is downloaded at runtime. HOME is pinned because a
# runtime that overrides the user (runAsUser) would otherwise resolve it from
# /etc/passwd and look elsewhere. World-readable for arbitrary UIDs.
ENV HOME=/home/appuser
COPY --from=python-base /opt/duckdb-extensions /home/appuser/.duckdb/extensions
RUN chmod -R a+rX /home/appuser/.duckdb

RUN chown -R appuser:appuser /app $UV_PROJECT_ENVIRONMENT $UV_PYTHON_INSTALL_DIR /home/appuser/.duckdb
USER appuser

WORKDIR /app

EXPOSE 8000

CMD ["fastapi", "run", "apps/geoapi/src/geoapi/main.py"]

