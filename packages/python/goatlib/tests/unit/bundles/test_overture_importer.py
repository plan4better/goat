"""Tests for the Overture street network importer and bundle-type inference."""

import zipfile
from pathlib import Path
from typing import List, Tuple

import pyarrow.parquet as pq
import pytest
from goatlib.bundles.importers import get_importer, infer_bundle_type
from goatlib.bundles.importers.street_network.overture.overture import (
    OvertureImporter,
)
from goatlib.models.bundle import BundleTypeName, get_spec

from .overture_fixture import write_geoparquet


@pytest.fixture
def importer() -> OvertureImporter:
    return OvertureImporter()


def _make_zip(
    tmp_path: Path,
    name: str = "extract.zip",
    *,
    segments: bool = True,
    connectors: bool = True,
    prefix: str = "",
) -> Path:
    source = tmp_path / "src"
    segments_path, connectors_path = write_geoparquet(source)
    archive = tmp_path / name
    with zipfile.ZipFile(archive, "w") as zf:
        if segments:
            zf.write(segments_path, f"{prefix}segments.geoparquet")
        if connectors:
            zf.write(connectors_path, f"{prefix}connectors.geoparquet")
    return archive


# --- detection ------------------------------------------------------------


def test_filename_detection(importer) -> None:
    assert importer.matches_filename("munich_overture.zip")
    assert importer.matches_filename("OVERTURE-Munich.ZIP")
    assert not importer.matches_filename("munich_gtfs.zip")
    assert not importer.matches_filename("overture.gpkg")


def test_content_detection_when_the_name_says_nothing(tmp_path: Path, importer) -> None:
    archive = _make_zip(tmp_path, "anything.zip")
    assert not importer.matches_filename(archive.name)
    assert importer.matches_source(str(archive))


def test_content_detection_matches_prefixed_entry_names(
    tmp_path: Path, importer
) -> None:
    """An extract keeps whatever name the user gave it, often with a region
    prefix and a directory."""
    archive = tmp_path / "x.zip"
    source = tmp_path / "src"
    segments_path, connectors_path = write_geoparquet(source)
    with zipfile.ZipFile(archive, "w") as zf:
        zf.write(segments_path, "munich/munich_segments.geoparquet")
        zf.write(connectors_path, "munich/munich_connectors.geoparquet")
    assert importer.matches_source(str(archive))


def test_content_detection_needs_both_files(tmp_path: Path, importer) -> None:
    assert not importer.matches_source(
        str(_make_zip(tmp_path, "a.zip", connectors=False))
    )
    assert not importer.matches_source(
        str(_make_zip(tmp_path, "b.zip", segments=False))
    )


def test_macos_resource_forks_are_ignored(tmp_path: Path, importer) -> None:
    """A zip made in Finder carries __MACOSX shadows that would otherwise match."""
    archive = tmp_path / "x.zip"
    source = tmp_path / "src"
    segments_path, connectors_path = write_geoparquet(source)
    with zipfile.ZipFile(archive, "w") as zf:
        zf.write(segments_path, "__MACOSX/._segments.geoparquet")
        zf.write(connectors_path, "__MACOSX/._connectors.geoparquet")
    assert not importer.matches_source(str(archive))


def test_non_zip_is_not_matched(tmp_path: Path, importer) -> None:
    plain = tmp_path / "notazip.zip"
    plain.write_text("hello")
    assert not importer.matches_source(str(plain))


# --- registry inference ---------------------------------------------------


def test_infer_by_filename(tmp_path: Path) -> None:
    assert infer_bundle_type("city_overture.zip") == BundleTypeName.street_network
    assert infer_bundle_type("city_gtfs.zip") == BundleTypeName.pt_network_gtfs


def test_infer_falls_back_to_content(tmp_path: Path) -> None:
    archive = _make_zip(tmp_path, "unnamed.zip")
    assert infer_bundle_type("unnamed.zip") is None
    assert (
        infer_bundle_type("unnamed.zip", str(archive)) == BundleTypeName.street_network
    )


