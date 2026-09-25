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
# Python versions Windmill itself asks uv for on top of PYTHON_VERSION. Any it
# can't find in /tmp/windmill/cache/py_runtime it downloads from GitHub at
# runtime, which breaks air-gapped installs. For Windmill 1.607.0 that is
# 3.12: its "latest stable" default (PyVAlias::default), preinstalled at every
# worker start and used by the dependency job's cache prefill. Re-check when
# bumping WINDMILL_IMAGE_TAG (ls /tmp/windmill/cache/py_runtime in the official
# image shows what that release expects).
ARG WINDMILL_EXTRA_PYTHON_VERSIONS="3.12"
ARG TIPPECANOE_VERSION=2.79.0
# Pinned because worker-print installs the browser before goatlib and the
# package after it (see there); both steps must name the same release.
ARG PLAYWRIGHT_VERSION=1.63.0

# =============================================================================
# Stage: Server - API, UI, scheduler (official image)
# =============================================================================
FROM ghcr.io/windmill-labs/windmill:${WINDMILL_IMAGE_TAG} AS server
# Don't pull Windmill Hub script/resource-type embeddings (bucket.windmillhub.com,
# re-pulled periodically). They only feed Windmill's own AI/Hub search in its UI;
# GOAT doesn't use them, and the fetch is a runtime download.
ENV DISABLE_EMBEDDING=true

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
# Stage: Routing Build - the C++ routing package as a wheel
# =============================================================================
# Its own stage, so a goatlib change reuses the compiled wheel. Only a change
# under packages/cpp/routing or a new nigiri SDK compiles it again.
FROM linux-base AS routing-build

RUN apt-get update && apt-get install --no-install-recommends -y \
    build-essential \
    cmake \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.9.2 /uv /usr/local/bin/uv

# CMakeLists downloads the nigiri SDK from the `latest-cpp` release, whose
# assets are replaced on every nigiri release. Fetching it here instead makes
# the SDK itself part of the cache key, so a new SDK compiles a new wheel, and
# CMake is pointed at this copy rather than downloading its own.
ARG TARGETARCH
ADD https://github.com/plan4better/nigiri/releases/download/latest-cpp/nigiri-sdk-linux-${TARGETARCH}.tar.gz /tmp/nigiri-sdk.tar.gz
RUN mkdir -p /opt/nigiri-sdk \
    && tar -xzf /tmp/nigiri-sdk.tar.gz -C /opt/nigiri-sdk \
    && rm /tmp/nigiri-sdk.tar.gz

COPY packages/cpp/routing /src/routing
RUN uv build --wheel /src/routing --out-dir /wheels \
    --config-setting=cmake.define.FETCHCONTENT_SOURCE_DIR_NIGIRI_SDK=/opt/nigiri-sdk

# =============================================================================
# Stage: Tippecanoe Build - PMTiles generation for worker-tools
# =============================================================================
FROM linux-base AS tippecanoe-build

RUN apt-get update && apt-get install --no-install-recommends -y \
    build-essential \
    libsqlite3-dev \
    zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

ARG TIPPECANOE_VERSION
RUN curl -fsSL https://github.com/felt/tippecanoe/archive/refs/tags/${TIPPECANOE_VERSION}.tar.gz -o /tmp/tippecanoe.tar.gz \
    && tar -xzf /tmp/tippecanoe.tar.gz -C /tmp \
    && cd /tmp/tippecanoe-${TIPPECANOE_VERSION} \
    && make -j$(nproc) \
    && make install PREFIX=/opt/tippecanoe \
    && rm -rf /tmp/tippecanoe*

# =============================================================================
# Stage: Playwright Build - a standalone Playwright CLI for worker-print
# =============================================================================
FROM linux-base AS playwright-build

COPY --from=ghcr.io/astral-sh/uv:0.9.2 /uv /usr/local/bin/uv

# Its Python lives under /opt/playwright as well, so mounting that one
# directory gives a working CLI.
ARG PLAYWRIGHT_VERSION
ENV UV_PYTHON_INSTALL_DIR=/opt/playwright/python
RUN uv venv /opt/playwright/venv \
    && uv pip install --no-cache --python /opt/playwright/venv/bin/python playwright==${PLAYWRIGHT_VERSION}

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
WORKDIR /app

# Python versions Windmill asks for besides the venv's (see
# WINDMILL_EXTRA_PYTHON_VERSIONS), installed next to it in the same uv-managed
# directory.
ARG WINDMILL_EXTRA_PYTHON_VERSIONS
RUN uv python install ${WINDMILL_EXTRA_PYTHON_VERSIONS}

# Third-party dependencies first, from the lockfile and goatlib's manifest
# alone, so a goatlib source change reuses this layer. routing comes from
# routing-build.
COPY pyproject.toml uv.lock /app/
COPY packages/python/goatlib/pyproject.toml /app/packages/python/goatlib/
RUN uv sync --all-extras --frozen --no-dev --no-editable --no-install-workspace --no-install-package routing --package=goatlib

COPY packages/python/goatlib /app/packages/python/goatlib
RUN uv sync --all-extras --frozen --no-dev --no-editable --no-install-package routing --package=goatlib

