"""core must run on its own image, which has no geospatial stack.

core installs plain `goatlib`; the heavy libraries live behind goatlib's `full`
extra and are installed only where the jobs run. The development container has
them anyway — it also hosts geoapi and the tools worker — so importing a
module core is not entitled to succeeds locally and fails only once deployed.
That gap has cost twice: first core could not start at all
(`ModuleNotFoundError: No module named 'duckdb'`), then street-network uploads
answered 503 because validating one reads parquet.

These tests make the constraint testable where it is violated rather than where
it is deployed: the stack is hidden, and everything core does with an upload
has to keep working.
"""

import builtins
import importlib
import sys
import zipfile
from pathlib import Path

import pytest

#: goatlib's `full` extra, as core's image would (not) have it.
ABSENT = ("pyarrow", "duckdb", "shapely", "geopandas", "pyproj", "osgeo", "routing")


@pytest.fixture
def without_geospatial_stack(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make the heavy libraries unimportable, as they are on core's image."""
    real_import = builtins.__import__

    def guarded(name: str, *args: object, **kwargs: object) -> object:
        root = name.split(".")[0]
        if root in ABSENT:
            raise ModuleNotFoundError(f"No module named {root!r}")
        return real_import(name, *args, **kwargs)  # type: ignore[arg-type]

    for mod in list(sys.modules):
        if mod.split(".")[0] in ABSENT:
            monkeypatch.delitem(sys.modules, mod, raising=False)
    monkeypatch.setattr(builtins, "__import__", guarded)


def test_the_importer_registry_loads(without_geospatial_stack: None) -> None:
    """core imports the registry for `infer_bundle_type` and `get_importer`.

    Importing a module registers its importer, so the concrete importers must
    stay importable with their heavy dependencies deferred into the functions
    that use them.
    """
    registry = importlib.import_module("goatlib.bundles.importers")
    importlib.reload(registry)

    assert registry.get_importer("street_network") is not None
    assert registry.get_importer("pt_network_gtfs") is not None


def test_a_bundle_upload_can_still_be_typed(
    without_geospatial_stack: None, tmp_path: Path
) -> None:
    """Type inference is the one thing core does with the payload, because the
    bundle row it creates carries the type. It reads entry names only."""
    registry = importlib.import_module("goatlib.bundles.importers")
    importlib.reload(registry)

    overture = tmp_path / "paris.zip"
    with zipfile.ZipFile(overture, "w") as zf:
        zf.writestr("segments.parquet", b"")
        zf.writestr("connectors.parquet", b"")
    assert registry.infer_bundle_type("paris.zip", str(overture)) is not None

    gtfs = tmp_path / "gtfs_paris.zip"
    with zipfile.ZipFile(gtfs, "w") as zf:
        zf.writestr("stops.txt", "stop_id\n1\n")
        zf.writestr("routes.txt", "route_id\n1\n")
    assert registry.infer_bundle_type("gtfs_paris.zip", str(gtfs)) is not None


def test_the_bundle_endpoints_import(without_geospatial_stack: None) -> None:
    """The module core serves bundle uploads from, loaded as its image would.

    Guards the whole import graph reachable from it, which is what broke the
    first time: a module-scope geospatial import anywhere below this line stops
    core from starting.
    """
    module = importlib.import_module("core.endpoints.v2.bundle")
    importlib.reload(module)

    assert hasattr(module, "infer_bundle_type")
    # Validation belongs to the import job: it reads the payload, which needs
    # the stack this test hides — and a refusal raised here reaches nobody,
    # while a failed job is reported to whoever uploaded the file.
    assert not hasattr(module, "get_importer")


def test_the_style_migration_imports(without_geospatial_stack: None) -> None:
    """Alembic runs the GOAT Style data migration in core's image."""
    for name in list(sys.modules):
        if name.startswith("goatlib.style"):
            del sys.modules[name]
    migrate = importlib.import_module("goatlib.style.migrate")
    ctx = migrate.context_for("feature", "polygon", None)
    result = migrate.migrate_style(
        {"color": [1, 2, 3], "filled": True}, ctx, fingerprint="ducklake:1", at="t"
    )
    assert result.document["kind"] == "vector" and not result.fell_back


def test_a_raster_style_with_a_band_formula_validates_without_the_raster_stack(
    without_geospatial_stack: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """core validates raster styles; the formula parser it shares with the raster
    service must not need numpy or rio-tiler (goatlib's `raster` extra)."""
    guarded = builtins.__import__

    def without_raster(name: str, *args: object, **kwargs: object) -> object:
        if name.split(".")[0] in ("numpy", "rasterio", "rio_tiler"):
            raise ModuleNotFoundError(f"No module named {name.split('.')[0]!r}")
        return guarded(name, *args, **kwargs)  # type: ignore[arg-type]

    for name in list(sys.modules):
        if name.startswith(("goatlib.style", "goatlib.raster", "numpy")):
            monkeypatch.delitem(sys.modules, name, raising=False)
    monkeypatch.setattr(builtins, "__import__", without_raster)
    validate = importlib.import_module("goatlib.style.validate")
    context = importlib.import_module("goatlib.style.context")
    band = {"name": "NDVI", "expression": "(b4 - b1) / (b4 +"}
    doc = {
        "version": 1,
        "kind": "raster",
        "render": {"type": "continuous", "band": band, "domain": [-1, 1]},
    }
    codes = {i.code for i in validate.validate(doc, context.DataContext(kind="raster"))}
    assert "invalid_band_expression" in codes