def test_plain_dataset_is_not_a_bundle(tmp_path: Path) -> None:
    plain = tmp_path / "points.gpkg"
    plain.write_bytes(b"\x00")
    assert infer_bundle_type("points.gpkg", str(plain)) is None


def test_importer_is_registered() -> None:
    assert isinstance(get_importer(BundleTypeName.street_network), OvertureImporter)


# --- validation -----------------------------------------------------------


def test_valid_extract_passes(tmp_path: Path, importer) -> None:
    result = importer.validate(str(_make_zip(tmp_path)))
    assert result.valid
    assert sorted(result.detected_roles) == ["edges", "nodes"]
    assert result.errors == []


def test_missing_connectors_is_rejected_by_role(tmp_path: Path, importer) -> None:
    result = importer.validate(str(_make_zip(tmp_path, connectors=False)))
    assert not result.valid
    assert result.missing_required_roles == ["nodes"]
    assert any("connectors" in e for e in result.errors)


def test_not_a_zip_is_rejected(tmp_path: Path, importer) -> None:
    plain = tmp_path / "x.zip"
    plain.write_text("nope")
    result = importer.validate(str(plain))
    assert not result.valid
    assert "not a valid .zip" in result.errors[0]


def test_wrong_columns_are_rejected(tmp_path: Path, importer) -> None:
    """A parquet that isn't a transportation extract fails before a job is
    queued, rather than blowing up in the worker."""
    import pyarrow as pa
    import pyarrow.parquet as pq

    bogus = tmp_path / "segments.geoparquet"
    pq.write_table(pa.table({"foo": ["bar"]}), bogus)
    connectors = tmp_path / "connectors.geoparquet"
    pq.write_table(pa.table({"id": ["c"], "geometry": [b""]}), connectors)

    archive = tmp_path / "x.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        zf.write(bogus, "segments.geoparquet")
        zf.write(connectors, "connectors.geoparquet")

    result = importer.validate(str(archive))
    assert not result.valid
    assert any("missing column" in e for e in result.errors)


# --- extraction -----------------------------------------------------------


def _extract(tmp_path: Path, importer) -> Tuple[List[dict], List[dict]]:
    """Run extraction and read the two parquet layers back as records."""
    archive = _make_zip(tmp_path)
    workdir = tmp_path / "work"
    workdir.mkdir()
    layers = importer.extract_layers(str(archive), str(workdir))
    by_role = {layer.role: layer for layer in layers}
    return (
        _read(by_role["edges"].file_path),
        _read(by_role["nodes"].file_path),
    )


def _read(path: str) -> List[dict]:
    return pq.read_table(path).to_pylist()


def _column_types(path: str) -> dict:
    return {f.name: str(f.type) for f in pq.read_schema(path)}


def test_extract_produces_both_roles(tmp_path: Path, importer) -> None:
    archive = _make_zip(tmp_path)
    workdir = tmp_path / "work"
    workdir.mkdir()
    layers = importer.extract_layers(str(archive), str(workdir))
    assert {layer.role for layer in layers} == {"edges", "nodes"}
    for layer in layers:
        assert layer.layer_type == "feature"
        assert Path(layer.file_path).exists()
        # Parquet, so the runner ingests it without a conversion step.
        assert layer.file_path.endswith(".parquet")
    geometry = {layer.role: layer.geometry_type for layer in layers}
    assert geometry == {"edges": "line", "nodes": "point"}


def test_extracted_edges_are_split(tmp_path: Path, importer) -> None:
    """5 Overture segments become the 11 routable pieces the splitter produces."""
    edges, nodes = _extract(tmp_path, importer)
    assert len(edges) == 11
    assert len(nodes) == 12


def test_extracted_edges_carry_the_flat_columns(tmp_path: Path, importer) -> None:
    edges, _ = _extract(tmp_path, importer)
    record = edges[0]
    spec_columns = get_spec(BundleTypeName.street_network).role("edges")
    for column in spec_columns.required_columns:
        assert column in record
    assert "speed_limit_kph_forward" in record
    assert "other" in record