# After the last sync, which would remove a package it was told not to install.
COPY --from=routing-build /wheels /wheels
RUN uv pip install --no-deps --python $UV_PROJECT_ENVIRONMENT/bin/python /wheels/*.whl

# Bake DuckDB extensions (spatial/httpfs/postgres/ducklake + community h3) into the
# image so the runtime never fetches them from the DuckDB repositories — removes
# the egress/TLS dependency and speeds cold start. (linux-base already carries
# ca-certificates + egress here.) World-readable for arbitrary UIDs.
RUN python -c "import duckdb; from goatlib.storage.ducklake import REQUIRED_DUCKDB_EXTENSIONS as X, COMMUNITY_DUCKDB_EXTENSIONS as C; con=duckdb.connect(config={'extension_directory':'/opt/duckdb-extensions'}); [con.execute(f'INSTALL {e}') for e in X]; [con.execute(f'INSTALL {e} FROM community') for e in C]" \
    && chmod -R a+rX /opt/duckdb-extensions

# =============================================================================
# Stage: Worker Base - shared base for tools/print workers
# =============================================================================
# Holds no goatlib. Each worker adds its system packages on top of this and
# copies the Python environment last, so a goatlib change rebuilds nothing but
# that copy.
FROM linux-base AS worker-base

ARG APP=/usr/src/app

# Copy windmill binary
COPY --from=windmill /usr/src/app/windmill ${APP}/windmill
RUN ln -s ${APP}/windmill /usr/local/bin/windmill

# Copy uv for runtime package management
COPY --from=ghcr.io/astral-sh/uv:0.9.2 /uv /usr/local/bin/uv

# Point Windmill's uv-managed Python directory at ours. Windmill ignores
# PYTHON_PATH when it resolves a Python version: at every worker start and in
# every dependency job and every deployed-script run it calls
# `uv python find <v>` with UV_PYTHON_INSTALL_DIR hardcoded to
# /tmp/windmill/cache/py_runtime and runs `uv python install <v>` (a GitHub
# download) on a miss. With this link it finds the Pythons baked in /python, so
# nothing is downloaded. (A symlinked directory works; symlinked version
# subdirectories are ignored by uv.) Jobs still execute with PYTHON_PATH.
RUN mkdir -p /tmp/windmill/cache \
    && ln -s $UV_PYTHON_INSTALL_DIR /tmp/windmill/cache/py_runtime \
    && chmod 777 /tmp/windmill /tmp/windmill/cache

# DuckDB extensions are baked at build time into DuckDB's default extension
# directory ($HOME/.duckdb/extensions), copied in by each worker below.
# Windmill job subprocesses inherit HOME, so every connection they open finds
# the extensions without configuration. HOME is pinned so a runtime user
# override cannot move the default elsewhere.
ENV HOME=/root
RUN chmod a+x /root

# Windmill runs uv (`uv python find` above, lockfile resolution) with its
# environment cleared down to HOME and PATH, so uv's cache is always
# $HOME/.cache/uv, and the worker keeps its own script cache in
# $HOME/.cache/windmill. Make both creatable under a non-root UID too (sticky,
# like /tmp); otherwise `uv python find` fails and Windmill falls back to
# `uv python install`.
RUN mkdir -p /root/.cache/uv && chmod 1777 /root/.cache /root/.cache/uv

WORKDIR ${APP}

# Windmill's `uv python list` (the "latest stable" lookup for scripts without a
# `# py311`-style annotation) runs with NO environment at all. For a UID
# without a passwd entry uv then has no home and caches in ./.uv_cache, i.e.
# ${APP}/.uv_cache, which is root-owned; the list fails and Windmill falls back
# to installing 3.10 from GitHub. Pre-create it writable.
RUN mkdir -p ${APP}/.uv_cache && chmod 1777 ${APP}/.uv_cache

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
    # Build toolchain, and the libraries tippecanoe links against
    build-essential \
    libsqlite3-dev \
    zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

# tippecanoe for PMTiles generation
COPY --from=tippecanoe-build /opt/tippecanoe/ /usr/local/

# Python, venv and extensions last (see worker-base)
COPY --from=python-build $UV_PYTHON_INSTALL_DIR $UV_PYTHON_INSTALL_DIR
COPY --from=python-build $UV_PROJECT_ENVIRONMENT $UV_PROJECT_ENVIRONMENT
COPY --from=python-build /app /app
COPY --from=python-build /opt/duckdb-extensions /root/.duckdb/extensions

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

# Chromium and the system packages it needs, installed with the CLI from
# playwright-build, mounted for this step only. Doing it before the Python
# environment keeps the browser layer when only goatlib changes. Only the
# headless shell: the print jobs launch headless, which runs the shell, so
# the full browser would never start.
RUN --mount=type=bind,from=playwright-build,source=/opt/playwright,target=/opt/playwright \
    /opt/playwright/venv/bin/playwright install --with-deps --only-shell chromium \
    && rm -rf /var/lib/apt/lists/*

# Python, venv and extensions last (see worker-base)
COPY --from=python-build $UV_PYTHON_INSTALL_DIR $UV_PYTHON_INSTALL_DIR
COPY --from=python-build $UV_PROJECT_ENVIRONMENT $UV_PROJECT_ENVIRONMENT
COPY --from=python-build /app /app
COPY --from=python-build /opt/duckdb-extensions /root/.duckdb/extensions

# The Playwright package itself, the release whose browser is installed above.
# --no-cache: keep root-owned wheels out of the shared /root/.cache/uv (and out of the image)
ARG PLAYWRIGHT_VERSION
RUN uv pip install --no-cache --python $UV_PROJECT_ENVIRONMENT/bin/python playwright==${PLAYWRIGHT_VERSION}

ENV WORKER_TAGS=print
