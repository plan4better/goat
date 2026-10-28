"""Thumbnail Generation Task - Generate thumbnails for projects and layers.

This task runs on a schedule to generate PNG thumbnails for projects and layers.
Uses Playwright to render a map view and hash-based change detection.

For map layers (feature/raster):
- Renders using the frontend /thumbnail route via Playwright

For table layers:
- Renders a spreadsheet-style preview using matplotlib
- Shows first 4 columns and 4 rows of data

The task:
1. Queries PostgreSQL for projects/layers updated in the last N hours (default: 12)
2. Computes a content hash for each item (basemap + bounds + layer styles)
3. Compares hash with the hash embedded in existing thumbnail URL
4. If hash differs, regenerates thumbnail
5. Uploads new thumbnails to S3 (filename includes hash)
6. Updates database with new thumbnail_url
7. Deletes old thumbnails from S3

Usage:
    # As Windmill scheduled task (every 15 minutes):
    # Configured in registry with schedule="*/15 * * * *"

    # Manual execution:
    from goatlib.tasks.generate_thumbnails import ThumbnailTaskParams, main
    result = main(ThumbnailTaskParams(batch_size=50))

    # To process all items (not just recent):
    result = main(ThumbnailTaskParams(fetch_all=True))
"""

import asyncio
import base64
import hashlib
import io
import json
import logging
import math
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Literal, Self
from uuid import UUID

from pydantic import BaseModel, Field

from goatlib.style.compute import without_stamps
from goatlib.style.defaults import default_style
from goatlib.style.map_rows import GroupRow, LayerRow, build_map_document, drawn_layers
from goatlib.style.migrate import context_for

logger = logging.getLogger(__name__)

# Thumbnail dimensions (same as frontend route)
THUMBNAIL_WIDTH = 800
THUMBNAIL_HEIGHT = 450

# Table thumbnail settings
TABLE_THUMBNAIL_MAX_COLUMNS = 4
TABLE_THUMBNAIL_MAX_ROWS = 4
TABLE_THUMBNAIL_COLUMN_NAME_MAX_LEN = 15
TABLE_THUMBNAIL_CELL_VALUE_MAX_LEN = 25

# S3 paths for thumbnails
THUMBNAIL_DIR_PROJECT = "thumbnails/projects/"
THUMBNAIL_DIR_LAYER = "thumbnails/layers/"
THUMBNAIL_DIR_BUNDLE = "thumbnails/bundles/"

# Default thumbnail for table layers with no data/columns: artwork the web app
# ships, stored root-relative so it resolves on whichever host serves GOAT.
DEFAULT_TABLE_THUMBNAIL_URL = "/assets/img/goat_new_dataset_thumbnail.png"
# Every form the default is stored in; rows written with the hosted CDN URL
# still carry the default.
DEFAULT_TABLE_THUMBNAIL_URLS = frozenset(
    {
        DEFAULT_TABLE_THUMBNAIL_URL,
        "https://assets.plan4better.de/img/goat_new_dataset_thumbnail.png",
    }
)

# Default timeout for Playwright
DEFAULT_PAGE_TIMEOUT = 60000  # 60 seconds
DEFAULT_RENDER_TIMEOUT = 30000  # 30 seconds

# Default lookback period for finding items to check
DEFAULT_HOURS_LOOKBACK = 12


class ThumbnailTaskParams(BaseModel):
    """Parameters for thumbnail generation task."""

    batch_size: int = Field(
        default=50,
        description="Maximum number of items to process per run",
    )
    include_projects: bool = Field(
        default=True,
        description="Generate thumbnails for projects",
    )
    include_layers: bool = Field(
        default=True,
        description="Generate thumbnails for feature/raster layers (map thumbnails)",
    )
    include_table_layers: bool = Field(
        default=True,
        description="Generate thumbnails for table layers (spreadsheet-style thumbnails)",
    )
    include_bundles: bool = Field(
        default=True,
        description="Generate thumbnails for bundles (every member layer on one map)",
    )
    project_ids: list[str] = Field(
        default_factory=list,
        description="Specific project UUIDs to generate thumbnails for (forces regeneration)",
    )
    bundle_ids: list[str] = Field(
        default_factory=list,
        description="Specific bundle UUIDs to generate thumbnails for (forces regeneration)",
    )
    layer_ids: list[str] = Field(
        default_factory=list,
        description="Specific layer UUIDs to generate thumbnails for (forces regeneration)",
    )
    force_regenerate: bool = Field(
        default=False,
        description="Regenerate all thumbnails, ignoring hash comparison",
    )
    max_concurrent: int = Field(
        default=5,
        description="Maximum concurrent thumbnail generations",
    )
    use_bounds: bool = Field(
        default=True,
        description="Use fitBounds to show all content (True) or use stored view state (False)",
    )
    hours_lookback: int = Field(
        default=DEFAULT_HOURS_LOOKBACK,
        description="Only check items updated within the last N hours (optimization)",
    )
    fetch_all: bool = Field(
        default=False,
        description="Fetch all items regardless of updated_at (ignores hours_lookback)",
    )
    dry_run: bool = Field(
        default=False,
        description="Test mode: only test DB connection and fetch items without generating thumbnails",
    )


class ThumbnailResult(BaseModel):
    """Result of thumbnail generation for a single item."""

    item_type: Literal["project", "layer", "bundle"]
    item_id: str
    layer_type: Literal["feature", "raster", "table"] | None = None  # Only for layers
    success: bool
    thumbnail_url: str | None = None
    error: str | None = None


class ThumbnailTaskOutput(BaseModel):
    """Output from thumbnail generation task."""

    total_processed: int
    projects_processed: int
    layers_processed: int  # Total layers (feature + raster + table)
    bundles_processed: int = 0
    feature_layers_processed: int = 0
    raster_layers_processed: int = 0
    table_layers_processed: int = 0
    success_count: int
    error_count: int
    errors: list[str] = Field(default_factory=list)


def _json(value: Any) -> Any:
    """A JSONB column read as text (see the queries) as Python."""
    return json.loads(value) if isinstance(value, str) else value


#: What the thumbnail page reads of a layer's `other_properties`: a map
#: service's tile size and layer names.
_SERVICE_KEYS = ("tile_size", "layers")


def layer_payload(row: dict[str, Any]) -> dict[str, Any]:
    """One layer as the thumbnail page draws it, with its style: the project
    layer's active style, else the dataset's default, else the default style."""
    style = _json(row.get("style")) or _json(row.get("default_style"))
    if not isinstance(style, dict):
        style = default_style(
            context_for(
                row["type"],
                row.get("feature_layer_geometry_type"),
                row.get("data_type"),
            ),
            seed=str(row["layer_id"]),
        )
    other = _json(row.get("other_properties"))
    folder_id = row.get("folder_id")
    # The page has no time slider: the stored step travels with the layer (none stored, every time shows).
    time_value = _json(row.get("time_value"))
    entry = {"entry": {"time": {"value": time_value}}} if time_value is not None else {}
    return {
        "id": row.get("layer_project_id") or str(row["layer_id"]),
        "layer_id": str(row["layer_id"]),
        "name": row.get("name"),
        "type": row["type"],
        "feature_layer_geometry_type": row.get("feature_layer_geometry_type"),
        "url": row.get("url"),
        "data_type": row.get("data_type"),
        "other_properties": {
            k: other[k] for k in _SERVICE_KEYS if isinstance(other, dict) and k in other
        },
        "extent": row.get("extent"),
        "folder_id": str(folder_id) if folder_id else None,
        "query": None,
        "visible": True,
        "style": style,
        **entry,
    }


