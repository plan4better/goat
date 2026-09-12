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

# Create virtual environment and install dependencies
COPY apps/core /app/apps/core
COPY packages/python/goatlib /app/packages/python/goatlib
COPY packages/python/goatobs /app/packages/python/goatobs
COPY pyproject.toml uv.lock /app/
WORKDIR /app

# Install project dependencies
RUN uv sync --frozen --no-dev --no-editable --package=core

# ==== STAGE 3: Webapp environment ====
FROM linux-base AS webapp

# Copy python, virtual env and app
COPY --from=python-base $UV_PYTHON_INSTALL_DIR $UV_PYTHON_INSTALL_DIR
COPY --from=python-base $UV_PROJECT_ENVIRONMENT $UV_PROJECT_ENVIRONMENT
COPY --from=python-base /app /app

RUN useradd -m appuser
RUN chown -R appuser:appuser /app /tmp $UV_PROJECT_ENVIRONMENT $UV_PYTHON_INSTALL_DIR
USER appuser

WORKDIR /app

EXPOSE 8000

CMD ["fastapi", "run", "apps/core/src/core/main.py"]
