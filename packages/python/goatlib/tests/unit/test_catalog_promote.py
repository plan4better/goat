"""Unit tests for the catalog promote mapping.

The DB write path needs Postgres and is covered by the integration pass; what
is unit-testable is the part that decides what gets written: reading an item
from the mirror and flattening it onto layer columns.
"""

from pathlib import Path
from typing import Any

import duckdb
import pytest
from goatlib.catalog.promote import (
    CatalogItemNotFoundError,
    _jsonable,
    catalog_default_style,
    is_wms,
    layer_type,
    published_style,
    read_item,
    read_items,
    resolve_item_ids,
    style_key_for,
    wms_layer,
    wmts_layer,
)


@pytest.fixture()
def mirror(tmp_path: Path) -> Path:
    """A minimal mirror_items.parquet with the columns promote reads."""
    out = tmp_path / "mirror_items.parquet"
    con = duckdb.connect()
    con.execute(
        f"""
        COPY (
            SELECT * FROM (VALUES
                ('item-1', 'dataset-1', 'Schulstandorte Bayern', 'Alle Schulen',
                 'CC-BY-4.0', 'places', 'LDBV', ['schulen', 'bildung'],
                 'de', '2024-11', '../../../data/item-1.parquet',
                 'feature', 'point', 'harvested from ...',
                 TIMESTAMP '2024-01-01', TIMESTAMP '2024-02-03',
                 TIMESTAMP '2025-06-07', 9.5, 47.2, 13.9, 50.6,
                 [{{'rel': 'via', 'href': 'https://geodaten.bayern.de/x'}}],
                 NULL),
                ('item-2', 'dataset-2', 'Statistik ohne Geometrie', NULL,
                 'not-a-license', 'nonsense-category', NULL, [],
                 'German', '3', 'data/item-2.parquet',
                 'table', NULL, NULL,
                 NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                 [], NULL),
                ('item-3', 'dataset-2', 'Zweite Ebene', NULL,
                 'CC-BY-4.0', 'places', NULL, [],
                 'de', '1', '../../../data/item-3.parquet',
                 'feature', 'polygon', NULL,
                 NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                 [], NULL),
                ('item-4', 'dataset-4', 'Mountainbike Vorarlberg', NULL,
                 'CC-BY-4.0', 'leisure', NULL, [],
                 'de', '1', NULL,
                 'wms', NULL, NULL,
                 NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                 [{{'rel': 'wms', 'href': 'https://vogis.cnv.at/geoserver/ows'}}], NULL)
            ) AS t(
                id, collection, title, description, license, category, publisher,
                keywords, language_code, version, parquet_url,
                "goat:layerType", "goat:geometryType", "processing:lineage",
                datetime_start, created, updated,
                bbox_xmin, bbox_ymin, bbox_xmax, bbox_ymax,
                links, assets
            )
        ) TO '{out}' (FORMAT PARQUET)
        """
    )
    con.close()
    return out


def test_read_item_returns_row_as_dict(mirror: Path) -> None:
    item = read_item(mirror, "item-1")
    assert item["title"] == "Schulstandorte Bayern"
    assert item["version"] == "2024-11"
    assert item["goat:geometryType"] == "point"


def test_a_column_the_mirror_predates_reads_as_absent(mirror: Path) -> None:
    """The fixture is a pre-v8 mirror without `attribution`: the sync task
    rewrites the file on its own schedule, so a deploy can read an older one
    for a cycle, and that must not fail every promote until it catches up."""
    assert read_item(mirror, "item-1")["attribution"] is None
    assert read_items(mirror, ["item-1", "item-2"])["item-2"]["attribution"] is None


def test_read_item_unknown_id_raises(mirror: Path) -> None:
    with pytest.raises(CatalogItemNotFoundError):
        read_item(mirror, "no-such-item")


def test_jsonable_snapshot_serialises_timestamps(mirror: Path) -> None:
    """The snapshot must survive json.dumps — timestamps become ISO strings."""
    import json

    snap = _jsonable(read_item(mirror, "item-1"))
    json.dumps(snap)  # raises on anything non-serialisable
    assert snap["license"] == "CC-BY-4.0"  # raw contract value, unmapped
    assert snap["datetime_start"].startswith("2024-01-01")


def test_layer_type_geometry_wins(mirror: Path) -> None:
    assert layer_type(read_item(mirror, "item-1")) == ("feature", "point")


def test_layer_type_no_geometry_is_a_table(mirror: Path) -> None:
    assert layer_type(read_item(mirror, "item-2")) == ("table", None)


def test_layer_type_of_a_bundle_member_with_a_geotiff_is_a_raster() -> None:
    """A bundle's members declare `bundle`, not their own kind: one without a
    geometry whose data is a GeoTIFF is a raster, not a table."""
    member = {
        "goat:layerType": "bundle",
        "goat:geometryType": None,
        "parquet_url": "../../../data/ab-12.tif",
    }
    assert layer_type(member) == ("raster", None)
    assert layer_type({**member, "parquet_url": "../../../data/ab-12.parquet"}) == (
        "table",
        None,
    )