def project_layer_payload(
    groups: list[dict[str, Any]], links: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """A project's drawn layers, top first, in the order and with the visibility
    of its map document. Tables draw nothing and are left out."""
    drawable = {row["layer_project_id"]: row for row in links if row["type"] != "table"}
    document = build_map_document(
        basemap=None,
        locale=None,
        view_state=None,
        bounds=None,
        groups=[
            GroupRow(
                g["id"],
                g["name"],
                g["parent_id"],
                g["order"],
                g["visible"],
                g["expanded"],
            )
            for g in groups
        ],
        layers=[
            LayerRow(
                row["layer_project_id"],
                row["group_id"],
                row["order"],
                row["visible"],
                "top",
                None,
                None,
                True,
                None,
            )
            for row in drawable.values()
        ],
    )
    return [layer_payload(drawable[entry["id"]]) for entry in drawn_layers(document)]


@dataclass
class ItemToProcess:
    """Information about an item needing thumbnail generation.

    Handles both projects and all layer types (feature, raster, table).
    For table layers, uses matplotlib rendering instead of Playwright.
    """

    type: Literal["project", "layer", "bundle"]
    id: UUID
    updated_at: datetime
    old_thumbnail_url: str | None
    # Layer type (only for layers, not projects)
    layer_type: Literal["feature", "raster", "table"] | None = None
    # Additional data for map rendering (feature/raster layers and projects)
    basemap: str = "light"
    view_state: dict | None = None
    layers: list[dict] = field(default_factory=list)
    bounds: list[float] | None = None  # [west, south, east, north]
    use_bounds: bool = True  # Whether to use fitBounds or viewState
    # Hash of visual content for change detection
    content_hash: str = ""

    def compute_content_hash(self: Self) -> str:
        """Compute a hash of the visual content that affects the thumbnail.

        For projects and feature/raster layers:
        - basemap style, view_state, bounds, the layers in drawing order with
          their styles (without computed stamps: a recompute that only moves
          the stamps draws the same map)

        For table layers:
        - layer ID (schema is queried from DuckLake at render time)

        This allows us to detect when the thumbnail needs regeneration
        by comparing with the hash in the existing thumbnail URL.
        """
        if self.layer_type == "table":
            # Table layers: hash based on layer ID
            # Note: If table schema changes, updated_at should change too
            content = {
                "type": "table",
                "layer_id": str(self.id),
            }
        else:
            # Projects and feature/raster layers: hash based on visual content
            content = {
                "basemap": self.basemap,
                "view_state": self.view_state,
                "bounds": self.bounds,
                "layers": [],
            }

            for layer in self.layers:
                content["layers"].append(
                    {
                        "layer_id": layer.get("layer_id"),
                        "type": layer.get("type"),
                        "visible": layer.get("visible", True),
                        "style": without_stamps(layer.get("style")),
                    }
                )

        # Create deterministic JSON and hash it
        json_str = json.dumps(content, sort_keys=True, separators=(",", ":"))
        hash_value = hashlib.sha256(json_str.encode()).hexdigest()[:12]
        return hash_value

    @staticmethod
    def extract_hash_from_url(thumbnail_url: str | None) -> str | None:
        """Extract the content hash from an existing thumbnail URL.

        URL format: thumbnails/{type}s/{id}_{hash}.png
        """
        if not thumbnail_url:
            return None

        # Match pattern: {uuid}_{hash}.png
        match = re.search(
            r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_([a-f0-9]+)\.png",
            thumbnail_url,
            re.IGNORECASE,
        )
        if match:
            return match.group(1)
        return None

    def needs_regeneration(self: Self) -> bool:
        """Check if thumbnail needs regeneration based on content hash."""
        if not self.content_hash:
            self.content_hash = self.compute_content_hash()

        existing_hash = self.extract_hash_from_url(self.old_thumbnail_url)

        # Regenerate if no existing thumbnail or hash doesn't match
        return existing_hash != self.content_hash


class ThumbnailGeneratorTask:
    """Task to generate thumbnails for projects and layers.

    Uses Playwright to render the /thumbnail route for projects and feature/raster layers.
    For table layers, uses matplotlib to render a spreadsheet-style preview.
    Designed to run as a Windmill scheduled task.
    """

    def __init__(self: Self) -> None:
        self.settings: Any | None = None
        self._browser = None
        self._playwright = None
        self._pg_pool: Any | None = None
        self._s3_client: Any | None = None
        self._ducklake_manager: Any | None = None

    @staticmethod
    def _configure_logging_for_windmill() -> None:
        """Configure Python logging to output to stdout for Windmill."""
        import sys

        root_logger = logging.getLogger()
        root_logger.setLevel(logging.INFO)

        for handler in root_logger.handlers[:]:
            root_logger.removeHandler(handler)

        handler = logging.StreamHandler(sys.stdout)
        handler.setLevel(logging.INFO)
        handler.setFormatter(
            logging.Formatter("%(name)s - %(levelname)s - %(message)s")
        )
        root_logger.addHandler(handler)

    def init_from_env(self: Self) -> None:
        """Initialize settings from environment variables and Windmill secrets."""
        from goatlib.tools.base import ToolSettings

        self._configure_logging_for_windmill()
        self.settings = ToolSettings.from_env()

    async def _get_pg_pool(self: Self) -> Any:
        """Get or create asyncpg connection pool."""
        if self._pg_pool is None:
            import asyncpg

            from goatlib.config.postgres import TASKS_APPLICATION_NAME

            if not self.settings:
                raise RuntimeError("Call init_from_env() before running task")

            logger.info(
                f"Creating PostgreSQL connection pool to {self.settings.postgres_server}:{self.settings.postgres_port}"
            )
            try:
                self._pg_pool = await asyncio.wait_for(
                    asyncpg.create_pool(
                        **self.settings.postgres_connect_args(TASKS_APPLICATION_NAME),
                        min_size=1,
                        max_size=5,
                        command_timeout=60,  # 60 seconds per query
                    ),
                    timeout=30,  # 30 seconds to establish connection pool
                )
                logger.info("PostgreSQL connection pool created successfully")
            except asyncio.TimeoutError:
                logger.error(
                    f"Timeout connecting to PostgreSQL at "
                    f"{self.settings.postgres_server}:{self.settings.postgres_port}"
                )
                raise RuntimeError(
                    f"Timeout connecting to PostgreSQL at "
                    f"{self.settings.postgres_server}:{self.settings.postgres_port}"
                )
            except Exception as e:
                logger.error(f"Failed to connect to PostgreSQL: {e}")
                raise
        return self._pg_pool

    def _get_s3_client(self: Self) -> Any:
        """Get or create S3 client."""
        if self._s3_client is None:
            if not self.settings:
                raise RuntimeError("Call init_from_env() before running task")
            self._s3_client = self.settings.get_s3_client()
        return self._s3_client

    def _get_s3_bucket(self: Self) -> str:
        """Get the S3 bucket name from settings."""
        if not self.settings:
            raise RuntimeError("Call init_from_env() before running task")
        return self.settings.s3_bucket_name

    async def _get_browser(self: Self):  # noqa: ANN202
        """Get or create Playwright browser instance."""
        if self._browser is None:
            from playwright.async_api import async_playwright

            from goatlib.utils.browser_trust import ensure_extra_ca_trusted

            ensure_extra_ca_trusted()
            self._playwright = await async_playwright().start()
            self._browser = await self._playwright.chromium.launch(
                headless=True,
                args=[
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-dev-shm-usage",
                    # Enable WebGL for MapLibre (software rendering)
                    "--enable-unsafe-swiftshader",
                    "--use-gl=swiftshader",
                    "--use-angle=swiftshader",
                    "--ignore-gpu-blocklist",
                ],
            )
        return self._browser

    async def _close_browser(self: Self) -> None:
        """Close browser and playwright instances."""
        if self._browser:
            await self._browser.close()
            self._browser = None
        if self._playwright:
            await self._playwright.stop()
            self._playwright = None

    async def _close_pg_pool(self: Self) -> None:
        """Close PostgreSQL connection pool."""
        if self._pg_pool:
            await self._pg_pool.close()
            self._pg_pool = None

    def _close_ducklake(self: Self) -> None:
        """Close DuckLake connection."""
        if self._ducklake_manager:
            self._ducklake_manager.close()
            self._ducklake_manager = None

    def _get_ducklake_manager(self: Self) -> Any:
        """Get or create DuckLake manager for querying table data."""
        if self._ducklake_manager is None:
            from goatlib.config.postgres import TASKS_APPLICATION_NAME
            from goatlib.storage.ducklake import BaseDuckLakeManager

            if not self.settings:
                raise RuntimeError("Call init_from_env() before running task")

            manager = BaseDuckLakeManager(
                read_only=True, application_name=TASKS_APPLICATION_NAME
            )
            manager.init_from_params(
                postgres_uri=self.settings.ducklake_postgres_uri,
                storage_path=self.settings.ducklake_data_dir,
                catalog_schema=self.settings.ducklake_catalog_schema,
                s3_endpoint=self.settings.s3_endpoint_url,
                s3_access_key=self.settings.s3_access_key_id,
                s3_secret_key=self.settings.s3_secret_access_key,
            )
            self._ducklake_manager = manager
        return self._ducklake_manager

    async def _fetch_projects_to_update(
        self: Self,
        limit: int,
        project_ids: list[str] | None = None,
        use_bounds: bool = True,
        since: datetime | None = None,
    ) -> list[ItemToProcess]:
        """Fetch projects for thumbnail processing.

        Hash-based change detection is done later - this just fetches candidates.

        Args:
            limit: Maximum number of projects to fetch
            project_ids: If provided, fetch only these specific projects
            use_bounds: Whether to use fitBounds or viewState for thumbnails
            since: If provided, only fetch projects updated after this time
        """
        pool = await self._get_pg_pool()

        async with pool.acquire() as conn:
            # Fetch projects with their initial view state
            if project_ids:
                # Fetch specific projects by ID
                rows = await conn.fetch(
                    """
                    SELECT
                        p.id,
                        p.updated_at,
                        p.thumbnail_url,
                        p.basemap,
                        up.initial_view_state
                    FROM customer.project p
                    LEFT JOIN customer.user_project up ON p.id = up.project_id
                    WHERE p.id = ANY($1::uuid[])
                    ORDER BY p.updated_at DESC
                    LIMIT $2
                    """,
                    project_ids,
                    limit,
                )
            elif since:
                # Fetch projects updated since the given time
                rows = await conn.fetch(
                    """
                    SELECT
                        p.id,
                        p.updated_at,
                        p.thumbnail_url,
                        p.basemap,
                        up.initial_view_state
                    FROM customer.project p
                    LEFT JOIN customer.user_project up ON p.id = up.project_id
                    WHERE p.updated_at > $1
                    ORDER BY p.updated_at DESC
                    LIMIT $2
                    """,
                    since,
                    limit,
                )
            else:
                # Fetch all projects (hash comparison will filter unchanged)
                rows = await conn.fetch(
                    """
                    SELECT
                        p.id,
                        p.updated_at,
                        p.thumbnail_url,
                        p.basemap,
                        up.initial_view_state
                    FROM customer.project p
                    LEFT JOIN customer.user_project up ON p.id = up.project_id
                    ORDER BY p.updated_at DESC
                    LIMIT $1
                    """,
                    limit,
                )

            items = []
            for row in rows:
                # Parse initial view state
                view_state = None
                if row["initial_view_state"]:
                    try:
                        ivs = row["initial_view_state"]
                        if isinstance(ivs, str):
                            ivs = json.loads(ivs)
                        view_state = {
                            "latitude": ivs.get("latitude", 48.13),
                            "longitude": ivs.get("longitude", 11.57),
                            "zoom": ivs.get("zoom", 10),
                            "bearing": ivs.get("bearing", 0),
                            "pitch": ivs.get("pitch", 0),
                        }
                    except Exception as e:
                        logger.warning(
                            f"Failed to parse view state for project {row['id']}: {e}"
                        )

                # Fetch layers for this project
                layers = await self._fetch_project_layers(conn, row["id"])

                # For projects: use initial_view_state (what user sees when opening project)
                # Only fall back to layer bounds if no view state is set
                project_use_bounds = False
                bounds = None
                if not view_state:
                    # No view state saved - compute bounds from visible layers as fallback
                    bounds = self._compute_bounds_from_layers(layers)
                    project_use_bounds = bounds is not None

                items.append(
                    ItemToProcess(
                        type="project",
                        id=row["id"],
                        updated_at=row["updated_at"],
                        old_thumbnail_url=row["thumbnail_url"],
                        basemap=row["basemap"] or "light",
                        view_state=view_state,
                        layers=layers,
                        bounds=bounds,
                        use_bounds=project_use_bounds,
                    )
                )

            return items

    async def _fetch_project_layers(
        self: Self, conn: Any, project_id: UUID
    ) -> list[dict]:
        """A project's drawn layers in the format needed for rendering: visible
        layers in visible groups, top first (`project_layer_payload`).

        Note: JSONB columns are cast to ::text to avoid asyncpg type introspection
        timeouts that can occur with large JSONB columns.
        """
        groups = await conn.fetch(
            """
            SELECT id, name, parent_id, "order", visible, expanded
            FROM customer.layer_project_group
            WHERE project_id = $1
            """,
            project_id,
        )
        rows = await conn.fetch(
            """
            SELECT
                lp.id AS layer_project_id,
                lp.layer_id,
                lp.layer_project_group_id AS group_id,
                lp."order",
                lp.visible,
                lp.time_value::text AS time_value,
                l.name,
                l.type,
                l.feature_layer_geometry_type,
                l.url,
                l.data_type,
                l.other_properties::text AS other_properties,
                l.extent::text AS extent,
                l.folder_id,
                (SELECT s.document::text FROM customer.layer_style s
                 WHERE s.layer_project_id = lp.id
                 ORDER BY s.id = lp.active_style_id DESC NULLS LAST,
                          s.position, s.created_at
                 LIMIT 1) AS style,
                (SELECT d.document::text FROM customer.layer_style d
                 WHERE d.layer_id = l.id) AS default_style
            FROM customer.layer_project lp
            JOIN customer.layer l ON lp.layer_id = l.id
            WHERE lp.project_id = $1
            """,
            project_id,
        )
        return project_layer_payload([dict(g) for g in groups], [dict(r) for r in rows])

    async def _fetch_bundle_layers(
        self: Self, conn: Any, bundle_id: UUID
    ) -> list[dict]:
        """A bundle's member layers, in the shape the thumbnail route renders.

        Only the members that can be drawn: a GTFS feed is mostly tables
        (agency, calendar, trips), and those carry no geometry. Ordered
        lines-then-points so a node is not drawn beneath the edge it joins —
        the same order the bundle's preview map uses, because the thumbnail is
        meant to be that map.
        """
        rows = await conn.fetch(
            """
            SELECT
                l.id,
                l.name,
                l.type,
                l.feature_layer_geometry_type,
                l.url,
                l.data_type,
                l.other_properties::text AS other_properties,
                l.extent::text as extent,
                l.folder_id,
                (SELECT d.document::text FROM customer.layer_style d
                 WHERE d.layer_id = l.id) AS default_style
            FROM customer.bundle_layer bl
            JOIN customer.layer l ON l.id = bl.layer_id
            WHERE bl.bundle_id = $1
              AND l.type IN ('feature', 'raster')
            ORDER BY
                CASE l.feature_layer_geometry_type
                    WHEN 'polygon' THEN 0
                    WHEN 'line' THEN 1
                    WHEN 'point' THEN 2
                    ELSE 1
                END,
                l.id
            """,
            bundle_id,
        )

        return [layer_payload({**dict(row), "layer_id": row["id"]}) for row in rows]

    async def _fetch_bundles_to_update(
        self: Self,
        limit: int,
        bundle_ids: list[str] | None = None,
        use_bounds: bool = True,
        since: datetime | None = None,
    ) -> list[ItemToProcess]:
        """Fetch bundles for thumbnail processing.

        A bundle has no geometry of its own — its picture is every member drawn
        together, which is why this gathers layers the way a project does
        rather than rendering one of them.

        `updated_at` on the bundle moves when the bundle does, not when a
        member's data changes; the content hash covers the rest, since it is
        computed from the members' own styles and extents.
        """
        pool = await self._get_pg_pool()

        async with pool.acquire() as conn:
            if bundle_ids:
                rows = await conn.fetch(
                    """
                    SELECT b.id, b.updated_at, b.thumbnail_url
                    FROM customer.bundle b
                    WHERE b.id = ANY($1::uuid[])
                    ORDER BY b.updated_at DESC
                    LIMIT $2
                    """,
                    bundle_ids,
                    limit,
                )
            elif since:
                # A member's edit is what changes a bundle's picture, so the
                # window is checked against the members too — a bundle row
                # untouched since import would otherwise never be revisited.
                rows = await conn.fetch(
                    """
                    SELECT DISTINCT b.id, b.updated_at, b.thumbnail_url
                    FROM customer.bundle b
                    LEFT JOIN customer.bundle_layer bl ON bl.bundle_id = b.id
                    LEFT JOIN customer.layer l ON l.id = bl.layer_id
                    WHERE b.updated_at > $1 OR l.updated_at > $1
                    ORDER BY b.updated_at DESC
                    LIMIT $2
                    """,
                    since,
                    limit,
                )
            else:
                rows = await conn.fetch(
                    """
                    SELECT b.id, b.updated_at, b.thumbnail_url
                    FROM customer.bundle b
                    ORDER BY b.updated_at DESC
                    LIMIT $1
                    """,
                    limit,
                )

            items: list[ItemToProcess] = []
            for row in rows:
                layers = await self._fetch_bundle_layers(conn, row["id"])
                if not layers:
                    # Nothing drawable — an import that is still running, or a
                    # type whose members are all tabular. The borrowed member
                    # thumbnail stands in.
                    continue

                bounds = self._compute_bounds_from_layers(layers)
                item = ItemToProcess(
                    type="bundle",
                    id=row["id"],
                    updated_at=row["updated_at"],
                    old_thumbnail_url=row["thumbnail_url"],
                    basemap="light",
                    view_state=self._calculate_view_state_from_bounds(bounds),
                    layers=layers,
                    bounds=bounds,
                    use_bounds=use_bounds and bounds is not None,
                )
                item.content_hash = item.compute_content_hash()
                items.append(item)

        return items

    async def _fetch_layers_to_update(
        self: Self,
        limit: int,
        layer_ids: list[str] | None = None,
        use_bounds: bool = True,
        since: datetime | None = None,
    ) -> list[ItemToProcess]:
        """Fetch layers that need thumbnail updates with all required data.

        Args:
            limit: Maximum number of layers to fetch
            layer_ids: If provided, fetch only these specific layers
            use_bounds: If True, use fitBounds with layer extent instead of center/zoom
            since: If provided, only fetch layers updated after this time

        Excludes:
        - Table-only layers (no geometry)
        - Street network layers (special type)

        Note: JSONB columns are cast to ::text to avoid asyncpg type introspection
        timeouts that can occur with large JSONB columns.
        """
        pool = await self._get_pg_pool()

        async with pool.acquire() as conn:
            if layer_ids:
                # Fetch specific layers by ID
                rows = await conn.fetch(
                    """
                    SELECT
                        id,
                        name,
                        type,
                        feature_layer_geometry_type,
                        url,
                        data_type,
                        other_properties::text AS other_properties,
                        (SELECT d.document::text FROM customer.layer_style d
                         WHERE d.layer_id = customer.layer.id) AS default_style,
                        extent::text as extent,
                        folder_id,
                        updated_at,
                        thumbnail_url
                    FROM customer.layer
                    WHERE id = ANY($1::uuid[])
                      AND type IN ('feature', 'raster')
                      AND (feature_layer_type IS NULL OR feature_layer_type != 'street_network')
                    ORDER BY updated_at DESC
                    LIMIT $2
                    """,
                    layer_ids,
                    limit,
                )
            elif since:
                # Fetch layers updated since the given time
                rows = await conn.fetch(
                    """
                    SELECT
                        id,
                        name,
                        type,
                        feature_layer_geometry_type,
                        url,
                        data_type,
                        other_properties::text AS other_properties,
                        (SELECT d.document::text FROM customer.layer_style d
                         WHERE d.layer_id = customer.layer.id) AS default_style,
                        extent::text as extent,
                        folder_id,
                        updated_at,
                        thumbnail_url
                    FROM customer.layer
                    WHERE updated_at > $1
                      AND type IN ('feature', 'raster')
                      AND (feature_layer_type IS NULL OR feature_layer_type != 'street_network')
                    ORDER BY updated_at DESC
                    LIMIT $2
                    """,
                    since,
                    limit,
                )
            else:
                # Fetch all layers (hash comparison determines what needs updating)
                rows = await conn.fetch(
                    """
                    SELECT
                        id,
                        name,
                        type,
                        feature_layer_geometry_type,
                        url,
                        data_type,
                        other_properties::text AS other_properties,
                        (SELECT d.document::text FROM customer.layer_style d
                         WHERE d.layer_id = customer.layer.id) AS default_style,
                        extent::text as extent,
                        folder_id,
                        updated_at,
                        thumbnail_url
                    FROM customer.layer
                    WHERE type IN ('feature', 'raster')
                      AND (feature_layer_type IS NULL OR feature_layer_type != 'street_network')
                    ORDER BY updated_at DESC
                    LIMIT $1
                    """,
                    limit,
                )

            items = []
            for row in rows:
                # Parse extent to bounds
                bounds = self._parse_extent_to_bounds(row["extent"])

                # Calculate view state from bounds
                view_state = self._calculate_view_state_from_bounds(bounds)

                layer_data = layer_payload({**dict(row), "layer_id": row["id"]})

                # Determine layer_type from database type column
                db_type = row["type"]
                layer_type: Literal["feature", "raster", "table"] | None = None
                if db_type == "feature":
                    layer_type = "feature"
                elif db_type == "raster":
                    layer_type = "raster"

                items.append(
                    ItemToProcess(
                        type="layer",
                        layer_type=layer_type,
                        id=row["id"],
                        updated_at=row["updated_at"],
                        old_thumbnail_url=row["thumbnail_url"],
                        basemap="light",  # Light basemap for layers
                        view_state=view_state,
                        layers=[layer_data],
                        bounds=bounds,
                        use_bounds=use_bounds,
                    )
                )

            return items

    async def _fetch_table_layers_to_update(
        self: Self,
        limit: int,
        layer_ids: list[str] | None = None,
        since: datetime | None = None,
    ) -> list[ItemToProcess]:
        """Fetch table layers that need thumbnail updates.

        Args:
            limit: Maximum number of layers to fetch
            layer_ids: If provided, fetch only these specific layers
            since: If provided, only fetch layers updated after this time

        Returns:
            List of ItemToProcess objects with layer_type="table"
        """
        pool = await self._get_pg_pool()

        async with pool.acquire() as conn:
            if layer_ids:
                rows = await conn.fetch(
                    """
                    SELECT
                        id,
                        name,
                        updated_at,
                        thumbnail_url
                    FROM customer.layer
                    WHERE id = ANY($1::uuid[])
                      AND type = 'table'
                    ORDER BY updated_at DESC
                    LIMIT $2
                    """,
                    layer_ids,
                    limit,
                )
            elif since:
                rows = await conn.fetch(
                    """
                    SELECT
                        id,
                        name,
                        updated_at,
                        thumbnail_url
                    FROM customer.layer
                    WHERE updated_at > $1
                      AND type = 'table'
                    ORDER BY updated_at DESC
                    LIMIT $2
                    """,
                    since,
                    limit,
                )
            else:
                rows = await conn.fetch(
                    """
                    SELECT
                        id,
                        name,
                        updated_at,
                        thumbnail_url
                    FROM customer.layer
                    WHERE type = 'table'
                    ORDER BY updated_at DESC
                    LIMIT $1
                    """,
                    limit,
                )

            items = []
            for row in rows:
                items.append(
                    ItemToProcess(
                        type="layer",
                        layer_type="table",
                        id=row["id"],
                        updated_at=row["updated_at"],
                        old_thumbnail_url=row["thumbnail_url"],
                    )
                )

            return items

    def _parse_extent_to_bounds(self: Self, extent: str | None) -> list[float] | None:
        """Parse extent (WKT or WKB hex) to bounds [west, south, east, north]."""
        if not extent:
            return None

        try:
            from shapely import wkb, wkt

            # Try to parse as WKT first (starts with geometry type name)
            if (
                extent.strip()
                .upper()
                .startswith(("POLYGON", "MULTIPOLYGON", "POINT", "LINESTRING"))
            ):
                geom = wkt.loads(extent)
            else:
                # Assume it's WKB hex
                geom = wkb.loads(extent, hex=True)

            # Get bounds: (minx, miny, maxx, maxy)
            minx, miny, maxx, maxy = geom.bounds

            # Skip world extent (default placeholder)
            if minx <= -179 and maxx >= 179 and miny <= -89 and maxy >= 89:
                return None

            return [minx, miny, maxx, maxy]  # [west, south, east, north]

        except Exception as e:
            logger.warning(f"Failed to parse extent: {e}")
            return None

    def _compute_bounds_from_layers(
        self: Self, layers: list[dict]
    ) -> list[float] | None:
        """Compute combined bounds from visible layer extents.

        Returns [west, south, east, north] or None if no valid extents.
        """
        combined_bounds = None

        for layer in layers:
            # Only consider visible layers
            if not layer.get("visible", True):
                continue

            extent = layer.get("extent")
            layer_bounds = self._parse_extent_to_bounds(extent)

            if layer_bounds:
                if combined_bounds is None:
                    combined_bounds = layer_bounds[:]
                else:
                    # Expand combined bounds to include this layer
                    combined_bounds[0] = min(
                        combined_bounds[0], layer_bounds[0]
                    )  # west
                    combined_bounds[1] = min(
                        combined_bounds[1], layer_bounds[1]
                    )  # south
                    combined_bounds[2] = max(
                        combined_bounds[2], layer_bounds[2]
                    )  # east
                    combined_bounds[3] = max(
                        combined_bounds[3], layer_bounds[3]
                    )  # north

        return combined_bounds

    def _calculate_view_state_from_bounds(
        self: Self, bounds: list[float] | None
    ) -> dict:
        """Calculate view state from bounds."""
        if not bounds:
            return {
                "latitude": 48.13,
                "longitude": 11.57,
                "zoom": 10,
                "bearing": 0,
                "pitch": 0,
            }

        west, south, east, north = bounds
        center_lng = (west + east) / 2
        center_lat = (south + north) / 2

        # Estimate zoom from extent size
        lat_diff = north - south
        lng_diff = east - west
        max_diff = max(lat_diff, lng_diff)

        # Handle point geometries or very small extents (avoid division by zero)
        if max_diff <= 0 or max_diff < 0.0001:
            estimated_zoom = 14  # Default zoom for point geometries
        else:
            estimated_zoom = max(1, min(16, math.log2(360 / max_diff) - 1))

        return {
            "latitude": center_lat,
            "longitude": center_lng,
            "zoom": estimated_zoom,
            "bearing": 0,
            "pitch": 0,
        }

    def _build_thumbnail_data(self: Self, item: ItemToProcess) -> str:
        """Build base64-encoded JSON data for the thumbnail URL."""
        data = {
            "viewState": item.view_state
            or {
                "latitude": 48.13,
                "longitude": 11.57,
                "zoom": 10,
                "bearing": 0,
                "pitch": 0,
            },
            "basemap": item.basemap,
            "layers": item.layers,
            "useBounds": item.use_bounds,
        }

        if item.bounds:
            data["bounds"] = item.bounds

        # Serialize and encode
        json_str = json.dumps(data, separators=(",", ":"))  # Compact JSON
        return base64.b64encode(json_str.encode()).decode()

    async def _render_thumbnail(
        self: Self,
        item: ItemToProcess,
    ) -> bytes:
        """Render a thumbnail for a project or layer using Playwright."""
        browser = await self._get_browser()

        # The render payload goes in through an init script, NOT the query
        # string: it carries the item's whole layer list, the request line
        # counts against the web server's header budget, and past Node's 16 KB
        # default such a navigation came back 431 — the page never ran, so the
        # container this method waits for never existed. The page still reads
        # `?data=` when it is there, which keeps a URL pasteable by hand.
        from goatlib.config.print import print_base_url

        base_url = print_base_url()
        data_param = self._build_thumbnail_data(item)
        url = f"{base_url}/thumbnail/{item.type}/{item.id}"

        logger.info(f"Rendering thumbnail for {item.type}/{item.id}")
        logger.debug(f"URL: {url[:200]}...")  # Log truncated URL

        context = await browser.new_context(
            viewport={"width": THUMBNAIL_WIDTH, "height": THUMBNAIL_HEIGHT},
            device_scale_factor=1,
        )
        page = await context.new_page()

        # Runs before any of the page's own scripts, on every document it loads.
        await page.add_init_script(
            f"window.__THUMBNAIL_DATA__ = {json.dumps(data_param)};"
        )

        # Capture console logs for debugging
        page.on(
            "console",
            lambda msg: logger.debug(f"Browser console [{msg.type}]: {msg.text}"),
        )
        page.on("pageerror", lambda exc: logger.error(f"Browser page error: {exc}"))

        try:
            # Navigate to thumbnail page
            await page.goto(url, wait_until="networkidle", timeout=DEFAULT_PAGE_TIMEOUT)

            # Wait for the page to signal it's ready
            try:
                await page.wait_for_selector(
                    "[data-thumbnail-ready='true']",
                    state="attached",
                    timeout=DEFAULT_RENDER_TIMEOUT,
                )
                logger.info(f"Page signaled ready for {item.type}/{item.id}")
            except Exception as e:
                # Fallback: check if container exists
                logger.warning(
                    f"data-thumbnail-ready timeout ({DEFAULT_RENDER_TIMEOUT}ms) "
                    f"for {item.type}/{item.id}: {e}"
                )

                container = await page.query_selector("#thumbnail-container")
                if not container:
                    raise RuntimeError(
                        f"Thumbnail container not found for {item.type}/{item.id}"
                    )

                logger.info("Thumbnail container found, proceeding with capture")

            # Wait for network to be idle (tiles, fonts, etc.)
            await page.wait_for_load_state("networkidle", timeout=30000)

            # Small buffer for any final rendering
            await asyncio.sleep(0.5)

            # Capture the thumbnail container
            container_locator = page.locator("#thumbnail-container")
            if await container_locator.count() > 0:
                await container_locator.wait_for(state="visible", timeout=5000)
                png_bytes = await container_locator.screenshot(type="png")
            else:
                # Fallback to full viewport
                logger.warning(
                    f"Container not found for {item.type}/{item.id}, "
                    "using full viewport"
                )
                png_bytes = await page.screenshot(type="png", full_page=False)

            return png_bytes

        finally:
            await context.close()

    async def _render_table_thumbnail(
        self: Self,
        item: ItemToProcess,
    ) -> bytes | None:
        """Render a table thumbnail as a spreadsheet-style preview using Playwright.

        Queries DuckLake for the schema and first few rows, then renders an HTML table.

        Args:
            item: ItemToProcess with layer_type="table"

        Returns:
            PNG image bytes, or None if default thumbnail should be used
        """
        from goatlib.utils.layer import (
            LayerNotFoundError,
            get_schema_for_layer,
            layer_id_to_table_name,
        )

        logger.info(f"Rendering table thumbnail for layer {item.id}")

        # Query data from DuckLake - get schema and data in one go
        try:
            ducklake = self._get_ducklake_manager()
            layer_id = str(item.id)
            table_name = layer_id_to_table_name(layer_id)

            # Get the schema (user namespace) for this layer
            try:
                schema = get_schema_for_layer(layer_id, ducklake)
            except LayerNotFoundError:
                logger.info(
                    f"Layer {item.id} not found in DuckLake, using default thumbnail"
                )
                return None

            # Full table path: lake.{schema}.{table_name}
            full_table_path = f"lake.{schema}.{table_name}"

            # First, get the column names from the table
            schema_query = f"DESCRIBE {full_table_path}"
            schema_result = ducklake.execute(schema_query)

            if not schema_result:
                logger.info(
                    f"No schema found for layer {item.id}, using default thumbnail"
                )
                return None

            # Get column names (first element of each row is the column name)
            all_columns = [row[0] for row in schema_result]

            # Skip internal columns (like 'id' if it's just a row number)
            # and take first N columns
            display_columns = all_columns[:TABLE_THUMBNAIL_MAX_COLUMNS]

            if not display_columns:
                logger.info(
                    f"No columns found for layer {item.id}, using default thumbnail"
                )
                return None

            # Query data
            columns_sql = ", ".join([f'"{col}"' for col in display_columns])
            query = (
                f"SELECT {columns_sql} FROM {full_table_path} "
                f"LIMIT {TABLE_THUMBNAIL_MAX_ROWS}"
            )

            logger.debug(f"Table query: {query}")
            rows = ducklake.execute(query)

        except Exception as e:
            logger.warning(f"Failed to query table data for {item.id}: {e}")
            return None

        if not rows:
            logger.info(f"No data for layer {item.id}, using default thumbnail")
            return None

        # Truncate column names for display
        def truncate(s: str, max_len: int) -> str:
            return s[:max_len] + "..." if len(s) > max_len else s

        headers = [
            truncate(col, TABLE_THUMBNAIL_COLUMN_NAME_MAX_LEN)
            for col in display_columns
        ]

        # Build table rows HTML
        def escape_html(s: str) -> str:
            return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

        rows_html = ""
        for i, row in enumerate(rows):
            row_class = "even" if i % 2 == 0 else "odd"
            cells = ""
            for val in row:
                str_val = str(val) if val is not None else ""
                str_val = truncate(str_val, TABLE_THUMBNAIL_CELL_VALUE_MAX_LEN)
                cells += f"<td>{escape_html(str_val)}</td>"
            rows_html += f'<tr class="{row_class}">{cells}</tr>'

        # Build header cells
        header_cells = "".join(f"<th>{escape_html(h)}</th>" for h in headers)

        # Generate HTML with embedded CSS
        html = f"""
<!DOCTYPE html>
<html>
<head>
    <style>
        * {{
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }}
        body {{
            width: {THUMBNAIL_WIDTH}px;
            height: {THUMBNAIL_HEIGHT}px;
            display: flex;
            align-items: center;
            justify-content: center;
            background: #f8f9fa;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
                         'Helvetica Neue', Arial, sans-serif;
        }}
        .container {{
            background: white;
            border-radius: 8px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            overflow: hidden;
            max-width: 90%;
        }}
        table {{
            border-collapse: collapse;
            font-size: 14px;
        }}
        th {{
            background: #2D3648;
            color: white;
            font-weight: 600;
            padding: 12px 20px;
            text-align: left;
            white-space: nowrap;
        }}
        td {{
            padding: 10px 20px;
            border-bottom: 1px solid #e9ecef;
            white-space: nowrap;
        }}
        tr.even td {{
            background: #ffffff;
        }}
        tr.odd td {{
            background: #f8f9fa;
        }}
        tr:last-child td {{
            border-bottom: none;
        }}
    </style>
</head>
<body>
    <div class="container">
        <table>
            <thead><tr>{header_cells}</tr></thead>
            <tbody>{rows_html}</tbody>
        </table>
    </div>
</body>
</html>
"""

        # Render with Playwright
        browser = await self._get_browser()
        context = await browser.new_context(
            viewport={"width": THUMBNAIL_WIDTH, "height": THUMBNAIL_HEIGHT},
            device_scale_factor=1,
        )
        page = await context.new_page()

        try:
            await page.set_content(html, wait_until="load")
            png_bytes = await page.screenshot(type="png", full_page=False)
            return png_bytes
        finally:
            await context.close()

    def _upload_thumbnail(
        self: Self,
        png_bytes: bytes,
        item_type: Literal["project", "layer", "bundle"],
        item_id: str,
        content_hash: str,
    ) -> str:
        """Upload thumbnail to S3 and return the S3 key.

        The filename includes the content hash for change detection:
        thumbnails/{type}s/{id}_{hash}.png

        Returns the S3 key (not full URL) so the frontend/API can generate
        presigned URLs as needed. This works with any S3 provider.
        """
        s3_client = self._get_s3_client()
        bucket = self._get_s3_bucket()

        # Build S3 key with content hash (enables change detection)
        if item_type == "project":
            s3_key = f"{THUMBNAIL_DIR_PROJECT}{item_id}_{content_hash}.png"
        elif item_type == "bundle":
            s3_key = f"{THUMBNAIL_DIR_BUNDLE}{item_id}_{content_hash}.png"
        else:
            s3_key = f"{THUMBNAIL_DIR_LAYER}{item_id}_{content_hash}.png"

        logger.info(f"Uploading thumbnail to s3://{bucket}/{s3_key}")

        # Upload to S3
        s3_client.upload_fileobj(
            io.BytesIO(png_bytes),
            bucket,
            s3_key,
            ExtraArgs={"ContentType": "image/png"},
        )

        logger.info(f"Uploaded thumbnail: {s3_key} ({len(png_bytes)} bytes)")

        # Return S3 key (frontend/API will generate presigned URL)
        return s3_key

    async def _update_thumbnail_url(
        self: Self,
        item_type: Literal["project", "layer", "bundle"],
        item_id: UUID,
        thumbnail_url: str,
    ) -> None:
        """Update the thumbnail_url in the database without changing updated_at."""
        pool = await self._get_pg_pool()

        table = item_type if item_type in ("project", "bundle") else "layer"

        logger.info(f"Updating {table} {item_id} thumbnail_url to: {thumbnail_url}")

        async with pool.acquire() as conn:
            # Use raw SQL to avoid triggering updated_at changes
            result = await conn.execute(
                f"""
                UPDATE customer.{table}
                SET thumbnail_url = $1
                WHERE id = $2
                """,
                thumbnail_url,
                item_id,
            )
            logger.info(f"Database update result: {result}")

    def _delete_old_thumbnail(
        self: Self,
        old_key: str | None,
        item_type: Literal["project", "layer", "bundle"],
    ) -> None:
        """Delete old thumbnail from S3 if it exists."""
        if not old_key:
            return

        # Check if it's one of our thumbnails (not a default placeholder).
        # Any of the directories counts: a bundle's picture written before
        # bundles had one of their own still has to be cleaned up.
        if not old_key.startswith(
            (THUMBNAIL_DIR_PROJECT, THUMBNAIL_DIR_LAYER, THUMBNAIL_DIR_BUNDLE)
        ):
            return

        try:
            s3_client = self._get_s3_client()
            bucket = self._get_s3_bucket()

            s3_client.delete_object(Bucket=bucket, Key=old_key)
            logger.info(f"Deleted old thumbnail: {old_key}")
        except Exception as e:
            logger.warning(f"Failed to delete old thumbnail {old_key}: {e}")

    async def _process_item(
        self: Self,
        item: ItemToProcess,
        force: bool = False,
    ) -> ThumbnailResult:
        """Process a single item (project or feature/raster layer).

        Args:
            item: The item to process
            force: If True, regenerate even if hash matches
        """
        item_id = str(item.id)
        item_desc = f"{item.type}[{item.layer_type}]" if item.layer_type else item.type

        # Compute content hash
        item.content_hash = item.compute_content_hash()

        # Check if regeneration is needed (unless forced)
        if not force and not item.needs_regeneration():
            logger.info(
                f"⏭ Skipping {item_desc}/{item_id} - content unchanged "
                f"(hash: {item.content_hash})"
            )
            return ThumbnailResult(
                item_type=item.type,
                layer_type=item.layer_type,
                item_id=item_id,
                success=True,
                thumbnail_url=item.old_thumbnail_url,
            )

        try:
            # Render thumbnail
            png_bytes = await self._render_thumbnail(item)

            # Upload to S3 with content hash in filename
            thumbnail_url = self._upload_thumbnail(
                png_bytes, item.type, item_id, item.content_hash
            )

            # Update database
            await self._update_thumbnail_url(item.type, item.id, thumbnail_url)

            # Delete old thumbnail (only if URL changed)
            if item.old_thumbnail_url != thumbnail_url:
                self._delete_old_thumbnail(item.old_thumbnail_url, item.type)

            logger.info(
                f"✓ Generated thumbnail for {item_desc}/{item_id} "
                f"(hash: {item.content_hash})"
            )

            return ThumbnailResult(
                item_type=item.type,
                layer_type=item.layer_type,
                item_id=item_id,
                success=True,
                thumbnail_url=thumbnail_url,
            )

        except Exception as e:
            logger.error(
                f"✗ Failed to generate thumbnail for {item_desc}/{item_id}: {e}"
            )
            return ThumbnailResult(
                item_type=item.type,
                layer_type=item.layer_type,
                item_id=item_id,
                success=False,
                error=str(e),
            )

    async def _process_table_item(
        self: Self,
        item: ItemToProcess,
        force: bool = False,
    ) -> ThumbnailResult:
        """Process a single table layer for thumbnail generation.

        Args:
            item: ItemToProcess with layer_type="table"
            force: If True, regenerate even if hash matches
        """
        item_id = str(item.id)

        # Compute content hash
        item.content_hash = item.compute_content_hash()

        # Check if regeneration is needed (unless forced)
        if not force and not item.needs_regeneration():
            logger.info(
                f"⏭ Skipping layer[table]/{item_id} - content unchanged "
                f"(hash: {item.content_hash})"
            )
            return ThumbnailResult(
                item_type="layer",
                layer_type="table",
                item_id=item_id,
                success=True,
                thumbnail_url=item.old_thumbnail_url,
            )

        try:
            # Render table thumbnail using Playwright
            png_bytes = await self._render_table_thumbnail(item)

            if png_bytes is None:
                # No data to render - use default thumbnail URL
                thumbnail_url = DEFAULT_TABLE_THUMBNAIL_URL

                # Update database with default URL
                await self._update_thumbnail_url("layer", item.id, thumbnail_url)

                # Delete old thumbnail if it was a custom one
                if item.old_thumbnail_url not in DEFAULT_TABLE_THUMBNAIL_URLS:
                    self._delete_old_thumbnail(item.old_thumbnail_url, "layer")

                logger.info(
                    f"✓ Using default thumbnail for layer[table]/{item_id} "
                    f"(no data to render)"
                )

                return ThumbnailResult(
                    item_type="layer",
                    layer_type="table",
                    item_id=item_id,
                    success=True,
                    thumbnail_url=thumbnail_url,
                )

            # Upload to S3 with content hash in filename
            thumbnail_url = self._upload_thumbnail(
                png_bytes, "layer", item_id, item.content_hash
            )

            # Update database
            await self._update_thumbnail_url("layer", item.id, thumbnail_url)

            # Delete old thumbnail (only if URL changed)
            if item.old_thumbnail_url != thumbnail_url:
                self._delete_old_thumbnail(item.old_thumbnail_url, "layer")

            logger.info(
                f"✓ Generated thumbnail for layer[table]/{item_id} "
                f"(hash: {item.content_hash})"
            )

            return ThumbnailResult(
                item_type="layer",
                layer_type="table",
                item_id=item_id,
                success=True,
                thumbnail_url=thumbnail_url,
            )

        except Exception as e:
            logger.error(
                f"✗ Failed to generate thumbnail for layer[table]/{item_id}: {e}"
            )
            return ThumbnailResult(
                item_type="layer",
                layer_type="table",
                item_id=item_id,
                success=False,
                error=str(e),
            )

    async def _run_dry_run(
        self: Self, params: ThumbnailTaskParams
    ) -> ThumbnailTaskOutput:
        """Run in dry-run mode: test DB connection and fetch items without generating.

        This is useful for debugging connection issues in production.
        """
        logger.info("=== DRY RUN MODE ===")
        logger.info(
            "Testing connections and fetching items (no thumbnails will be generated)"
        )

        errors: list[str] = []

        # Test PostgreSQL connection
        logger.info("Testing PostgreSQL connection...")
        try:
            pool = await self._get_pg_pool()
            async with pool.acquire() as conn:
                result = await conn.fetchval("SELECT 1")
                logger.info(
                    f"✓ PostgreSQL connection OK (test query returned: {result})"
                )

                # Also test that customer schema exists
                schema_exists = await conn.fetchval(
                    "SELECT EXISTS(SELECT 1 FROM information_schema.schemata WHERE schema_name = 'customer')"
                )
                if schema_exists:
                    logger.info("✓ customer schema exists")
                else:
                    logger.warning("✗ customer schema does not exist!")
                    errors.append("customer schema does not exist")
        except Exception as e:
            logger.error(f"✗ PostgreSQL connection FAILED: {e}")
            errors.append(f"PostgreSQL connection failed: {e}")
            return ThumbnailTaskOutput(
                total_processed=0,
                projects_processed=0,
                layers_processed=0,
                feature_layers_processed=0,
                raster_layers_processed=0,
                table_layers_processed=0,
                success_count=0,
                error_count=1,
                errors=errors,
            )

        # Determine since filter
        since: datetime | None = None
        if not params.fetch_all and not params.project_ids and not params.layer_ids:
            since = datetime.now(timezone.utc) - timedelta(hours=params.hours_lookback)
            logger.info(f"Looking for items updated since: {since.isoformat()}")
        elif params.fetch_all:
            logger.info("Fetching ALL items (fetch_all=True)")

        projects_found = 0
        layers_found = 0
        table_layers_found = 0
        projects_needing_regen = 0
        layers_needing_regen = 0
        table_layers_needing_regen = 0

        # Fetch projects
        if params.include_projects:
            logger.info("Fetching projects...")
            try:
                projects = await self._fetch_projects_to_update(
                    params.batch_size,
                    project_ids=params.project_ids or None,
                    use_bounds=params.use_bounds,
                    since=since,
                )
                projects_found = len(projects)
                for p in projects:
                    if p.needs_regeneration():
                        projects_needing_regen += 1
                logger.info(
                    f"✓ Found {projects_found} projects "
                    f"({projects_needing_regen} need regeneration)"
                )
                # Show sample
                for p in projects[:3]:
                    needs_regen = p.needs_regeneration()
                    logger.info(
                        f"  - {p.id} (updated: {p.updated_at}, needs_regen: {needs_regen})"
                    )
                if len(projects) > 3:
                    logger.info(f"  ... and {len(projects) - 3} more")
            except Exception as e:
                logger.error(f"✗ Failed to fetch projects: {e}")
                errors.append(f"projects fetch: {e}")

        # Fetch feature/raster layers
        if params.include_layers:
            logger.info("Fetching feature/raster layers...")
            try:
                layers = await self._fetch_layers_to_update(
                    params.batch_size,
                    layer_ids=params.layer_ids or None,
                    use_bounds=params.use_bounds,
                    since=since,
                )
                layers_found = len(layers)
                for layer in layers:
                    if layer.needs_regeneration():
                        layers_needing_regen += 1
                logger.info(
                    f"✓ Found {layers_found} feature/raster layers "
                    f"({layers_needing_regen} need regeneration)"
                )
                for layer in layers[:3]:
                    needs_regen = layer.needs_regeneration()
                    logger.info(
                        f"  - {layer.id} [{layer.layer_type}] "
                        f"(updated: {layer.updated_at}, needs_regen: {needs_regen})"
                    )
                if len(layers) > 3:
                    logger.info(f"  ... and {len(layers) - 3} more")
            except Exception as e:
                logger.error(f"✗ Failed to fetch layers: {e}")
                errors.append(f"layers fetch: {e}")

        # Fetch table layers
        if params.include_table_layers:
            logger.info("Fetching table layers...")
            try:
                tables = await self._fetch_table_layers_to_update(
                    params.batch_size,
                    layer_ids=params.layer_ids or None,
                    since=since,
                )
                table_layers_found = len(tables)
                for t in tables:
                    if t.needs_regeneration():
                        table_layers_needing_regen += 1
                logger.info(
                    f"✓ Found {table_layers_found} table layers "
                    f"({table_layers_needing_regen} need regeneration)"
                )
                for t in tables[:3]:
                    needs_regen = t.needs_regeneration()
                    logger.info(
                        f"  - {t.id} (updated: {t.updated_at}, needs_regen: {needs_regen})"
                    )
                if len(tables) > 3:
                    logger.info(f"  ... and {len(tables) - 3} more")
            except Exception as e:
                logger.error(f"✗ Failed to fetch table layers: {e}")
                errors.append(f"table layers fetch: {e}")

        total_found = projects_found + layers_found + table_layers_found
        total_needing_regen = (
            projects_needing_regen + layers_needing_regen + table_layers_needing_regen
        )

        logger.info("=== DRY RUN SUMMARY ===")
        logger.info(f"Total items found: {total_found}")
        logger.info(f"Items needing regeneration: {total_needing_regen}")
        logger.info(
            f"  - Projects: {projects_found} ({projects_needing_regen} need regen)"
        )
        logger.info(
            f"  - Feature/Raster layers: {layers_found} ({layers_needing_regen} need regen)"
        )
        logger.info(
            f"  - Table layers: {table_layers_found} ({table_layers_needing_regen} need regen)"
        )
        if errors:
            logger.info(f"Errors: {len(errors)}")
            for err in errors:
                logger.info(f"  - {err}")

        return ThumbnailTaskOutput(
            total_processed=total_found,
            projects_processed=projects_found,
            layers_processed=layers_found + table_layers_found,
            feature_layers_processed=layers_found,
            raster_layers_processed=0,  # Not tracked separately in dry run
            table_layers_processed=table_layers_found,
            success_count=total_found,
            error_count=len(errors),
            errors=errors,
        )

    async def run_async(self: Self, params: ThumbnailTaskParams) -> ThumbnailTaskOutput:
        """Execute the thumbnail generation task."""
        try:
            # Handle dry_run mode - test connections and fetch items only
            if params.dry_run:
                return await self._run_dry_run(params)

            # Check if specific IDs are provided
            has_specific_ids = bool(
                params.project_ids or params.layer_ids or params.bundle_ids
            )

            # Determine the 'since' filter for fetching items
            since: datetime | None = None
            if has_specific_ids:
                logger.info(
                    f"Processing specific items: "
                    f"{len(params.project_ids or [])} projects, "
                    f"{len(params.layer_ids or [])} layers"
                )
            elif params.force_regenerate:
                logger.info("Force regenerating all thumbnails")
            elif params.fetch_all:
                logger.info("Fetching all items (fetch_all=True)")
            else:
                # Default: only check items updated in the last N hours
                since = datetime.now(timezone.utc) - timedelta(
                    hours=params.hours_lookback
                )
                logger.info(
                    f"Scanning items updated since {since.isoformat()} "
                    f"({params.hours_lookback}h lookback)"
                )

            # Collect all items to process
            items: list[ItemToProcess] = []
            fetch_errors: list[str] = []

            if params.include_projects and (params.project_ids or not has_specific_ids):
                try:
                    logger.info("Fetching projects from database...")
                    projects = await self._fetch_projects_to_update(
                        params.batch_size,
                        project_ids=params.project_ids if params.project_ids else None,
                        use_bounds=params.use_bounds,
                        since=since,
                    )
                    items.extend(projects)
                    logger.info(f"Found {len(projects)} projects to check")
                except Exception as e:
                    logger.error(f"Failed to fetch projects: {e}")
                    fetch_errors.append(f"projects fetch: {e}")

            if params.include_layers and (params.layer_ids or not has_specific_ids):
                remaining = params.batch_size - len(items)
                if remaining > 0:
                    try:
                        logger.info("Fetching feature/raster layers from database...")
                        layers = await self._fetch_layers_to_update(
                            remaining,
                            layer_ids=params.layer_ids if params.layer_ids else None,
                            use_bounds=params.use_bounds,
                            since=since,
                        )
                        items.extend(layers)
                        logger.info(
                            f"Found {len(layers)} feature/raster layers to check"
                        )
                    except Exception as e:
                        logger.error(f"Failed to fetch layers: {e}")
                        fetch_errors.append(f"layers fetch: {e}")

            # Fetch table layers if enabled
            if params.include_table_layers and (
                params.layer_ids or not has_specific_ids
            ):
                remaining = params.batch_size - len(items)
                if remaining > 0:
                    try:
                        logger.info("Fetching table layers from database...")
                        tables = await self._fetch_table_layers_to_update(
                            remaining,
                            layer_ids=params.layer_ids if params.layer_ids else None,
                            since=since,
                        )
                        items.extend(tables)
                        logger.info(f"Found {len(tables)} table layers to check")
                    except Exception as e:
                        logger.error(f"Failed to fetch table layers: {e}")
                        fetch_errors.append(f"table layers fetch: {e}")

            if params.include_bundles and (params.bundle_ids or not has_specific_ids):
                remaining = params.batch_size - len(items)
                if remaining > 0:
                    try:
                        logger.info("Fetching bundles from database...")
                        bundles = await self._fetch_bundles_to_update(
                            remaining,
                            bundle_ids=params.bundle_ids if params.bundle_ids else None,
                            use_bounds=params.use_bounds,
                            since=since,
                        )
                        items.extend(bundles)
                        logger.info(f"Found {len(bundles)} bundles to check")
                    except Exception as e:
                        logger.error(f"Failed to fetch bundles: {e}")
                        fetch_errors.append(f"bundles fetch: {e}")

            if not items:
                logger.info("No items found to check")
                return ThumbnailTaskOutput(
                    total_processed=0,
                    projects_processed=0,
                    layers_processed=0,
                    bundles_processed=0,
                    feature_layers_processed=0,
                    raster_layers_processed=0,
                    table_layers_processed=0,
                    success_count=0,
                    error_count=0,
                )

            logger.info(f"Processing {len(items)} items")

            # Determine if we should force regeneration
            force_regen = params.force_regenerate or has_specific_ids

            # Process items with concurrency limit
            results: list[ThumbnailResult] = []
            semaphore = asyncio.Semaphore(params.max_concurrent)
            processed_count = 0
            total_items = len(items)

            async def process_item_with_semaphore(
                item: ItemToProcess,
                index: int,
            ) -> ThumbnailResult:
                nonlocal processed_count
                try:
                    async with semaphore:
                        # Route to appropriate processor based on layer_type
                        if item.layer_type == "table":
                            result = await self._process_table_item(
                                item, force=force_regen
                            )
                        else:
                            result = await self._process_item(item, force=force_regen)

                        processed_count += 1
                        if processed_count % 10 == 0 or processed_count == total_items:
                            logger.info(
                                f"Progress: {processed_count}/{total_items} items processed "
                                f"({processed_count * 100 // total_items}%)"
                            )
                        return result
                except Exception as e:
                    # Catch any unexpected errors to prevent task failure
                    processed_count += 1
                    item_desc = (
                        f"{item.type}[{item.layer_type}]"
                        if item.layer_type
                        else item.type
                    )
                    logger.error(
                        f"Unexpected error processing {item_desc}/{item.id}: {e}"
                    )
                    return ThumbnailResult(
                        item_type=item.type,
                        layer_type=item.layer_type,
                        item_id=str(item.id),
                        success=False,
                        error=f"Unexpected error: {e}",
                    )

            # Process all items with return_exceptions for extra safety
            tasks = [
                process_item_with_semaphore(item, i) for i, item in enumerate(items)
            ]
            all_results = await asyncio.gather(*tasks, return_exceptions=True)

            # Handle any exceptions that slipped through
            for i, result in enumerate(all_results):
                if isinstance(result, Exception):
                    item = items[i]
                    item_desc = (
                        f"{item.type}[{item.layer_type}]"
                        if item.layer_type
                        else item.type
                    )
                    logger.error(f"Task exception for {item_desc}/{item.id}: {result}")
                    results.append(
                        ThumbnailResult(
                            item_type=item.type,
                            layer_type=item.layer_type,
                            item_id=str(item.id),
                            success=False,
                            error=str(result),
                        )
                    )
                else:
                    results.append(result)

            # Collect stats
            success_count = sum(1 for r in results if r.success)
            error_count = sum(1 for r in results if not r.success)
            projects_processed = sum(
                1 for r in results if r.item_type == "project" and r.success
            )
            feature_layers_processed = sum(
                1
                for r in results
                if r.item_type == "layer" and r.layer_type == "feature" and r.success
            )
            raster_layers_processed = sum(
                1
                for r in results
                if r.item_type == "layer" and r.layer_type == "raster" and r.success
            )
            table_layers_processed = sum(
                1
                for r in results
                if r.item_type == "layer" and r.layer_type == "table" and r.success
            )
            # Total layers processed (all types)
            layers_processed = (
                feature_layers_processed
                + raster_layers_processed
                + table_layers_processed
            )
            errors = fetch_errors + [
                f"{r.item_type}[{r.layer_type or 'n/a'}]/{r.item_id}: {r.error}"
                for r in results
                if not r.success
            ]

            logger.info(
                f"Completed: {success_count} successful, {error_count + len(fetch_errors)} failed"
            )

            bundles_processed = sum(
                1 for r in results if r.item_type == "bundle" and r.success
            )

            return ThumbnailTaskOutput(
                total_processed=len(results),
                projects_processed=projects_processed,
                layers_processed=layers_processed,
                bundles_processed=bundles_processed,
                feature_layers_processed=feature_layers_processed,
                raster_layers_processed=raster_layers_processed,
                table_layers_processed=table_layers_processed,
                success_count=success_count,
                error_count=error_count,
                errors=errors[:10],  # Limit error messages
            )

        finally:
            await self._close_browser()
            await self._close_pg_pool()
            self._close_ducklake()

    def run(self: Self, params: ThumbnailTaskParams) -> ThumbnailTaskOutput:
        """Synchronous wrapper for run_async."""
        return asyncio.run(self.run_async(params))


def main(params: ThumbnailTaskParams) -> dict:
    """Entry point for Windmill."""
    task = ThumbnailGeneratorTask()
    task.init_from_env()
    result = task.run(params)
    return result.model_dump()
