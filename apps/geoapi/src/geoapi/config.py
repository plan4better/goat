"""Configuration for GeoAPI service."""

import json
import os
from typing import Annotated, Optional

from goatlib.api.root_path import normalize_root_path
from goatlib.auth import AuthFlag, require_keycloak_url
from goatlib.config.postgres import (
    ducklake_postgres_endpoint,
    parse_transaction_pooler,
    transaction_pooler_enabled,
)
from goatlib.utils.credentials import postgres_uri
from pydantic import AliasChoices, Field, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode


class Settings(BaseSettings):
    """Application settings for GeoAPI.

    GeoAPI serves OGC Features and Tiles from DuckLake storage.
    Process execution has moved to the dedicated 'processes' service.
    """

    # API Settings
    APP_NAME: str = "GOAT GeoAPI"
    # Path prefix when served behind a path-routing gateway (e.g. "/geoapi").
    # Empty = served from "/" of its own host. See goatlib.api.root_path.
    ROOT_PATH: str = normalize_root_path(os.getenv("ROOT_PATH"))

    @field_validator("ROOT_PATH", mode="before")
    @classmethod
    def _normalize_root_path(cls, value: str | None) -> str:
        return normalize_root_path(value)

    DEBUG: bool = False

    # Authentication settings. AUTH is the repo-wide switch (bare `AUTH`,
    # with GEOAPI_AUTH as a fallback); an explicit validation_alias bypasses
    # env_prefix for these fields.
    AUTH: AuthFlag = Field(
        default=True, validation_alias=AliasChoices("AUTH", "GEOAPI_AUTH")
    )

    # Read authorization gate for tile/feature/metadata endpoints. Shadow
    # mode (False, default) only logs `read_authz.would_deny`; flip on dev
    # only after that counter is quiet. Env: GEOAPI_ENFORCE_READ_AUTHZ, or the
    # bare ENFORCE_READ_AUTHZ the Helm chart sets.
    ENFORCE_READ_AUTHZ: bool = Field(
        default=False,
        validation_alias=AliasChoices(
            "GEOAPI_ENFORCE_READ_AUTHZ", "ENFORCE_READ_AUTHZ"
        ),
    )
    # Keycloak: the bare env var, overridable per service with GEOAPI_*.
    # Required when AUTH is on (see _require_keycloak).
    KEYCLOAK_SERVER_URL: str = Field(
        default="",
        validation_alias=AliasChoices(
            "GEOAPI_KEYCLOAK_SERVER_URL", "KEYCLOAK_SERVER_URL"
        ),
    )
    REALM_NAME: str = Field(
        default="p4b",
        validation_alias=AliasChoices("GEOAPI_REALM_NAME", "REALM_NAME"),
    )
    # Comma-separated Keycloak client IDs whose tokens are accepted (the
    # token's `azp`); empty accepts every client of the realm. Bare name only,
    # like the other services.
    AUTH_ALLOWED_CLIENTS: str = Field(
        default="", validation_alias="AUTH_ALLOWED_CLIENTS"
    )

    # PostgreSQL settings for DuckLake catalog
    POSTGRES_USER: str = os.getenv("POSTGRES_USER", "postgres")
    POSTGRES_PASSWORD: str = os.getenv("POSTGRES_PASSWORD", "postgres")
    POSTGRES_SERVER: str = os.getenv("POSTGRES_SERVER", "localhost")
    POSTGRES_PORT: int = int(os.getenv("POSTGRES_PORT", "5432"))
    POSTGRES_DB: str = os.getenv("POSTGRES_DB", "goat")

    # DuckLake settings
    DUCKLAKE_CATALOG_SCHEMA: str = os.getenv("DUCKLAKE_CATALOG_SCHEMA", "ducklake")
    # Must match core app's data path since they share the same catalog
    DUCKLAKE_DATA_DIR: str = os.getenv("DUCKLAKE_DATA_DIR", "/app/data/ducklake")

    # Tiles storage (separate from source data for cache semantics)
    TILES_DATA_DIR: str = os.getenv("TILES_DATA_DIR", "/app/data/tiles")
    # Materialized catalog layers: one immutable GeoParquet per promoted layer,
    # written by the catalog_materialize job. Read through a view that names
    # file_row_number `rowid`, so every rowid-based query works unchanged.
    CATALOG_LAYERS_DIR: str = os.getenv(
        "CATALOG_LAYERS_DIR",
        os.path.join(os.getenv("DATA_DIR", "/app/data"), "catalog", "layers"),
    )
    # Their PMTiles, in a sibling directory: a cache derived from the parquet
    # above, so it can be wiped to force a rebuild without losing data that
    # would have to come from the catalog bucket again.
    CATALOG_TILES_DIR: str = os.getenv(
        "CATALOG_TILES_DIR",
        os.path.join(os.getenv("DATA_DIR", "/app/data"), "catalog", "tiles"),
    )

    # S3/MinIO settings (shared for DuckLake and uploads)
    S3_PROVIDER: str = os.getenv("S3_PROVIDER", "hetzner").lower()
    S3_ENDPOINT_URL: Optional[str] = os.getenv("S3_ENDPOINT_URL")
    S3_ACCESS_KEY_ID: Optional[str] = os.getenv("S3_ACCESS_KEY_ID")
    S3_SECRET_ACCESS_KEY: Optional[str] = os.getenv("S3_SECRET_ACCESS_KEY")
    S3_REGION_NAME: str = os.getenv("S3_REGION", "us-east-1")
    S3_BUCKET_NAME: Optional[str] = os.getenv("S3_BUCKET_NAME")

    # Hidden fields - columns to exclude from API responses (tiles and features)
    # These are internal/structural columns that shouldn't be exposed to clients
    # Can be overridden via GEOAPI_HIDDEN_FIELDS env var, comma-separated
    # (bbox,$minx,$miny) or a JSON list.
    HIDDEN_FIELDS: Annotated[set[str], NoDecode] = {
        "bbox",  # GeoParquet 1.1 bounding box struct
        "$minx",
        "$miny",
        "$maxx",
        "$maxy",  # Legacy scalar bbox columns
    }

    @field_validator("HIDDEN_FIELDS", mode="before")
    @classmethod
    def _parse_hidden_fields(cls, value: object) -> object:
        if isinstance(value, str):
            if value.lstrip().startswith("["):
                return json.loads(value)
            return {f.strip() for f in value.split(",") if f.strip()}
        return value

    # MVT Settings
    MAX_FEATURES_PER_TILE: int = 15000
    DEFAULT_TILE_BUFFER: int = 256
    DEFAULT_EXTENT: int = 4096

    # Connection pool size for concurrent tile requests
    # Lower values reduce memory usage and idle connections that can go stale
    DUCKLAKE_POOL_SIZE: int = int(os.getenv("GEOAPI_DUCKLAKE_POOL_SIZE", "4"))

    # Pin read connections to a DuckLake snapshot and refresh off the request
    # path. Kill-switch: DUCKLAKE_PIN_SNAPSHOT=false restores unpinned reads.
    DUCKLAKE_PIN_SNAPSHOT: bool = (
        os.getenv("DUCKLAKE_PIN_SNAPSHOT", "true").lower() == "true"
    )
    DUCKLAKE_SNAPSHOT_REFRESH_SECONDS: float = float(
        os.getenv("DUCKLAKE_SNAPSHOT_REFRESH_SECONDS", "5")
    )

    # DuckDB memory limit per connection (e.g., "1GB", "512MB")
    # Total potential memory = DUCKLAKE_POOL_SIZE * DUCKDB_MEMORY_LIMIT
    DUCKDB_MEMORY_LIMIT: str = os.getenv("GEOAPI_DUCKDB_MEMORY_LIMIT", "1GB")

    # DuckDB thread count per connection. Must be pinned to the container's CPU
    # limit: DuckDB otherwise defaults to the host core count, oversubscribing a
    # 2-CPU container and causing scheduler throttling. Mirrors the processes app.
    DUCKDB_THREADS: int = int(os.getenv("GEOAPI_DUCKDB_THREADS", "2"))

    # Timeout Settings (in seconds)
    REQUEST_TIMEOUT: int = int(os.getenv("GEOAPI_REQUEST_TIMEOUT", "30"))
    TILE_TIMEOUT: int = int(
        os.getenv("GEOAPI_TILE_TIMEOUT", "30")
    )  # Increased for large datasets
    FEATURE_TIMEOUT: int = int(os.getenv("GEOAPI_FEATURE_TIMEOUT", "30"))
    # DuckDB query timeout - queries exceeding this will be interrupted
    QUERY_TIMEOUT: int = int(os.getenv("GEOAPI_QUERY_TIMEOUT", "10"))
    # Download/export timeout - longer since exports can be large
    DOWNLOAD_TIMEOUT: int = int(os.getenv("GEOAPI_DOWNLOAD_TIMEOUT", "120"))

    # Processes service, for queuing the artifact rebuild a bundle edit needs.
    # Unset = the save still lands, but the bundle stays stale until rebuilt
    # from its bundle page.
    PROCESSES_URL: str = os.getenv("GOAT_PROCESSES_URL", "")

    # Hosts raster files may be read from although they resolve to a private
    # address (an object store inside the cluster), comma-separated. Every other
    # host must resolve to public addresses. Bare name, shared with processes.
    RASTER_PRIVATE_HOSTS: str = Field(
        default="",
        validation_alias=AliasChoices(
            "RASTER_PRIVATE_HOSTS", "GEOAPI_RASTER_PRIVATE_HOSTS"
        ),
    )

    @property
    def raster_private_hosts(self) -> tuple[str, ...]:
        return tuple(
            h.strip() for h in self.RASTER_PRIVATE_HOSTS.split(",") if h.strip()
        )

    # Redis settings for distributed tile caching
    REDIS_URL: str = os.getenv("REDIS_URL", "redis://redis:6379/0")
    # Tile cache TTL in seconds (default 1 hour)
    TILE_CACHE_TTL: int = int(os.getenv("GEOAPI_TILE_CACHE_TTL", "3600"))
    # Enable/disable Redis tile cache
    TILE_CACHE_ENABLED: bool = (
        os.getenv("GEOAPI_TILE_CACHE_ENABLED", "true").lower() == "true"
    )

    # CORS settings
    CORS_ORIGINS: list[str] = ["*"]

    # Direct PostgreSQL host and port for DuckLake attaches. They keep their
    # catalog connections for as long as they live and are not verified behind
    # a transaction pooler; point these at the primary (e.g. the CNPG rw
    # service) to keep the pooler for app queries.
    # Unset = same host and port as POSTGRES_SERVER / POSTGRES_PORT.
    # POSTGRES_SERVER is a pooler in transaction mode (bare name, no prefix):
    # the query pool then caches no prepared statements and sends no
    # keepalive settings (goatlib.config.postgres.asyncpg_connect_args).
    POSTGRES_TRANSACTION_POOLER: bool = transaction_pooler_enabled()

    @field_validator("POSTGRES_TRANSACTION_POOLER", mode="before")
    @classmethod
    def _parse_transaction_pooler(cls, value: object) -> bool:
        return parse_transaction_pooler(value)

    DUCKLAKE_POSTGRES_SERVER: str = os.getenv("DUCKLAKE_POSTGRES_SERVER", "")
    DUCKLAKE_POSTGRES_PORT: str = os.getenv("DUCKLAKE_POSTGRES_PORT", "")

    @model_validator(mode="after")
    def _require_keycloak(self) -> "Settings":
        require_keycloak_url(self.AUTH, self.KEYCLOAK_SERVER_URL)
        return self

    @property
    def POSTGRES_DATABASE_URI(self) -> str:
        """Construct PostgreSQL URI."""
        return postgres_uri(
            self.POSTGRES_USER,
            self.POSTGRES_PASSWORD,
            self.POSTGRES_SERVER,
            self.POSTGRES_PORT,
            self.POSTGRES_DB,
        )

    @property
    def DUCKLAKE_POSTGRES_DATABASE_URI(self) -> str:
        """PostgreSQL URI for DuckLake catalog attaches (direct, unpooled)."""
        host, port = ducklake_postgres_endpoint(
            self.POSTGRES_SERVER,
            self.POSTGRES_PORT,
            self.DUCKLAKE_POSTGRES_SERVER,
            self.DUCKLAKE_POSTGRES_PORT,
        )
        return postgres_uri(
            self.POSTGRES_USER, self.POSTGRES_PASSWORD, host, port, self.POSTGRES_DB
        )

    model_config = {"env_prefix": "GEOAPI_", "case_sensitive": True}


settings = Settings()
