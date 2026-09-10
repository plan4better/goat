# Windmill Workers - Multi-stage build
# Build targets: server, worker-default, worker-tools, worker-print
#
# Usage:
#   docker build --target server -t windmill-server .
#   docker build --target worker-default -t windmill-worker-default .
#   docker build --target worker-tools -t windmill-worker-tools .
#   docker build --target worker-print -t windmill-worker-print .

ARG WINDMILL_IMAGE_TAG='1.607.0'
ARG PYTHON_VERSION=3.11

# =============================================================================
# Stage: Server - API, UI, scheduler (official image, no changes)
# =============================================================================
FROM ghcr.io/windmill-labs/windmill:${WINDMILL_IMAGE_TAG} AS server

# =============================================================================
# Stage: Worker Default - minimal for cron jobs, system tasks (official image)
# =============================================================================
FROM ghcr.io/windmill-labs/windmill:${WINDMILL_IMAGE_TAG} AS worker-default
ENV DISABLE_SERVER=true

# =============================================================================
# Stage: Windmill Binary - extract windmill from official image
# =============================================================================
FROM ghcr.io/windmill-labs/windmill:${WINDMILL_IMAGE_TAG} AS windmill

# =============================================================================
# Stage: Linux Base - debian base with Python env vars
# =============================================================================
FROM debian:bookworm-slim AS linux-base

LABEL org.opencontainers.image.source=https://github.com/plan4better/goat
LABEL org.opencontainers.image.description="Goat Windmill Workers"
LABEL org.opencontainers.image.licenses="GPL-3.0"

ARG PYTHON_VERSION

ENV LC_CTYPE=C.utf8 \
    UV_PROJECT_ENVIRONMENT="/venv" \
    UV_COMPILE_BYTECODE=1 \
    UV_PYTHON_INSTALL_DIR="/python" \
    UV_PYTHON=python${PYTHON_VERSION} \
    UV_PYTHON_PREFERENCE=only-managed \
    TZ=Etc/UTC

ENV PATH="$UV_PROJECT_ENVIRONMENT/bin:$PATH"

RUN apt-get update && apt-get upgrade -y \
    && apt-get install --no-install-recommends -y \
    tzdata \
    ca-certificates \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# =============================================================================
# Stage: Python Build - install goatlib with all dependencies
# =============================================================================
FROM linux-base AS python-build

RUN apt-get update && apt-get install --no-install-recommends -y \
    build-essential \
    cmake \
    gdal-bin \
    libgdal-dev \
    libgeos-dev \
    libproj-dev \
    && rm -rf /var/lib/apt/lists/*

# Install uv
COPY --from=ghcr.io/astral-sh/uv:0.9.2 /uv /usr/local/bin/uv

# Copy goatlib + routing package sources and install with all dependencies
COPY packages/python/goatlib /app/packages/python/goatlib
COPY packages/cpp/routing /app/packages/cpp/routing
COPY pyproject.toml uv.lock /app/
WORKDIR /app
RUN uv sync --all-extras --frozen --no-dev --no-editable --package=goatlib

# Bake DuckDB extensions (spatial/httpfs/postgres/ducklake + community h3) into the
# image so the runtime never fetches them from the DuckDB repositories — removes
# the egress/TLS dependency and speeds cold start. (linux-base already carries
# ca-certificates + egress here.)
RUN python -c "import duckdb; from goatlib.storage.ducklake import REQUIRED_DUCKDB_EXTENSIONS as X, COMMUNITY_DUCKDB_EXTENSIONS as C; con=duckdb.connect(config={'extension_directory':'/opt/duckdb-extensions'}); [con.execute(f'INSTALL {e}') for e in X]; [con.execute(f'INSTALL {e} FROM community') for e in C]"

# =============================================================================
# Stage: Worker Base - shared base for tools/print workers with goatlib
# =============================================================================
FROM linux-base AS worker-base

ARG APP=/usr/src/app

# Copy windmill binary
COPY --from=windmill /usr/src/app/windmill ${APP}/windmill
RUN ln -s ${APP}/windmill /usr/local/bin/windmill

# Copy uv for runtime package management
COPY --from=ghcr.io/astral-sh/uv:0.9.2 /uv /usr/local/bin/uv

# Copy Python and venv from build stage
COPY --from=python-build $UV_PYTHON_INSTALL_DIR $UV_PYTHON_INSTALL_DIR
COPY --from=python-build $UV_PROJECT_ENVIRONMENT $UV_PROJECT_ENVIRONMENT
COPY --from=python-build /app /app

# DuckDB extensions baked at build time into DuckDB's default extension
# directory ($HOME/.duckdb/extensions). Windmill job subprocesses inherit HOME,
# so every connection they open finds the extensions without configuration.
# HOME is pinned so a runtime user override cannot move the default elsewhere.
ENV HOME=/root
COPY --from=python-build /opt/duckdb-extensions /root/.duckdb/extensions
RUN chmod -R a+rX /root/.duckdb && chmod a+x /root

WORKDIR ${APP}

ENV DISABLE_SERVER=true \
    PYTHON_PATH="$UV_PROJECT_ENVIRONMENT/bin/python"

CMD ["windmill"]

# =============================================================================
# Stage: Worker Tools - geospatial analytics (buffer, heatmap, isochrone, etc.)
# =============================================================================
FROM worker-base AS worker-tools

# Install geospatial system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    gdal-bin \
    libgdal-dev \
    libgeos-dev \
    libproj-dev \
    # Build dependencies for tippecanoe
    build-essential \
    libsqlite3-dev \
    zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

# Install tippecanoe for PMTiles generation
ARG TIPPECANOE_VERSION=2.79.0
RUN curl -fsSL https://github.com/felt/tippecanoe/archive/refs/tags/${TIPPECANOE_VERSION}.tar.gz -o /tmp/tippecanoe.tar.gz \
    && tar -xzf /tmp/tippecanoe.tar.gz -C /tmp \
    && cd /tmp/tippecanoe-${TIPPECANOE_VERSION} \
    && make -j$(nproc) \
    && make install \
    && rm -rf /tmp/tippecanoe*

ENV WORKER_TAGS=tools

# =============================================================================
# Stage: Worker Print - PDF reports, thumbnails with Playwright
# =============================================================================
FROM worker-base AS worker-print

# Install Playwright browser dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    fonts-liberation \
    fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

# Install Playwright Python package and browsers
RUN uv pip install playwright && playwright install chromium && playwright install-deps chromium

ENV WORKER_TAGS=print
