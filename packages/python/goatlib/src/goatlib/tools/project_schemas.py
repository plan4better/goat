"""Pydantic models for the GOAT project export archive format.

These models define the JSON structure inside the exported ZIP file.
They are used by both ProjectExport (serialization) and ProjectImport (validation).
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

# Literal types mirroring core enums for validation
LayerTypeLiteral = Literal["feature", "raster", "table"]
FeatureTypeLiteral = Literal["standard", "tool", "street_network"]
FeatureGeometryTypeLiteral = Literal["point", "line", "polygon"]
DataTypeLiteral = Literal["mvt", "wfs", "wms", "xyz", "wmts", "cog"]
AssetTypeLiteral = Literal["image", "icon"]
MapPositionLiteral = Literal["top", "below_labels", "below_roads"]


class ExportManifest(BaseModel):
    """manifest.json — archive metadata and integrity."""

    model_config = ConfigDict(extra="ignore")

    format_version: str = "1.0"
    goat_version: str | None = None
    exported_at: datetime
    source_instance: str | None = None
    project_name: str
    checksums: dict[str, str] = Field(default_factory=dict)
    layer_count: int = 0
    internal_layer_count: int = 0
    external_layer_count: int = 0
    workflow_count: int = 0
    report_count: int = 0


class ExportProjectMetadata(BaseModel):
    """project.json — project record fields."""

    model_config = ConfigDict(extra="ignore")

    name: str
    description: str | None = None
    basemap: str | None = None
    custom_basemaps: list[dict[str, Any]] | None = None
    max_extent: list[float] | None = None
    builder_config: dict[str, Any] | None = None
    tags: list[str] | None = None
    initial_view_state: dict[str, Any] | None = None
    layer_order: list[int] | None = None


class ExportLayerMetadata(BaseModel):
    """layers/{layer_id}/metadata.json — layer record fields."""

    model_config = ConfigDict(extra="ignore")

    id: str
    name: str
    description: str | None = None
    type: LayerTypeLiteral
    feature_layer_type: FeatureTypeLiteral | None = None
    feature_layer_geometry_type: FeatureGeometryTypeLiteral | None = None
    data_type: DataTypeLiteral | None = None
    url: str | None = None
    # The dataset's default style, a GOAT Style document (format 1.2).
    style: dict[str, Any] | None = None
    # Today's style format, in archives before 1.2; converted on import.
    properties: dict[str, Any] | None = None
    other_properties: dict[str, Any] | None = None
    # Per-column metadata keyed by column name (field kind, formula and its
    # dependencies, display config). Empty for archives written before it
    # was exported.
    field_config: dict[str, Any] = Field(default_factory=dict)
    size: int | None = None
    is_external: bool = False  # True if WMS/WFS/XYZ/COG (no data.parquet)


class ExportLayerProjectLink(BaseModel):
    """layers/{layer_id}/project_link.json — per-project layer config (format 1.0).

    Retained for backward-compatible import of 1.0 archives. New exports use
    [ExportLayerProjectLinkEntry] in [ExportLayerProjectLinks].
    """

    model_config = ConfigDict(extra="ignore")

    name: str | None = None
    order: int = 0
    properties: dict[str, Any] | None = None
    other_properties: dict[str, Any] | None = None
    query: dict[str, Any] | None = None
    charts: dict[str, Any] | None = None
    group_id: str | int | None = None  # References group by original ID


class ExportNamedStyle(BaseModel):
    """One named style of a project layer (format 1.2)."""

    model_config = ConfigDict(extra="ignore")

    name: str
    position: int = 0
    document: dict[str, Any]
    active: bool = False


class ExportLayerProjectLinkEntry(BaseModel):
    """One entry in layer_project_links.json (format 1.1; 1.2 adds the named
    styles and the map state, and drops `properties`).

    Unlike [ExportLayerProjectLink], this carries `layer_id` so the archive
    can represent multiple links referencing the same dataset.

    Note: the DB column is `layer_project_group_id`; older code/tests
    sometimes used the shorter `group_id`. Both are accepted on read; the
    importer prefers `layer_project_group_id`.
    """

    model_config = ConfigDict(extra="ignore")

    id: int | None = None
    layer_id: str
    name: str | None = None
    order: int = 0
    properties: dict[str, Any] | None = None
    other_properties: dict[str, Any] | None = None
    query: dict[str, Any] | None = None
    charts: dict[str, Any] | None = None
    layer_project_group_id: int | None = None
    group_id: str | int | None = None
    styles: list[ExportNamedStyle] | None = None
    visible: bool | None = None
    position: MapPositionLiteral | None = None
    time_value: Any = None
    legend_expanded: bool | None = None


class ExportLayerProjectLinks(BaseModel):
    """layer_project_links.json — full list of layer_project rows (format 1.1)."""

    model_config = ConfigDict(extra="ignore")

    links: list[ExportLayerProjectLinkEntry]


class ExportLayerIndex(BaseModel):
    """layers/index.json — list of all layers."""

    model_config = ConfigDict(extra="ignore")

    layers: list[ExportLayerMetadata]


class ExportLayerGroup(BaseModel):
    """Single group in layer_groups.json."""

    model_config = ConfigDict(extra="ignore")

    id: str | int  # Original group ID (int in DB, coerced to str for portability)
    name: str
    order: int = 0
    # Before 1.2 the map state sat in `properties` (`visibility`, `expanded`).
    properties: dict[str, Any] | None = None
    visible: bool | None = None
    expanded: bool | None = None
    parent_id: str | int | None = None  # Self-referencing for nesting


class ExportLayerGroupTree(BaseModel):
    """layer_groups.json — full group hierarchy."""

    model_config = ConfigDict(extra="ignore")

    groups: list[ExportLayerGroup]


class ExportWorkflow(BaseModel):
    """workflows/{workflow_id}.json — workflow definition."""

    model_config = ConfigDict(extra="ignore")

    id: str
    name: str
    description: str | None = None
    is_default: bool = False
    config: dict[str, Any]  # Nodes, edges, viewport, variables
    thumbnail_url: str | None = None


class ExportReportLayout(BaseModel):
    """reports/{report_id}.json — report layout definition."""

    model_config = ConfigDict(extra="ignore")

    id: str
    name: str
    description: str | None = None
    is_default: bool = False
    is_predefined: bool = False
    config: dict[str, Any]
    thumbnail_url: str | None = None


class ExportAssetEntry(BaseModel):
    """Single asset in the manifest."""

    model_config = ConfigDict(extra="ignore")

    id: str
    file_name: str
    display_name: str | None = None
    category: str | None = None
    mime_type: str
    file_size: int = 0
    asset_type: AssetTypeLiteral
    content_hash: str | None = None
    # The object key on the source instance: how styles before 1.2 name an icon.
    s3_key: str | None = None
    # Path within the ZIP (e.g., "assets/abc123.png"); archives before 1.2 have
    # none, and their assets no file.
    archive_path: str | None = None


class ExportAssetManifest(BaseModel):
    """assets/index.json — asset listing."""

    model_config = ConfigDict(extra="ignore")

    assets: list[ExportAssetEntry]


# Constants
EXTERNAL_DATA_TYPES = {"wms", "wfs", "xyz", "cog", "wmts", "mvt"}
FORMAT_VERSION = "1.2"
