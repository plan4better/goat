"""DuckLake connection pool for GeoAPI.

Re-exports from goatlib with geoapi-specific initialization.
"""

from goatlib.storage import (
    DuckLakePool,
    execute_query_with_retry,
    execute_with_retry,
    is_connection_error,
)

from geoapi.config import settings

# Re-export for backward compatibility
__all__ = [
    "DuckLakePool",
    "is_connection_error",
    "execute_with_retry",
    "execute_query_with_retry",
    "ducklake_pool",
]


class GeoAPIDuckLakePool(DuckLakePool):
    """DuckLake pool with geoapi-specific initialization from settings."""

    # The H3 hexagon tiles (style render "h3").
    COMMUNITY_EXTENSIONS = ("h3",)

    def init(self) -> None:
        """Initialize the pool from geoapi settings."""

        # Create a settings wrapper that matches DuckLakeSettings protocol
        class SettingsWrapper:
            def __init__(self):
                self.POSTGRES_DATABASE_URI = settings.POSTGRES_DATABASE_URI
                self.DUCKLAKE_POSTGRES_DATABASE_URI = (
                    settings.DUCKLAKE_POSTGRES_DATABASE_URI
                )
                self.DUCKLAKE_CATALOG_SCHEMA = settings.DUCKLAKE_CATALOG_SCHEMA
                self.DUCKLAKE_S3_ENDPOINT = getattr(settings, "S3_ENDPOINT_URL", None)
                self.DUCKLAKE_S3_BUCKET = (
                    None  # Not using S3 for DuckLake storage currently
                )
                self.DUCKLAKE_S3_ACCESS_KEY = getattr(
                    settings, "S3_ACCESS_KEY_ID", None
                )
                self.DUCKLAKE_S3_SECRET_KEY = getattr(
                    settings, "S3_SECRET_ACCESS_KEY", None
                )
                self.DUCKLAKE_DATA_DIR = getattr(settings, "DUCKLAKE_DATA_DIR", None)
                self.DATA_DIR = getattr(settings, "DATA_DIR", "/tmp")
                self.DUCKDB_MEMORY_LIMIT = getattr(
                    settings, "DUCKDB_MEMORY_LIMIT", "3GB"
                )
                self.DUCKDB_THREADS = getattr(settings, "DUCKDB_THREADS", None)

        # Get pool size from settings
        pool_size = getattr(settings, "DUCKLAKE_POOL_SIZE", 2)
        self._pool_size = pool_size
        self._pin_snapshot = settings.DUCKLAKE_PIN_SNAPSHOT
        self._refresh_interval = settings.DUCKLAKE_SNAPSHOT_REFRESH_SECONDS

        super().init(SettingsWrapper())


# Singleton pool instance
ducklake_pool = GeoAPIDuckLakePool(pool_size=2, application_name="goat-geoapi-ducklake")
