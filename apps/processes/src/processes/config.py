"""Configuration for Processes API service."""

import os
from typing import Optional

from goatlib.api.root_path import normalize_root_path
from goatlib.auth import AuthFlag, require_keycloak_url
from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings


def _get_windmill_token() -> str:
    """Get Windmill token from environment or file.

    Checks in order:
    1. WINDMILL_TOKEN environment variable
    2. WINDMILL_TOKEN_FILE environment variable (path to file containing token)
    3. Default token file location (/app/data/windmill/.token)
    """
    # First try environment variable
    token = os.getenv("WINDMILL_TOKEN", "")
    if token:
        return token

    # Try token file from environment
    token_file = os.getenv("WINDMILL_TOKEN_FILE")
    if token_file and os.path.exists(token_file):
        with open(token_file) as f:
            return f.read().strip()

    # Try default token file location
    default_token_file = "/app/data/windmill/.token"
    if os.path.exists(default_token_file):
        with open(default_token_file) as f:
            return f.read().strip()

    return ""


class Settings(BaseSettings):
    """Application settings."""

    # API Settings
    APP_NAME: str = "GOAT Processes API"
    # Path prefix when served behind a path-routing gateway (e.g. "/geoapi").
    # Empty = served from "/" of its own host. See goatlib.api.root_path.
    ROOT_PATH: str = normalize_root_path(os.getenv("ROOT_PATH"))

    @field_validator("ROOT_PATH", mode="before")
    @classmethod
    def _normalize_root_path(cls, value: str | None) -> str:
        return normalize_root_path(value)

    DEBUG: bool = False

    # Authentication settings. KEYCLOAK_SERVER_URL is required when AUTH is
    # on (see _require_keycloak).
    AUTH: AuthFlag = True
    KEYCLOAK_SERVER_URL: str = ""
    REALM_NAME: str = "p4b"

    @model_validator(mode="after")
    def _require_keycloak(self) -> "Settings":
        require_keycloak_url(self.AUTH, self.KEYCLOAK_SERVER_URL)
        return self

    # PostgreSQL settings for DuckLake catalog
    POSTGRES_USER: str = os.getenv("POSTGRES_USER", "postgres")
    POSTGRES_PASSWORD: str = os.getenv("POSTGRES_PASSWORD", "postgres")
    POSTGRES_SERVER: str = os.getenv("POSTGRES_SERVER", "localhost")
    POSTGRES_PORT: int = int(os.getenv("POSTGRES_PORT", "5432"))
    POSTGRES_DB: str = os.getenv("POSTGRES_DB", "goat")

    # Direct PostgreSQL host for DuckLake attaches (long-lived,
    # idle-in-transaction sessions that waste transaction-pooler slots).
    # Unset = same host as POSTGRES_SERVER.
    DUCKLAKE_POSTGRES_SERVER: str = os.getenv(
        "DUCKLAKE_POSTGRES_SERVER", ""
    ) or os.getenv("POSTGRES_SERVER", "localhost")

    @property
    def POSTGRES_DATABASE_URI(self) -> str:
        """Construct PostgreSQL connection URI for DuckLake."""
        return f"postgresql://{self.POSTGRES_USER}:{self.POSTGRES_PASSWORD}@{self.POSTGRES_SERVER}:{self.POSTGRES_PORT}/{self.POSTGRES_DB}"

    @property
    def DUCKLAKE_POSTGRES_DATABASE_URI(self) -> str:
        """PostgreSQL URI for DuckLake catalog attaches (direct, unpooled)."""
        return f"postgresql://{self.POSTGRES_USER}:{self.POSTGRES_PASSWORD}@{self.DUCKLAKE_POSTGRES_SERVER}:{self.POSTGRES_PORT}/{self.POSTGRES_DB}"

    # Schema settings
    CUSTOMER_SCHEMA: str = os.getenv("CUSTOMER_SCHEMA", "customer")

    # Windmill settings for job execution
    WINDMILL_URL: str = os.getenv("WINDMILL_URL", "http://windmill-server:8000")
    WINDMILL_WORKSPACE: str = os.getenv("WINDMILL_WORKSPACE", "goat")
    CORE_URL: str = os.getenv("CORE_URL", "http://goat-core:8000")

    @property
    def WINDMILL_TOKEN(self) -> str:
        """Get Windmill token from environment or file."""
        return _get_windmill_token()

    # DuckLake settings
    DUCKLAKE_CATALOG_SCHEMA: str = os.getenv("DUCKLAKE_CATALOG_SCHEMA", "ducklake")
    # Must match core/geoapi data path since they share the same catalog
    DUCKLAKE_DATA_DIR: str = os.getenv("DUCKLAKE_DATA_DIR", "/app/data/ducklake")
    # Tiles storage (separate from source data for cache semantics)
    TILES_DATA_DIR: str = os.getenv("TILES_DATA_DIR", "/app/data/tiles")
    DUCKLAKE_S3_ENDPOINT: Optional[str] = os.getenv("DUCKLAKE_S3_ENDPOINT")
    DUCKLAKE_S3_BUCKET: Optional[str] = os.getenv("DUCKLAKE_S3_BUCKET")
    DUCKLAKE_S3_ACCESS_KEY: Optional[str] = os.getenv("DUCKLAKE_S3_ACCESS_KEY")
    DUCKLAKE_S3_SECRET_KEY: Optional[str] = os.getenv("DUCKLAKE_S3_SECRET_KEY")

    # Pin read connections to a DuckLake snapshot and refresh off the request
    # path. Kill-switch: DUCKLAKE_PIN_SNAPSHOT=false restores unpinned reads.
    DUCKLAKE_PIN_SNAPSHOT: bool = (
        os.getenv("DUCKLAKE_PIN_SNAPSHOT", "true").lower() == "true"
    )
    DUCKLAKE_SNAPSHOT_REFRESH_SECONDS: float = float(
        os.getenv("DUCKLAKE_SNAPSHOT_REFRESH_SECONDS", "5")
    )

    # DuckDB memory limit (e.g., "1.5GB", "512MB")
    DUCKDB_MEMORY_LIMIT: str = os.getenv("PROCESSES_DUCKDB_MEMORY_LIMIT", "1.2GB")

    # DuckDB thread limit (number of CPU threads to use)
    # Default: 2 threads per query to allow concurrent requests
    DUCKDB_THREADS: int = int(os.getenv("PROCESSES_DUCKDB_THREADS", "2"))

    # Analytics query timeout in seconds (applies to sync analytics queries)
    ANALYTICS_QUERY_TIMEOUT: int = int(
        os.getenv("PROCESSES_ANALYTICS_QUERY_TIMEOUT", "60")
    )

    # Traveltime matrices directory for heatmap tools
    TRAVELTIME_MATRICES_DIR: str = os.getenv(
        "TRAVELTIME_MATRICES_DIR", "/app/data/traveltime_matrices"
    )

    # S3/MinIO settings (shared for DuckLake and uploads)
    S3_PROVIDER: str = os.getenv("S3_PROVIDER", "hetzner").lower()
    S3_ENDPOINT_URL: Optional[str] = os.getenv("S3_ENDPOINT_URL")
    S3_ACCESS_KEY_ID: Optional[str] = os.getenv("S3_ACCESS_KEY_ID")
    S3_SECRET_ACCESS_KEY: Optional[str] = os.getenv("S3_SECRET_ACCESS_KEY")
    S3_REGION_NAME: str = os.getenv("S3_REGION", "us-east-1")
    S3_BUCKET_NAME: Optional[str] = os.getenv("S3_BUCKET_NAME")

    # Timeout Settings (in seconds)
    REQUEST_TIMEOUT: int = int(os.getenv("PROCESSES_REQUEST_TIMEOUT", "30"))

    # CORS settings
    CORS_ORIGINS: list[str] = ["*"]

    # Print worker URL (for PrintReport tool to render pages)
    PRINT_BASE_URL: str = os.getenv("PRINT_BASE_URL", "http://goat-web:3000")

    # Beta tool gating: users whose email domain is allowlisted are shown beta
    # tools in the toolbox. The allowlist lives in a Windmill variable (a
    # comma-separated list of domains, e.g. "plan4better.de,example.org")
    # configured on the Windmill variables page, like other operational config.
    # When the variable is unset/empty, beta tools are hidden from everyone.
    BETA_USER_EMAIL_DOMAINS_WM_PATH: str = os.getenv(
        "BETA_USER_EMAIL_DOMAINS_WM_PATH", "f/goat/config/beta_user_email_domains"
    )

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        extra = "ignore"  # Ignore extra environment variables


# Global settings instance
settings = Settings()


def normalize_email_domains(raw: str | None) -> set[str]:
    """Parse a comma-separated domain list into a normalized set.

    Lowercases, trims whitespace, and strips a leading '@' so both
    "@plan4better.de" and "plan4better.de" are accepted.
    """
    if not raw:
        return set()
    return {
        domain.strip().lstrip("@").lower()
        for domain in raw.split(",")
        if domain.strip()
    }
