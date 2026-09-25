# ==== STAGE 1: General debian environment ====
FROM debian:bookworm-slim AS linux-base

LABEL org.opencontainers.image.source=https://github.com/plan4better/goat
LABEL org.opencontainers.image.description="Goat Core"
LABEL org.opencontainers.image.licenses="GPL-3.0"

ARG PYTHON_VERSION=3.11

ENV LC_CTYPE=C.utf8 \
    UV_PROJECT_ENVIRONMENT="/venv" \
    UV_COMPILE_BYTECODE=1 \
    UV_PYTHON_INSTALL_DIR="/python" \
    UV_PYTHON=python$PYTHON_VERSION \
    UV_PYTHON_PREFERENCE=only-managed

ENV PATH="$UV_PROJECT_ENVIRONMENT/bin:$PATH"

# ca-certificates is what OpenSSL's default verify paths read, so without it
# `ssl.create_default_context()` trusts nothing and every outbound HTTPS call
# made through aiohttp fails to verify. Installed in the shared base so the
# build stage and the runtime stage both have it.
RUN apt-get update && apt-get upgrade -y \
    && apt-get install --no-install-recommends -y tzdata ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ==== STAGE 2: Python environment ====
# core depends only on goatlib's light base (auth helpers), not the full
# geospatial stack, so no GDAL headers or build toolchain are required — every
# remaining dependency ships a manylinux wheel.
FROM linux-base AS python-base

# Install uv
COPY --from=ghcr.io/astral-sh/uv:0.9.2 /uv /usr/local/bin/uv
WORKDIR /app

# Third-party dependencies first, from the lockfile and the workspace manifests
# alone, so a source change reuses this layer and reinstalls only the
# workspace packages below.
COPY pyproject.toml uv.lock /app/
COPY apps/core/pyproject.toml /app/apps/core/
COPY packages/python/goatlib/pyproject.toml /app/packages/python/goatlib/
COPY packages/python/goatobs/pyproject.toml /app/packages/python/goatobs/
RUN uv sync --frozen --no-dev --no-editable --no-install-workspace --package=core

COPY apps/core /app/apps/core
COPY packages/python/goatlib /app/packages/python/goatlib
COPY packages/python/goatobs /app/packages/python/goatobs
RUN uv sync --frozen --no-dev --no-editable --package=core

# ==== STAGE 3: Webapp environment ====
FROM linux-base AS webapp

RUN useradd -m appuser && chown appuser:appuser /tmp

# Copy python, virtual env and app. --chown here rather than a `chown -R`
# afterwards, which would store every file a second time in another layer.
COPY --from=python-base --chown=appuser:appuser $UV_PYTHON_INSTALL_DIR $UV_PYTHON_INSTALL_DIR
COPY --from=python-base --chown=appuser:appuser $UV_PROJECT_ENVIRONMENT $UV_PROJECT_ENVIRONMENT
COPY --from=python-base --chown=appuser:appuser /app /app

USER appuser

WORKDIR /app

EXPOSE 8000

CMD ["fastapi", "run", "apps/core/src/core/main.py"]