def test_column_types_are_declared_not_inferred(tmp_path: Path, importer) -> None:
    """The reason this writes parquet: an all-null `level` must still be an
    integer column, or two imports of the same type disagree on their schema."""
    archive = _make_zip(tmp_path)
    workdir = tmp_path / "work"
    workdir.mkdir()
    layers = importer.extract_layers(str(archive), str(workdir))
    edges = next(layer for layer in layers if layer.role == "edges")
    types = _column_types(edges.file_path)

    # Nothing in the fixture sets a limit on the non-drivable classes, so this
    # column is entirely null and would infer as a string without the schema.
    assert types["speed_limit_kph_forward"] == "int32"
    assert types["speed_limit_kph_backward"] == "int32"
    assert types["other"] == "string"


def test_extracted_geometry_is_wkb(tmp_path: Path, importer) -> None:
    from shapely import wkb

    edges, nodes = _extract(tmp_path, importer)
    line = wkb.loads(edges[0]["geometry"])
    assert line.geom_type == "LineString"
    assert len(line.coords) >= 2
    point = wkb.loads(nodes[0]["geometry"])
    assert point.geom_type == "Point"


def test_geoparquet_metadata_is_present(tmp_path: Path, importer) -> None:
    """The runner detects the geometry column by its DuckDB type, which only
    resolves to GEOMETRY when the file carries GeoParquet metadata."""
    archive = _make_zip(tmp_path)
    workdir = tmp_path / "work"
    workdir.mkdir()
    layers = importer.extract_layers(str(archive), str(workdir))
    edges = next(layer for layer in layers if layer.role == "edges")
    metadata = pq.read_schema(edges.file_path).metadata or {}
    assert b"geo" in metadata


def test_minted_nodes_are_named_after_where_they_were_minted(
    tmp_path: Path, importer
) -> None:
    """A node minted at an attribute boundary carries it in its own id.

    `{segment_id}@{linear_reference}`, and no GERS id contains an "@" — which
    is why the layer holds no separate flag for it.
    """
    _, nodes = _extract(tmp_path, importer)
    assert sum(1 for n in nodes if "@" in n["id"]) == 4
    assert "is_synthetic" not in nodes[0]


def test_edge_topology_references_existing_nodes(tmp_path: Path, importer) -> None:
    """Every edge endpoint must resolve to a node, or the graph is broken."""
    edges, nodes = _extract(tmp_path, importer)
    node_ids = {n["id"] for n in nodes}
    for edge in edges:
        assert edge["source_node"] in node_ids
        assert edge["target_node"] in node_ids


def test_extract_without_segments_fails_loudly(tmp_path: Path, importer) -> None:
    """Splitting is mandatory: unsplit or absent Overture data is not routable, so
    the import fails rather than landing an unusable bundle."""
    from goatlib.bundles.importers.street_network.overture.reader import (
        OvertureReadError,
    )

    archive = _make_zip(tmp_path, connectors=False)
    workdir = tmp_path / "work"
    workdir.mkdir()
    with pytest.raises(OvertureReadError):
        importer.extract_layers(str(archive), str(workdir))


def test_only_writes_values_the_editor_allows(tmp_path: Path, importer) -> None:
    """The importer and the editor share one vocabulary per column.

    A value the importer can write but the editor's dropdown does not list
    cannot be re-saved: the write path refuses it, so the row becomes
    uneditable. Both columns are nullable and mostly null in real extracts, so
    this checks what is written rather than that every value appears.
    """
    from goatlib.models.bundle import (
        EDGE_SUBCLASSES,
        EDGE_SURFACES,
        ROUTING_CLASSES,
        BundleTypeName,
        get_spec,
    )

    edges, _ = _extract(tmp_path, importer)
    allowed = get_spec(BundleTypeName.street_network).role("edges").allowed_values
    assert set(allowed) == {"class", "subclass", "surface"}

    for column, vocabulary in (
        ("class", ROUTING_CLASSES),
        ("subclass", EDGE_SUBCLASSES),
        ("surface", EDGE_SURFACES),
    ):
        written = {e[column] for e in edges if e.get(column) is not None}
        assert written <= vocabulary, (column, written - vocabulary)
        # A vocabulary nothing exercises is a vocabulary nothing checks.
        assert written
