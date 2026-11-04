# ==== STAGE 1: General debian environment ====
FROM debian:bookworm-slim AS linux-base

LABEL org.opencontainers.image.source=https://github.com/plan4better/goat
LABEL org.opencontainers.image.description="GOAT Assistant API"
LABEL org.opencontainers.image.licenses="GPL-3.0"

ARG PYTHON_VERSION=3.11

ENV LC_CTYPE=C.utf8 \
    UV_PROJECT_ENVIRONMENT="/venv" \
    UV_COMPILE_BYTECODE=1 \
    UV_PYTHON_INSTALL_DIR="/python" \
    UV_PYTHON=python$PYTHON_VERSION

ENV PATH="$UV_PROJECT_ENVIRONMENT/bin:$PATH"

# ca-certificates: the model providers, Keycloak and the other services are
# reached over HTTPS.
RUN apt-get update && apt-get upgrade -y \
    && apt-get install --no-install-recommends -y tzdata ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ===== STAGE 2: Python environment ====
# No GDAL, no DuckDB extensions, no build toolchain: the assistant talks to the
# other services over HTTP and to Postgres and Redis.
FROM linux-base AS python-base
COPY --from=ghcr.io/astral-sh/uv:0.9.2 /uv /usr/local/bin/uv
WORKDIR /app

# Third-party dependencies first, from the lockfile and the workspace manifests
# alone, so a source change reuses this layer.
COPY pyproject.toml uv.lock /app/
COPY apps/assistant/pyproject.toml /app/apps/assistant/
COPY packages/python/goatlib/pyproject.toml /app/packages/python/goatlib/
COPY packages/python/goatobs/pyproject.toml /app/packages/python/goatobs/
RUN uv sync --frozen --no-dev --no-editable --no-install-workspace --package=assistant

COPY apps/assistant /app/apps/assistant
COPY packages/python/goatlib /app/packages/python/goatlib
COPY packages/python/goatobs /app/packages/python/goatobs
RUN uv sync --frozen --no-dev --no-editable --package=assistant

# ==== STAGE 3: Runtime ====
FROM linux-base AS webapp

RUN useradd -m appuser

COPY --from=python-base --chown=appuser:appuser $UV_PYTHON_INSTALL_DIR $UV_PYTHON_INSTALL_DIR
COPY --from=python-base --chown=appuser:appuser $UV_PROJECT_ENVIRONMENT $UV_PROJECT_ENVIRONMENT
COPY --from=python-base --chown=appuser:appuser /app /app

# Open SSE streams keep uvicorn's graceful shutdown waiting; after this many
# seconds it closes them and runs the lifespan shutdown. Every deployment gives
# the process 30 s before it is killed (compose stop_grace_period, Kubernetes
# terminationGracePeriodSeconds); the browser re-attaches to another process.
ENV UVICORN_TIMEOUT_GRACEFUL_SHUTDOWN=20

USER appuser

WORKDIR /app

EXPOSE 8500

CMD ["uvicorn", "assistant.main:app", "--host", "0.0.0.0", "--port", "8500"]
