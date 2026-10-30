"""Tests for PMTiles generation module."""

import pathlib
import tempfile
from unittest.mock import MagicMock, patch

import pytest
from goatlib.io.pmtiles import PMTilesConfig, PMTilesGenerator

# =====================================================================
#  PMTilesConfig Tests
# =====================================================================


def test_config_default_values() -> None:
    """Test default configuration values."""
    config = PMTilesConfig()
    assert config.enabled is True
    assert config.min_zoom == 0
    assert config.max_zoom == 14  # Fixed zoom level
    assert config.layer_name == "default"


def test_config_custom_values() -> None:
    """Test custom configuration values."""
    config = PMTilesConfig(
        enabled=False,
        min_zoom=2,
        max_zoom=14,
        layer_name="custom",
    )
    assert config.enabled is False
    assert config.min_zoom == 2
    assert config.max_zoom == 14
    assert config.layer_name == "custom"


# =====================================================================
#  PMTilesGenerator Tests
# =====================================================================


def test_get_pmtiles_path() -> None:
    """Test PMTiles path generation with UUID normalization."""
    with tempfile.TemporaryDirectory() as tmpdir:
        generator = PMTilesGenerator(tiles_data_dir=tmpdir)

        path = generator.get_pmtiles_path("xyz-789-456")

        # Flat: keyed only by layer id, no owner directory.
        assert path.parent == pathlib.Path(tmpdir)
        assert path.name == "t_xyz789456.pmtiles"


def test_pmtiles_exists_false() -> None:
    """Test pmtiles_exists returns False when file doesn't exist."""
    with tempfile.TemporaryDirectory() as tmpdir:
        generator = PMTilesGenerator(tiles_data_dir=tmpdir)

        assert generator.pmtiles_exists("layer1") is False


def test_pmtiles_exists_true() -> None:
    """Test pmtiles_exists returns True when file exists."""
    with tempfile.TemporaryDirectory() as tmpdir:
        generator = PMTilesGenerator(tiles_data_dir=tmpdir)

        # Create the file
        pmtiles_path = generator.get_pmtiles_path("layer1")
        pmtiles_path.parent.mkdir(parents=True, exist_ok=True)
        pmtiles_path.touch()

        assert generator.pmtiles_exists("layer1") is True


def test_pmtiles_lookups_never_list_the_tiles_directory() -> None:
    """The tiles directory holds tens of thousands of files and is only ever
    probed by path: checking or deleting a layer's tiles does not list it."""
    with tempfile.TemporaryDirectory() as tmpdir:
        generator = PMTilesGenerator(tiles_data_dir=tmpdir)
        nested = pathlib.Path(tmpdir) / "user_abc" / "t_layer1.pmtiles"
        nested.parent.mkdir()
        nested.touch()

        with (
            patch.object(
                pathlib.Path, "glob", side_effect=AssertionError("tiles dir listed")
            ),
            patch.object(
                pathlib.Path, "iterdir", side_effect=AssertionError("tiles dir listed")
            ),
        ):
            assert generator.pmtiles_exists("layer1") is False
            assert generator.delete_pmtiles("layer1") is False


def test_delete_pmtiles_file_exists() -> None:
    """Test delete_pmtiles when file exists."""
    with tempfile.TemporaryDirectory() as tmpdir:
        generator = PMTilesGenerator(tiles_data_dir=tmpdir)

        # Create the file
        pmtiles_path = generator.get_pmtiles_path("layer1")
        pmtiles_path.parent.mkdir(parents=True, exist_ok=True)
        pmtiles_path.touch()

        result = generator.delete_pmtiles("layer1")

        assert result is True
        assert not pmtiles_path.exists()


def test_delete_pmtiles_file_not_exists() -> None:
    """Test delete_pmtiles when file doesn't exist."""
    with tempfile.TemporaryDirectory() as tmpdir:
        generator = PMTilesGenerator(tiles_data_dir=tmpdir)

        result = generator.delete_pmtiles("layer1")

        assert result is False


@patch("shutil.which")
def test_check_dependencies_missing(mock_which: MagicMock) -> None:
    """Test that missing tippecanoe raises RuntimeError."""
    mock_which.return_value = None

    with tempfile.TemporaryDirectory() as tmpdir:
        with pytest.raises(RuntimeError, match="tippecanoe is required"):
            PMTilesGenerator(tiles_data_dir=tmpdir)