def test_layer_type_wms_is_a_raster(mirror: Path) -> None:
    assert layer_type(read_item(mirror, "item-4")) == ("raster", None)
    link = [{"rel": "wms", "href": "https://g/ows", "title": "a"}]
    # A bundle member inherits `bundle`; its own link still says it is a WMS.
    member = {"goat:layerType": "bundle", "links": link}
    assert is_wms(member) and layer_type(member) == ("raster", None)
    # A vector layer that also offers a WMS view stays a feature.
    vector = {**member, "goat:geometryType": "polygon"}
    assert not is_wms(vector) and layer_type(vector) == ("feature", "polygon")


def test_wms_layer_builds_the_connect_data_shape() -> None:
    href = "https://h/ows?map=/a.map"
    item = {
        "links": [
            {"rel": "wms", "href": href, "title": "a"},
            {"rel": "wms", "href": href, "title": "b"},
            {"rel": "wms", "href": "https://other/wms", "title": "c"},
        ]
    }
    out = wms_layer(item)
    assert out["url"] == (
        "https://h/ows?map=/a.map&bbox={bbox-epsg-3857}&service=WMS&REQUEST=GetMap"
        "&layers=a,b&FORMAT=image/png&TRANSPARENT=true&WIDTH=256&HEIGHT=256"
        "&SRS=EPSG:3857&CRS=EPSG:3857&VERSION=1.3.0&STYLES=,&DPI=90"
        "&MAP_RESOLUTION=90&FORMAT_OPTIONS=dpi:90"
    )
    assert out["other_properties"]["layers"] == ["a", "b"]
    assert out["other_properties"]["legend_urls"][0] == (
        "https://h/ows?map=/a.map&service=WMS&REQUEST=GetLegendGraphic&layer=a"
        "&FORMAT=image/png&TRANSPARENT=true&VERSION=1.3.0&STYLE=default"
        "&SLD_VERSION=1.1.0"
    )
    # goat-data names several layers of one link in its title, comma-separated.
    several = wms_layer(
        {"links": [{"rel": "wms", "href": "https://g/ows", "title": "a, b"}]}
    )
    assert several["other_properties"]["layers"] == ["a", "b"]
    assert len(several["other_properties"]["legend_urls"]) == 2
    assert "&layers=a,b&" in several["url"] and "&STYLES=,&" in several["url"]
    with pytest.raises(ValueError):
        wms_layer({"links": [{"rel": "via", "href": "https://x"}]})


def test_wmts_is_a_link_to_its_tile_address() -> None:
    caps = {"rel": "wmts", "href": "https://h/WMTSCapabilities.xml", "title": "ortho"}
    xyz = {"rel": "xyz", "href": "https://h/ortho/{z}/{y}/{x}.png"}
    item = {"goat:layerType": "wmts", "links": [caps, xyz]}
    assert layer_type(item) == ("raster", None)
    assert wmts_layer(item) == {
        "url": "https://h/ortho/{z}/{y}/{x}.png",
        "other_properties": {"layers": ["ortho"]},
    }
    # The server draws it: GOAT Style's map-service default, no published style.
    assert catalog_default_style(item, seed="s")["kind"] == "raster"
    # Without a tile address there is nothing to draw: refused, never copied.
    with pytest.raises(ValueError):
        wmts_layer({"goat:layerType": "wmts", "links": [caps]})


def test_bucket_key_resolves_relative_hrefs() -> None:
    """Contract C8: published hrefs are tree-relative; only the basename and
    the bucket's fixed data/ prefix identify the object."""
    from goatlib.tools.catalog_materialize import bucket_key_for

    assert bucket_key_for("../../../data/ab-12.parquet") == "data/ab-12.parquet"
    assert bucket_key_for("data/x.parquet") == "data/x.parquet"


def test_bucket_key_rejects_non_parquet() -> None:
    import pytest as _pytest
    from goatlib.tools.catalog_materialize import bucket_key_for

    with _pytest.raises(ValueError):
        bucket_key_for("styles/ab-12.json")
    with _pytest.raises(ValueError):
        bucket_key_for("")


def test_bucket_key_of_a_raster_is_its_geotiff() -> None:
    """A raster item's data asset is a GeoTIFF under the same data/ prefix; a
    vector layer still takes a parquet only."""
    import pytest as _pytest
    from goatlib.tools.catalog_materialize import RASTER_SUFFIXES, bucket_key_for

    assert (
        bucket_key_for("../../../data/ab-12.tif", RASTER_SUFFIXES) == "data/ab-12.tif"
    )
    with _pytest.raises(ValueError):
        bucket_key_for("../../../data/ab-12.parquet", RASTER_SUFFIXES)
    with _pytest.raises(ValueError):
        bucket_key_for("../../../data/ab-12.tif")


def test_resolve_item_ids_passes_item_ids_through(mirror: Path) -> None:
    assert resolve_item_ids(mirror, ["item-1", "item-2"]) == ["item-1", "item-2"]


def test_resolve_item_ids_expands_a_single_layer_dataset(mirror: Path) -> None:
    """A Collection's id is not one of its items' ids, so a caller naming the
    dataset must still promote the layer inside it."""
    assert resolve_item_ids(mirror, ["dataset-1"]) == ["item-1"]


