"""Tests for tile service including PMTiles support."""

import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from geoapi.config import settings
from geoapi.services.tile_service import (
    TileService,
    tile_to_bbox_3857,
    tile_to_bbox_4326,
)

# =====================================================================
#  Coordinate Conversion Tests
# =====================================================================


def test_tile_to_bbox_4326_z0() -> None:
    """Test bbox for world tile at z=0."""
    bbox = tile_to_bbox_4326(0, 0, 0)
    assert bbox[0] == pytest.approx(-180.0)
    assert bbox[2] == pytest.approx(180.0)
    # Y bounds are clamped by Web Mercator
    assert bbox[1] < -80
    assert bbox[3] > 80


def test_tile_to_bbox_4326_z1() -> None:
    """Test bbox for tiles at z=1."""
    # Top-left tile (NW hemisphere)
    bbox = tile_to_bbox_4326(1, 0, 0)
    assert bbox[0] == pytest.approx(-180.0)
    assert bbox[2] == pytest.approx(0.0)
    assert bbox[3] > 0  # Northern hemisphere


def test_tile_to_bbox_3857() -> None:
    """Test Web Mercator bbox calculation."""
    bbox = tile_to_bbox_3857(0, 0, 0)
    # Full Web Mercator extent
    assert bbox[0] == pytest.approx(-20037508.342789244)
    assert bbox[2] == pytest.approx(20037508.342789244)


def test_tile_to_bbox_3857_higher_zoom() -> None:
    """Test Web Mercator bbox at higher zoom levels."""
    # At z=1, each tile is half the extent
    bbox_nw = tile_to_bbox_3857(1, 0, 0)  # Northwest tile
    bbox_se = tile_to_bbox_3857(1, 1, 1)  # Southeast tile

    # NW tile should be in negative x, positive y
    assert bbox_nw[0] < 0
    assert bbox_nw[3] > 0

    # SE tile should be in positive x, negative y
    assert bbox_se[2] > 0
    assert bbox_se[1] < 0


# =====================================================================
#  TileService Tests
# =====================================================================


def test_tile_service_init() -> None:
    """Test TileService initialization."""
    service = TileService()
    assert service.max_features == settings.MAX_FEATURES_PER_TILE


def test_should_use_pmtiles_with_filter() -> None:
    """Test that filters disable PMTiles usage."""
    service = TileService()
    layer_info = MagicMock()
    layer_info.schema_name = "user_test"
    layer_info.table_name = "t_layer"

    # With CQL filter - should not use PMTiles
    result = service._should_use_pmtiles(
        layer_info, cql_filter={"filter": "value > 10", "lang": "cql2-json"}
    )
    assert result is False

    # With bbox filter - should not use PMTiles
    result = service._should_use_pmtiles(layer_info, bbox=[0, 0, 1, 1])
    assert result is False


def test_should_use_pmtiles_no_file() -> None:
    """Test that missing PMTiles file returns False."""
    with tempfile.TemporaryDirectory() as tmpdir:
        with patch.object(
            TileService,
            "_get_pmtiles_path",
            return_value=Path(tmpdir) / "missing.pmtiles",
        ):
            service = TileService()
            layer_info = MagicMock()
            layer_info.schema_name = "user_test"
            layer_info.table_name = "t_layer"

            result = service._should_use_pmtiles(layer_info)
            assert result is False


def test_invalidate_pmtiles_cache() -> None:
    """Test cache invalidation for a specific layer."""
    service = TileService()

    # Add mock entry to cache
    service._pmtiles_exists_cache["user_test/t_layer"] = True

    # Invalidate
    service.invalidate_pmtiles_cache("user_test", "t_layer")

    # Verify removed
    assert "user_test/t_layer" not in service._pmtiles_exists_cache


def test_pmtiles_exists_caching() -> None:
    """Test that PMTiles existence check is cached."""
    with tempfile.TemporaryDirectory() as tmpdir:
        pmtiles_path = Path(tmpdir) / "test.pmtiles"

        with patch.object(
            TileService,
            "_get_pmtiles_path",
            return_value=pmtiles_path,
        ):
            service = TileService()
            layer_info = MagicMock()
            layer_info.schema_name = "user_test"
            layer_info.table_name = "t_layer"

            # First call - file doesn't exist
            assert service._pmtiles_exists(layer_info) is False
            assert "user_test/t_layer" in service._pmtiles_exists_cache

            # Create the file
            pmtiles_path.touch()

            # Second call - should still return cached False
            assert service._pmtiles_exists(layer_info) is False

            # Invalidate cache
            service.invalidate_pmtiles_cache("user_test", "t_layer")

            # Third call - should now find the file
            assert service._pmtiles_exists(layer_info) is True


def test_get_pmtiles_path() -> None:
    """Tiles are flat; the schema-nested layout is still read."""
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        service = TileService()
        service.tiles_data_dir = root
        layer_info = MagicMock()
        layer_info.schema_name = "user_abc123"
        layer_info.table_name = "t_layer456"

        # Nothing on disk: the flat path is what a writer would produce.
        assert service._get_pmtiles_path(layer_info) == root / "t_layer456.pmtiles"

        # Only legacy tiles exist (layer not regenerated since the move).
        legacy = root / "user_abc123" / "t_layer456.pmtiles"
        legacy.parent.mkdir()
        legacy.write_bytes(b"OLD")
        assert service._get_pmtiles_path(layer_info) == legacy

        # Once regenerated, the flat file wins over the stale one.
        flat = root / "t_layer456.pmtiles"
        flat.write_bytes(b"NEW")
        assert service._get_pmtiles_path(layer_info) == flat


