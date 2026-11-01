import os
from pathlib import Path

from goatlib.api.root_path import normalize_root_path
from goatlib.auth import AuthFlag, require_keycloak_url
from pydantic import AliasChoices, Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class CatalogSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="CATALOG_", populate_by_name=True)

    data_dir: Path = Path(os.environ.get("DATA_DIR", "/app/data")) / "catalog"
    # The mirror is two files, written by goatlib's sync task. Named
    # distinctly from the *published* items/collections so both can share a
    # directory during a sync.
    items_file: str = "mirror_items.parquet"
    collections_file: str = "mirror_collections.parquet"
    nuts_file: str = "nuts.parquet"
    version_file: str = "VERSION"
    # Path prefix when served behind a path-routing gateway (e.g. "/catalog").
    # Empty = served from "/" of its own host. Reads the repo-wide ROOT_PATH,
    # with a catalog-only override. See goatlib.api.root_path.
    root_path: str = Field(
        default="",
        validation_alias=AliasChoices("CATALOG_ROOT_PATH", "ROOT_PATH"),
    )

    # DuckDB tuning. The catalog view is scanned from disk per request, so
    # memory is spent on query intermediates rather than resident data.
    #
    # `duckdb_temp_dir` must point at writable *local* disk: it is the spill
    # target that turns a heavy concurrent moment into a slower query instead
    # of an OutOfMemoryException (an in-memory database has no spill target
    # unless this is set). The two limits are unset by default, keeping
    # DuckDB's own (80% of available RAM, one thread per core); set them in a
    # container to keep peak usage under the pod's limit -- measured at the 1M
    # item target, eight concurrent searches peak around 3.5 GB unbounded.
    duckdb_temp_dir: Path = (
        Path(os.environ.get("TMPDIR", "/tmp")) / "goat-catalog-duckdb"
    )
    duckdb_memory_limit: str | None = None
    duckdb_threads: int | None = None

    # The repo-wide single switch (see AGENTS.md): unlike every other field
    # here, this reads the bare `AUTH` env var, NOT `CATALOG_AUTH` -- an
    # explicit validation_alias bypasses env_prefix for just this field
    # (CATALOG_AUTH is kept as a fallback alias for a catalog-only override).
    auth: AuthFlag = Field(
        default=True, validation_alias=AliasChoices("AUTH", "CATALOG_AUTH")
    )
    # Repo-wide Keycloak config (see .env.example): read the bare env var by
    # default, but let a CATALOG_-prefixed variant override it -- unlike
    # `auth` above, a per-service Keycloak endpoint override is a legitimate
    # deployment need, so the catalog-specific alias is checked FIRST.
    # Required when auth is on (see _require_keycloak).
    keycloak_server_url: str = Field(
        default="",
        validation_alias=AliasChoices(
            "CATALOG_KEYCLOAK_SERVER_URL", "KEYCLOAK_SERVER_URL"
        ),
    )
    realm_name: str = Field(
        default="p4b",
        validation_alias=AliasChoices("CATALOG_REALM_NAME", "REALM_NAME"),
    )
    # Comma-separated Keycloak client IDs whose tokens are accepted (the
    # token's `azp`); empty accepts every client of the realm. Like `auth`,
    # this reads the bare repo-wide name.
    auth_allowed_clients: str = Field(
        default="", validation_alias="AUTH_ALLOWED_CLIENTS"
    )

    # CORS origins for the browser-facing API (mirrors geoapi/processes'
    # `CORS_ORIGINS`, api spec/I2): bare env var by default like
    # keycloak_server_url above, with a catalog-only override available.
    #
    # Left empty, this derives to `[goat_ui_base_url]` (see the validator
    # below) rather than `["*"]`. The reads are public, but the *browser*
    # callers we serve are the GOAT catalog page's, and a wildcard would let
    # any site's JavaScript use this API as its own backend. Note CORS only
    # constrains browsers -- QGIS, pystac-client and other STAC tooling are
    # unaffected by this, so a narrow list costs nothing for the
    # standards-compliance story.
    cors_origins: list[str] = Field(
        default_factory=list,
        validation_alias=AliasChoices("CATALOG_CORS_ORIGINS", "CORS_ORIGINS"),
    )

    # Base URL of the GOAT web app. Served items/collections carry an
    # `alternate` "Open in GOAT" link built from this, which is the path from
    # public metadata to the usable dataset (design S14). Follows the same
    # bare-env-var-with-catalog-override pattern as the settings above.
    goat_ui_base_url: str = Field(
        default="http://localhost:3000",
        validation_alias=AliasChoices(
            "CATALOG_GOAT_UI_BASE_URL", "NEXT_PUBLIC_APP_URL", "GOAT_UI_BASE_URL"
        ),
    )

    # ------------------------------------------------------------------
    # Data preview (`GET /stac/items/{id}/preview`)
    #
    # The one place this service reads anything but its local files: a
    # bounded sample of an item's GeoParquet, read from the catalog bucket.
    #
    # Credentials are the repo-wide `S3_*` ones, not preview-specific: there
    # is one catalog bucket and the sync task already reads it with these. The
    # only value this service needs that no shared variable carries is *which*
    # bucket -- until now that was a Windmill task parameter, so it becomes an
    # env var both sides can read.
    # ------------------------------------------------------------------
    s3_catalog_bucket: str | None = Field(
        default=None,
        validation_alias=AliasChoices("CATALOG_S3_BUCKET", "S3_CATALOG_BUCKET"),
    )
    s3_endpoint_url: str | None = Field(
        default=None,
        validation_alias=AliasChoices("CATALOG_S3_ENDPOINT_URL", "S3_ENDPOINT_URL"),
    )
    s3_access_key_id: str | None = Field(
        default=None,
        validation_alias=AliasChoices("CATALOG_S3_ACCESS_KEY_ID", "S3_ACCESS_KEY_ID"),
    )
    s3_secret_access_key: str | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "CATALOG_S3_SECRET_ACCESS_KEY", "S3_SECRET_ACCESS_KEY"
        ),
    )
    s3_region: str = Field(
        default="us-east-1",
        validation_alias=AliasChoices("CATALOG_S3_REGION", "S3_REGION"),
    )
    #: Ceiling on a served asset. A read is whole-object (DuckDB, not a range
    #: request), so this is what stands between one malformed object and the
    #: pod's memory. Generous against the real corpus: the largest thumbnail is
    #: a few hundred KB and a style is under 1 KB.
    assets_max_bytes: int = 5 * 1024 * 1024
    #: How long a client may treat a thumbnail or style as fresh. Long, and
    #: paired with the store's ETag: the object cannot change without a harvest,
    #: and a harvest changes the ETag, so a stale copy revalidates into a 304.
    assets_max_age_seconds: int = 86400
    #: Feature ceiling. Not a size limit -- `preview_max_bytes` below is that.
    #: A preview is a taste of the data, not a download, and the read is what
    #: costs: see `_sample_sql` for what larger samples were measured to cost
    #: against the real bucket.
    preview_max_features: int = 100
    #: Byte ceiling on the rendered GeoJSON, applied after simplification.
    #: Measured on the real catalog: per-feature payload spans 0.07-66.7 KB
    #: (~950x), and file size does not predict it, so a feature count alone
    #: bounds nothing -- 100 raw features of one dataset came to 6.4 MB.
    #:
    #: Uncompressed, and it bounds the *read* (`_collect`), not just the
    #: response: the rows are held as Python objects at ~5x their serialised
    #: size and the handler is synchronous, so the threadpool can have many in
    #: flight. The wire cost is ~10-13x less than this.
    preview_max_bytes: int = 2 * 1024 * 1024
    #: Assumed raster width, in pixels, of the map the preview is drawn on.
    #: The simplification tolerance is the item's extent divided by this, i.e.
    #: "do not send coordinates finer than a pixel" -- worth 24-174x on the
    #: heaviest geometries at no cost in visible detail.
    preview_render_width_px: int = 800
    #: Where rendered previews are cached, **unset by default: no server-side
    #: cache at all**.
    #:
    #: A preview is fixed for the life of a mirror generation, so the caching
    #: that matters is the client's -- the route sends a long `max-age` plus
    #: the store's ETag, which makes a browser (and any edge cache put in
    #: front later) do the work for free. A server-side cache adds a resource
    #: to size in every pod: in the heap it is charged against the memory
    #: limit alongside DuckDB's working set, and on local disk it consumes
    #: ephemeral storage, which is what gets pods evicted when a node fills.
    #:
    #: Set it to enable caching -- ideally a writable shared volume, so one
    #: render serves every replica. The mirror volume cannot be it (mounted
    #: read-only, design S8). No deployment sets it today, so the cost below
    #: is what every request pays, not what the first one does.
    preview_cache_dir: Path | None = None
    #: Disk budget when a cache directory is set. At ~68 KB median, 1 GB holds
    #: roughly 15,000 items -- more than the current catalog.
    preview_cache_max_bytes: int = 1024 * 1024 * 1024
    #: How long a client may treat a preview as fresh. Long because the body
    #: cannot change until a sync swaps the mirror, and a sync changes the
    #: ETag, so a client that kept a stale copy revalidates into a 304.
    preview_max_age_seconds: int = 86400

    @property
    def assets_enabled(self) -> bool:
        """Serving thumbnails and styles needs the same bucket the preview does."""
        return self.preview_enabled

    @property
    def preview_enabled(self) -> bool:
        """Previews need a bucket and credentials; without them, 404."""
        return bool(
            self.s3_catalog_bucket
            and self.s3_access_key_id
            and self.s3_secret_access_key
        )

    @field_validator("root_path", mode="before")
    @classmethod
    def _normalize_root_path(cls, value: str | None) -> str:
        return normalize_root_path(value)

    @model_validator(mode="after")
    def _require_keycloak(self) -> "CatalogSettings":
        require_keycloak_url(self.auth, self.keycloak_server_url)
        return self

    @model_validator(mode="after")
    def _default_cors_to_goat_ui(self) -> "CatalogSettings":
        """Fall back to the GOAT UI's own origin when no origins are set."""
        if not self.cors_origins:
            self.cors_origins = [self.goat_ui_base_url.rstrip("/")]
        return self

    @property
    def items_path(self) -> Path:
        return self.data_dir / self.items_file

    @property
    def collections_path(self) -> Path:
        return self.data_dir / self.collections_file

    @property
    def nuts_path(self) -> Path:
        return self.data_dir / self.nuts_file

    @property
    def version_path(self) -> Path:
        return self.data_dir / self.version_file
