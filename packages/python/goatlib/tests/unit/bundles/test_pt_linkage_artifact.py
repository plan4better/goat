"""The PT stop-to-street linkage artifact.

The build itself needs the routing extension and a real network, so what is
pinned here is everything around it: which inputs are refused and how, that a
refusal costs only the linkage, and that the archive a build writes is the one
a consumer can read a single mode out of.
"""

import sys
import tarfile
import zipfile
from pathlib import Path

import pytest
from goatlib.bundles.artifacts.base import BuiltArtifact
from goatlib.bundles.artifacts.build_mixin import BundleArtifactBuildMixin
from goatlib.bundles.artifacts.gtfs import (
    DEFAULT_LINKAGE_MODES,
    LINKAGE_MODES,
    GtfsArtifactBuilder,
    UnlinkableStopsError,
    linkage_member,
    unpack_pt_linkage,
)
from goatlib.models.bundle import BundleArtifactKind, BundleTypeName, get_spec

STREET = {"edge_path": "/edges.parquet", "node_path": "/nodes.parquet"}


@pytest.fixture
def builder() -> GtfsArtifactBuilder:
    return GtfsArtifactBuilder()


def test_builder_produces_both_declared_artifacts(builder) -> None:
    """The spec declares two; a kind the spec declares and nothing builds shows
    as an artifact that never appears, which reads as "still importing"."""
    spec = get_spec(builder.bundle_type)
    assert set(builder.produces) == set(spec.artifacts)


def test_walking_is_the_default_and_modes_deduplicate(builder) -> None:
    assert DEFAULT_LINKAGE_MODES == ("walking",)
    assert builder._requested_modes(None) == ("walking",)
    assert builder._requested_modes({}) == ("walking",)
    assert builder._requested_modes({"linkage_modes": ["car", "car", "walking"]}) == (
        "car",
        "walking",
    )


def test_an_unusable_street_network_is_reported_not_raised(builder, tmp_path) -> None:
    """No street network in the dependencies means a linked one is broken — the
    caller substitutes the default network when nothing is linked. Reported as
    a failed artifact rather than raised, so the caller records which kind
    failed before failing the build."""
    result = builder._build_linkage(
        timetable_path="/tt.bin",
        workdir=str(tmp_path),
        dependencies={},
        modes=("walking",),
    )
    assert result.kind is BundleArtifactKind.pt_network_linkage
    assert result.local_path is None
    assert "not ready to route on" in result.error


@pytest.mark.asyncio
async def test_an_unlinked_bundle_falls_back_to_the_default_network(
    tmp_path,
) -> None:
    """A PT bundle is usable without a street network of its own: the stops
    still have to reach somewhere, so the linkage is computed against the
    default global network."""

    class _Db:
        async def get_bundle_dependency(self, bundle_id: str, kind: str) -> None:
            return None

    class _Settings:
        street_network_edges_base_path = "/global/edges"
        street_network_nodes_base_path = "/global/nodes"

    class _Runner(BundleArtifactBuildMixin):
        settings = _Settings()

    resolved = await _Runner()._resolve_dependencies(
        _Db(),
        bundle_id="b",
        spec=get_spec(BundleTypeName.pt_network_gtfs),
        workdir=str(tmp_path),
    )
    assert resolved["street_network"] == {
        "bundle_id": None,
        "edge_path": "/global/edges",
        "node_path": "/global/nodes",
    }


def test_unknown_mode_names_the_ones_that_exist(builder, tmp_path) -> None:
    result = builder._build_linkage(
        timetable_path="/tt.bin",
        workdir=str(tmp_path),
        dependencies={"street_network": STREET},
        modes=("hovercraft",),
    )
    assert "hovercraft" in result.error
    for mode in LINKAGE_MODES:
        assert mode in result.error


def test_a_built_artifact_is_a_file_or_a_reason_never_both() -> None:
    kind = BundleArtifactKind.pt_network_linkage
    with pytest.raises(ValueError):
        BuiltArtifact(kind=kind)
    with pytest.raises(ValueError):
        BuiltArtifact(kind=kind, local_path="/x.tar", error="also failed")


def _archive(root: Path, *modes: str) -> Path:
    src = root / "src"
    src.mkdir()
    archive = root / "pt_network_linkage.tar"
    with tarfile.open(archive, "w") as tar:
        for mode in modes:
            member = src / linkage_member(mode)
            member.write_bytes(b"parquet")
            tar.add(member, arcname=member.name)
    return archive


def test_one_mode_is_read_back_out_of_the_archive(tmp_path) -> None:
    archive = _archive(tmp_path, "walking", "car")
    table = unpack_pt_linkage(archive, tmp_path / "dest", "walking")
    assert Path(table).name == linkage_member("walking")
    assert Path(table).exists()


def test_a_mode_the_bundle_lacks_says_what_it_has(tmp_path) -> None:
    archive = _archive(tmp_path, "walking")
    with pytest.raises(ValueError) as excinfo:
        unpack_pt_linkage(archive, tmp_path / "dest", "car")
    message = str(excinfo.value)
    assert "car" in message
    assert "walking" in message


class _FakeRoutingMode:
    Walking = "walking"
    Bicycle = "bicycle"
    Pedelec = "pedelec"
    Car = "car"