def test_generate_disabled() -> None:
    """Test that generate_from_table returns None when disabled."""
    with tempfile.TemporaryDirectory() as tmpdir:
        config = PMTilesConfig(enabled=False)
        generator = PMTilesGenerator(tiles_data_dir=tmpdir, config=config)

        mock_con = MagicMock()
        result = generator.generate_from_table(
            duckdb_con=mock_con,
            table_name="lake.test.table",
            layer_id="layer1",
        )

        assert result is None


def test_tippecanoe_command_default_zoom() -> None:
    """Test tippecanoe command uses -z14 by default for polygons."""
    with tempfile.TemporaryDirectory() as tmpdir:
        config = PMTilesConfig()  # Uses default max_zoom=14
        generator = PMTilesGenerator(tiles_data_dir=tmpdir, config=config)

        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stderr="")
            # Pass polygon geometry type (or None for default polygon behavior)
            generator._run_tippecanoe(
                "/input.fgb", "/output.pmtiles", geometry_type="POLYGON"
            )

            cmd = mock_run.call_args[0][0]
            assert "-z14" in cmd  # Default max zoom 14
            assert "-Z0" in cmd  # Default min zoom 0
            assert "--extend-zooms-if-still-dropping" in cmd
            assert "--drop-densest-as-needed" in cmd  # Polygon-specific
            # Note: --use-attribute-for-id is NOT used because it removes id from properties


def test_tippecanoe_command_custom_zoom() -> None:
    """Test tippecanoe command generation with custom max zoom."""
    with tempfile.TemporaryDirectory() as tmpdir:
        config = PMTilesConfig(max_zoom=12)
        generator = PMTilesGenerator(tiles_data_dir=tmpdir, config=config)

        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stderr="")
            generator._run_tippecanoe("/input.fgb", "/output.pmtiles")

            cmd = mock_run.call_args[0][0]
            assert "-z12" in cmd
            assert "-z15" not in cmd


def test_tippecanoe_command_point_layer() -> None:
    """Test tippecanoe uses point-optimized settings for point layers."""
    with tempfile.TemporaryDirectory() as tmpdir:
        config = PMTilesConfig()
        generator = PMTilesGenerator(tiles_data_dir=tmpdir, config=config)

        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stderr="")
            generator._run_tippecanoe(
                "/input.geojson", "/output.pmtiles", geometry_type="POINT"
            )

            cmd = mock_run.call_args[0][0]
            # Point-specific settings: keep every feature, spread them evenly
            # at low zooms by clustering on a Hilbert curve.
            assert "-r1" in cmd
            assert "--cluster-distance=5" in cmd
            assert "--hilbert" in cmd
            assert "--extend-zooms-if-still-dropping" in cmd
            # Should NOT have polygon-specific settings
            assert "--drop-densest-as-needed" not in cmd
            assert "--no-tiny-polygon-reduction" not in cmd


def test_tiles_are_built_on_local_disk_and_published_whole() -> None:
    """tippecanoe builds PMTiles in an SQLite database at its output path, which
    is unsafe on network storage: it writes to a local work directory, and only
    the finished file lands in the tiles directory."""
    import duckdb

    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute(
        "CREATE TABLE lines AS SELECT 1 AS id, "
        "ST_GeomFromText('LINESTRING(11.5 48.1, 11.6 48.2)') AS geometry"
    )
    with tempfile.TemporaryDirectory() as tmpdir:
        tiles_dir = pathlib.Path(tmpdir)
        generator = PMTilesGenerator(tiles_data_dir=tiles_dir)
        outputs: list[pathlib.Path] = []

        def fake_tippecanoe(**kwargs: object) -> None:
            output = pathlib.Path(str(kwargs["output_path"]))
            outputs.append(output)
            output.write_bytes(b"tiles")

        with patch.object(generator, "_run_tippecanoe", side_effect=fake_tippecanoe):
            path = generator.generate_from_table(
                duckdb_con=con,
                table_name="lines",
                layer_id="layer1",
                show_progress=False,
            )

        assert path == generator.get_pmtiles_path("layer1")
        assert path.read_bytes() == b"tiles"
        assert outputs and all(tiles_dir not in p.parents for p in outputs)
        assert [p.name for p in tiles_dir.iterdir()] == [path.name]
