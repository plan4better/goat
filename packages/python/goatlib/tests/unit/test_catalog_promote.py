"""Unit tests for the catalog promote mapping.

The DB write path needs Postgres and is covered by the integration pass; what
is unit-testable is the part that decides what gets written: reading an item
from the mirror and flattening it onto layer columns.
"""

from pathlib import Path

import duckdb
import pytest
from goatlib.catalog.promote import (
    CatalogItemNotFoundError,
    _jsonable,
    layer_type,
    published_style,
    read_item,
    read_items,
    resolve_item_ids,
    style_key_for,
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
                 [], NULL)
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