def test_resolve_item_ids_expands_every_member_of_a_dataset(mirror: Path) -> None:
    assert resolve_item_ids(mirror, ["dataset-2"]) == ["item-2", "item-3"]


def test_resolve_item_ids_keeps_request_order(mirror: Path) -> None:
    assert resolve_item_ids(mirror, ["item-3", "dataset-1"]) == ["item-3", "item-1"]


def test_resolve_item_ids_dedupes_a_dataset_and_its_own_member(mirror: Path) -> None:
    """Ticking a bundle and one of its layers is one request for that layer."""
    assert resolve_item_ids(mirror, ["dataset-2", "item-2"]) == ["item-2", "item-3"]


def test_resolve_item_ids_unknown_id_raises(mirror: Path) -> None:
    with pytest.raises(CatalogItemNotFoundError):
        resolve_item_ids(mirror, ["item-1", "no-such-thing"])


def _styled(href: str | None) -> dict:
    """An item row carrying (or not carrying) a style asset."""
    return {"assets": {"style": {"href": href}} if href else {}}


def test_style_key_resolves_a_tree_relative_href() -> None:
    """Contract C8: published hrefs walk out of the JSON tree; only the
    basename and the bucket's fixed styles/ prefix identify the object."""
    assert style_key_for("../../../styles/ab-12.json") == "styles/ab-12.json"
    assert style_key_for("styles/ab-12.json") == "styles/ab-12.json"


def test_style_key_rejects_anything_but_json() -> None:
    with pytest.raises(ValueError):
        style_key_for("../../../data/ab-12.parquet")
    with pytest.raises(ValueError):
        style_key_for("")


def test_published_style_is_used_when_the_item_has_one() -> None:
    read = lambda key: b'{"color": [102, 194, 165], "opacity": 0.8}'  # noqa: E731
    style = published_style(_styled("../../../styles/ab-12.json"), read_object=read)
    assert style == {"color": [102, 194, 165], "opacity": 0.8}


def test_published_style_is_none_without_a_style_asset() -> None:
    assert published_style(_styled(None), read_object=lambda key: b"{}") is None


def test_published_style_survives_an_unreadable_object() -> None:
    """A missing or unreachable object falls back to the default style rather
    than failing the add."""

    def read(key: str) -> bytes:
        raise RuntimeError("NoSuchKey")

    assert (
        published_style(_styled("../../../styles/ab-12.json"), read_object=read) is None
    )


def test_published_style_rejects_a_non_object_document() -> None:
    read = lambda key: b"[1, 2, 3]"  # noqa: E731
    assert (
        published_style(_styled("../../../styles/ab-12.json"), read_object=read) is None
    )


def test_published_style_rejects_malformed_json() -> None:
    read = lambda key: b"{not json"  # noqa: E731
    assert (
        published_style(_styled("../../../styles/ab-12.json"), read_object=read) is None
    )


def test_snapshot_carries_the_record_s_own_dates(mirror: Path) -> None:
    """When the *dataset* was published and last changed.

    `layer.updated_at` answers a different question — when GOAT promoted or
    re-materialized its copy — so a catalog layer showing it as "Last updated"
    reports the moment it was added, which is never what a reader means.
    """
    snap = _jsonable(read_item(mirror, "item-1"))

    assert snap["updated"].startswith("2025-06-07")
    assert snap["created"].startswith("2024-02-03")


def test_snapshot_dates_are_absent_rather_than_invented(mirror: Path) -> None:
    snap = _jsonable(read_item(mirror, "item-2"))

    assert snap["updated"] is None
    assert snap["created"] is None


class _RecordingConnection:
    """A connection that records whether each statement ran in a transaction."""

    def __init__(self, existing: dict[str, Any]) -> None:
        self.existing = existing
        self.open = False
        self.statements: list[bool] = []

    async def fetchrow(self, sql: str, *args: Any) -> dict[str, Any]:
        return self.existing

    async def execute(self, sql: str, *args: Any) -> None:
        self.statements.append(self.open)

    def transaction(self) -> "_RecordingConnection":
        return self

    async def __aenter__(self) -> None:
        self.open = True

    async def __aexit__(self, *args: Any) -> None:
        self.open = False


async def test_a_layer_made_a_link_layer_gets_its_style_in_the_same_transaction() -> (
    None
):
    """A map service promoted before it was a link is repaired on its next
    add: the row and its default style change together, or a failure between
    the two would leave a ready layer without a style that no later add
    repairs."""
    from goatlib.catalog.promote import promote

    item = {
        "id": "wms-1",
        "version": "1",
        "title": "Radwege",
        "goat:layerType": "wms",
        "links": [{"rel": "wms", "href": "https://g/ows", "title": "a"}],
    }
    conn = _RecordingConnection(
        {
            "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
            "data_type": None,
            "status": "failed",
        }
    )
    result = await promote(conn, "wms-1", mirror_items_path="unused", item=item)  # type: ignore[arg-type]
    assert result["created"] is False and result["materialize"] is False
    assert conn.statements == [True, True]