class _FakeConfig:
    """Stands in for `routing.AccessEgressConfig` — plain attributes."""

    timetable_path = ""
    edge_dir = ""
    node_dir = ""
    output_path = ""
    mode = None
    max_min = 0.0


def _fake_routing(rows: int):
    """A `routing` module whose table build writes `rows` stop/cell pairs."""
    import types

    import duckdb

    module = types.ModuleType("routing")
    module.RoutingMode = _FakeRoutingMode
    module.AccessEgressConfig = _FakeConfig

    def build_access_egress_table(cfg):
        con = duckdb.connect()
        try:
            con.execute(
                "COPY (SELECT * FROM (VALUES (1::UINTEGER, 2::UBIGINT, 3::UTINYINT)) "
                "AS t(stop_idx, h3_index, cost_minutes) "
                f"WHERE {rows} > 0) TO '{cfg.output_path}' (FORMAT PARQUET)"
            )
        finally:
            con.close()
        return cfg.output_path

    def build_timetable(source_path, out_path, start_date, length_days):
        Path(out_path).write_bytes(b"timetable")

    module.build_access_egress_table = build_access_egress_table
    module.build_timetable = build_timetable
    return module


def test_a_feed_no_stop_of_which_links_fails_the_import(builder, tmp_path, monkeypatch):
    """An empty table is not a stage that failed but a pairing that cannot
    work: the bundle would answer every accessibility question with nothing.
    Raised rather than reported, so the caller deletes the half-built bundle."""
    monkeypatch.setitem(sys.modules, "routing", _fake_routing(rows=0))

    with pytest.raises(UnlinkableStopsError) as excinfo:
        builder._build_linkage(
            timetable_path="/tt.bin",
            workdir=str(tmp_path),
            dependencies={"street_network": STREET},
            modes=("walking",),
        )
    assert "different region" in str(excinfo.value)


def test_a_feed_whose_stops_link_produces_the_archive(builder, tmp_path, monkeypatch):
    monkeypatch.setitem(sys.modules, "routing", _fake_routing(rows=1))

    result = builder._build_linkage(
        timetable_path="/tt.bin",
        workdir=str(tmp_path),
        dependencies={"street_network": STREET},
        modes=("walking",),
    )
    assert result.error is None
    with tarfile.open(result.local_path) as tar:
        assert tar.getnames() == [linkage_member("walking")]


def test_the_timetable_records_the_window_it_was_built_for(
    builder, tmp_path, monkeypatch
) -> None:
    """The feed is not kept, so a build that does not write the window down
    leaves nothing able to ask again — and outside it every journey comes back
    "no service"."""
    monkeypatch.setitem(sys.modules, "routing", _fake_routing(rows=1))
    feed = tmp_path / "gtfs.zip"
    _write_feed(feed, start="20260301", end="20260628")

    built = builder.build(
        source_path=str(feed),
        workdir=str(tmp_path),
        dependencies={"street_network": STREET},
    )

    timetable = next(
        art for art in built if art.kind is BundleArtifactKind.pt_network_graph
    )
    assert timetable.properties == {
        "service_start": "2026-03-01",
        "service_days": 120,
    }
    assert Path(timetable.local_path).exists()


def _write_feed(path: Path, *, start: str, end: str) -> None:
    """The smallest feed `_date_window` reads: one calendar row."""
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr(
            "calendar.txt",
            f"service_id,start_date,end_date\ns1,{start},{end}\n",
        )


def test_a_feed_zipped_as_a_folder_is_repackaged_at_the_root(tmp_path) -> None:
    """nigiri looks for the GTFS files at the archive root and refuses one where
    they sit in a folder — which is what compressing a directory produces. The
    feed is complete, so it is repackaged rather than refused."""
    from goatlib.bundles.artifacts.gtfs import _root_level_feed

    nested = tmp_path / "nested.zip"
    with zipfile.ZipFile(nested, "w") as zf:
        zf.writestr("paris_gtfs/stops.txt", "stop_id\nS1\n")
        zf.writestr("paris_gtfs/agency.txt", "agency_id\n1\n")
        zf.writestr("__MACOSX/._stops.txt", "junk")

    out = _root_level_feed(str(nested), str(tmp_path))

    assert out != str(nested)
    with zipfile.ZipFile(out) as zf:
        # The folder is gone, and so is the junk the compressor added.
        assert sorted(zf.namelist()) == ["agency.txt", "stops.txt"]


def test_a_flat_feed_is_left_alone(tmp_path) -> None:
    """Nothing to repackage, so nothing is rewritten."""
    from goatlib.bundles.artifacts.gtfs import _root_level_feed

    flat = tmp_path / "flat.zip"
    with zipfile.ZipFile(flat, "w") as zf:
        zf.writestr("stops.txt", "stop_id\nS1\n")

    assert _root_level_feed(str(flat), str(tmp_path)) == str(flat)


def test_an_archive_holding_two_feeds_is_not_guessed_at(tmp_path) -> None:
    """Which of them was meant is not knowable here; the loader's refusal is a
    better answer than repackaging the wrong one."""
    from goatlib.bundles.artifacts.gtfs import _root_level_feed

    two = tmp_path / "two.zip"
    with zipfile.ZipFile(two, "w") as zf:
        zf.writestr("a/stops.txt", "stop_id\nS1\n")
        zf.writestr("b/stops.txt", "stop_id\nS2\n")

    assert _root_level_feed(str(two), str(tmp_path)) == str(two)
