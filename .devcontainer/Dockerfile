FROM python:3.11.12-bookworm

ARG PYTHON_VERSION="3.11.12"
ARG NODE_VERSION="22.12.0"
ARG PNPM_VERSION="9.5.0"

WORKDIR /app

# Update debian
RUN apt-get update && apt-get upgrade -y

# Install general required dependencies
RUN apt-get install --no-install-recommends -y \
    tzdata \
    ca-certificates \
    curl \
    wget \
    git \
    build-essential \
    cmake \
    ccache \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

# GDAL
RUN apt-get update && apt-get install -y --no-install-recommends gdal-bin libgdal-dev \
    && rm -rf /var/lib/apt/lists/*

# Tippecanoe, the PMTiles fallback for when manby fails (manby comes with uv sync)
ARG TIPPECANOE_VERSION=2.79.0
RUN apt-get update && apt-get install -y --no-install-recommends libsqlite3-dev zlib1g-dev \
    && curl -fsSL https://github.com/felt/tippecanoe/archive/refs/tags/${TIPPECANOE_VERSION}.tar.gz -o /tmp/tippecanoe.tar.gz \
    && tar -xzf /tmp/tippecanoe.tar.gz -C /tmp \
    && cd /tmp/tippecanoe-${TIPPECANOE_VERSION} \
    && make -j$(nproc) \
    && make install \
    && rm -rf /tmp/tippecanoe* /var/lib/apt/lists/*

# UV
ENV PATH="/app/.venv/bin:$PATH" \
    UV_PYTHON_DOWNLOADS=never \
    UV_PYTHON=python$PYTHON_VERSION \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/app/.venv

COPY --from=ghcr.io/astral-sh/uv:0.9.2 /uv /bin/uv

# NODE
ENV NVM_DIR=/usr/local/nvm
ENV NODE_VERSION=$NODE_VERSION
RUN mkdir -p $NVM_DIR
RUN curl --silent -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash \
    && . $NVM_DIR/nvm.sh \
    && nvm install $NODE_VERSION \
    && nvm alias default $NODE_VERSION \
    && nvm use default

# CELERY
RUN curl -sSL https://raw.githubusercontent.com/celery/celery/master/extra/generic-init.d/celeryd > /etc/init.d/celeryd && \
    chmod +x /etc/init.d/celeryd

# PLAYWRIGHT - Install Chromium browser for PDF generation
RUN pip install playwright && playwright install chromium --with-deps

# PNPM
ENV PNPM_VERSION=$PNPM_VERSION
RUN wget -qO- https://get.pnpm.io/install.sh | ENV="$HOME/.bashrc" SHELL="$(which bash)" bash -