@pytest.mark.asyncio
async def test_get_tile_from_pmtiles_missing_file() -> None:
    """Test that missing PMTiles file returns None."""
    with tempfile.TemporaryDirectory() as tmpdir:
        with patch.object(
            TileService,
            "_get_pmtiles_path",
            return_value=Path(tmpdir) / "missing.pmtiles",
        ):
            service = TileService()
            layer_info = MagicMock()
            layer_info.schema_name = "user_test"
            layer_info.table_name = "t_layer"

            result = await service._get_tile_from_pmtiles(layer_info, 0, 0, 0)
            assert result is None


def test_catalog_layer_tiles_are_read_from_the_catalog_directory() -> None:
    """A catalog layer's tiles come from the catalog tree, not the user tiles dir.

    Catalog artifacts are derived and identical for every deployment — the same
    dataset through the same converter — so they belong in a wipeable tree that
    can be rebuilt or shipped prebuilt, rather than mixed into the tiles a
    user's own data produced.
    """
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        tiles, catalog = root / "tiles", root / "catalog"
        tiles.mkdir()
        catalog.mkdir()
        service = TileService()
        service.tiles_data_dir = tiles
        service.catalog_tiles_dir = catalog

        layer_info = MagicMock()
        layer_info.schema_name = "main"
        layer_info.table_name = "t_cat456"
        layer_info.kind = "catalog"

        # Nothing on disk yet: the catalog directory is where a writer puts it.
        assert service._get_pmtiles_path(layer_info) == catalog / "t_cat456.pmtiles"

        (catalog / "t_cat456.pmtiles").write_bytes(b"CAT")
        assert service._get_pmtiles_path(layer_info) == catalog / "t_cat456.pmtiles"


def test_catalog_tiles_left_in_the_old_place_are_still_served() -> None:
    """Deployments that materialized before the move keep working un-migrated."""
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        tiles, catalog = root / "tiles", root / "catalog"
        tiles.mkdir()
        catalog.mkdir()
        service = TileService()
        service.tiles_data_dir = tiles
        service.catalog_tiles_dir = catalog

        layer_info = MagicMock()
        layer_info.schema_name = "main"
        layer_info.table_name = "t_old789"
        layer_info.kind = "catalog"

        (tiles / "t_old789.pmtiles").write_bytes(b"OLD")
        assert service._get_pmtiles_path(layer_info) == tiles / "t_old789.pmtiles"


def test_an_ordinary_layer_never_looks_in_the_catalog_directory() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        tiles, catalog = root / "tiles", root / "catalog"
        tiles.mkdir()
        catalog.mkdir()
        service = TileService()
        service.tiles_data_dir = tiles
        service.catalog_tiles_dir = catalog

        layer_info = MagicMock()
        layer_info.schema_name = "main"
        layer_info.table_name = "t_mine123"
        layer_info.kind = "lake"

        # A same-named file in the catalog tree must not be served for it.
        (catalog / "t_mine123.pmtiles").write_bytes(b"NOT MINE")
        assert service._get_pmtiles_path(layer_info) == tiles / "t_mine123.pmtiles"


def test_finding_tiles_by_layer_id_alone_sees_catalog_tiles() -> None:
    """The id-only lookup has no `kind`, so it must search both trees."""
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        tiles, catalog = root / "tiles", root / "catalog"
        tiles.mkdir()
        catalog.mkdir()
        service = TileService()
        service.tiles_data_dir = tiles
        service.catalog_tiles_dir = catalog

        cat = "ca7456" + "0" * 26
        (catalog / f"t_{cat}.pmtiles").write_bytes(b"CAT")
        assert service._find_pmtiles_by_layer_id(cat) == catalog / f"t_{cat}.pmtiles"
        assert service._find_pmtiles_by_layer_id("f" * 32) is None


LAYER_ID = "0b6c8a2e-5f1d-4c3a-9e7b-2d4f6a8c0e1f"


def test_a_layer_id_finds_its_tile_file() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        tiles, catalog = root / "tiles", root / "catalog"
        tiles.mkdir()
        catalog.mkdir()
        service = TileService()
        service.tiles_data_dir = tiles
        service.catalog_tiles_dir = catalog
        stored = tiles / f"t_{LAYER_ID.replace('-', '')}.pmtiles"
        stored.write_bytes(b"PM")

        assert service._find_known_pmtiles(LAYER_ID) == stored


@pytest.mark.parametrize(
    "layer_id",
    [
        "x/../../t_secret",
        "x/../t_secret",
        "..",
        "*",
        "a/b",
        "0b6c8a2e5f1d4c3a9e7b2d4f6a8c0e1",
        "",
    ],
)
def test_an_id_that_is_no_layer_id_finds_no_file(layer_id: str) -> None:
    """Only a layer id (32 hex digits, hyphens or not) names a tile file: anything
    else finds none, also where a file of that name exists, and no glob of the
    workflow tree runs for it."""
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        tiles, catalog = root / "tiles", root / "catalog"
        tiles.mkdir()
        catalog.mkdir()
        (root / "temporary" / "u" / "w").mkdir(parents=True)
        (root / "temporary" / "u" / "w" / "t_other.pmtiles").write_bytes(b"PM")
        (root / "t_secret.pmtiles").write_bytes(b"PM")
        (tiles / "t_secret.pmtiles").write_bytes(b"PM")
        (tiles / "t_x").mkdir()
        service = TileService()
        service.tiles_data_dir = tiles
        service.catalog_tiles_dir = catalog

        assert service._find_known_pmtiles(layer_id) is None
        assert service._search_temp_pmtiles(layer_id) is None
