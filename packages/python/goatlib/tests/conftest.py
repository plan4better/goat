import fcntl
import logging
import sys
import tempfile
import urllib.request
from pathlib import Path
from typing import Literal

import pytest

# Add tests directory to path for fixture imports
_tests_dir = Path(__file__).parent
if str(_tests_dir) not in sys.path:
    sys.path.insert(0, str(_tests_dir))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
)

logger = logging.getLogger(__name__)


# A file another pod wrote is waited for (goatlib.utils.shared_disk); a test
# about a missing one should not wait the production minute and more.
@pytest.fixture(autouse=True)
def _short_shared_disk_wait(monkeypatch: pytest.MonkeyPatch) -> None:
    from goatlib.utils import shared_disk

    monkeypatch.setattr(shared_disk, "WAIT_SECONDS", 0.2)
    monkeypatch.setattr(shared_disk, "POLL_SECONDS", 0.01)


# ---------------------------------------------------------------------------
# Global root
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def data_root() -> Path:
    """Base directory containing all static test data (data/io)."""
    return Path(__file__).parent / "data"


# ---------------------------------------------------------------------------
# Raster
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def raster_valid(data_root: Path) -> Path:
    """Valid raster GeoTIFF."""
    return data_root / "io" / "raster" / "imagery.tif"


# ---------------------------------------------------------------------------
# Tabular (CSV / Excel)
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def tabular_valid_csv(data_root: Path) -> Path:
    return data_root / "io" / "tabular" / "valid" / "table.csv"


@pytest.fixture(scope="session")
def tabular_valid_csv_wkt_wgs84(data_root: Path) -> Path:
    """CSV with valid WKT geometry in WGS84."""
    return data_root / "io" / "tabular" / "valid" / "wkt_geometry_wgs84.csv"


@pytest.fixture(scope="session")
def tabular_invalid_csv_wkt_epsg3857(data_root: Path) -> Path:
    """CSV with WKT geometry in EPSG:3857 (outside WGS84 bounds)."""
    return data_root / "io" / "tabular" / "invalid" / "wkt_geometry_epsg3857.csv"


@pytest.fixture(scope="session")
def tabular_valid_xlsx(data_root: Path) -> Path:
    return data_root / "io" / "tabular" / "valid" / "table.xlsx"


@pytest.fixture(scope="session")
def tabular_valid_xlsx_multi_sheet(data_root: Path) -> Path:
    return data_root / "io" / "tabular" / "valid" / "multi_sheet.xlsx"


@pytest.fixture(scope="session")
def tabular_valid_xlsx_no_header(data_root: Path) -> Path:
    return data_root / "io" / "tabular" / "valid" / "no_header.xlsx"


@pytest.fixture(scope="session")
def tabular_valid_xlsx_colored_empty(data_root: Path) -> Path:
    return data_root / "io" / "tabular" / "valid" / "colored_empty_rows.xlsx"


@pytest.fixture(scope="session")
def tabular_valid_tsv(data_root: Path) -> Path:
    return data_root / "io" / "tabular" / "valid" / "table.tsv"


@pytest.fixture(scope="session")
def example_valid_txt(data_root: Path) -> Path:
    return data_root / "io" / "tabular" / "valid" / "example.txt"


@pytest.fixture(scope="session")
def tabular_invalid_no_header(data_root: Path) -> Path:
    return data_root / "io" / "tabular" / "invalid" / "no_header.csv"


@pytest.fixture(scope="session")
def tabular_invalid_bad_xlsx(data_root: Path) -> Path:
    return data_root / "io" / "tabular" / "invalid" / "bad_formed.xlsx"


# ---------------------------------------------------------------------------
# Vector (GeoJSON / GPKG / KML / KMZ / GPX / Shapefile)
# ---------------------------------------------------------------------------

VectorType = Literal["geojson", "gpkg", "kml", "shapefile"]


@pytest.fixture(scope="session", params=["geojson", "gpkg", "kml", "shapefile"])
def vector_type(request: pytest.FixtureRequest) -> VectorType:  # type: ignore[return-type]
    """Enumerate supported vector types."""
    return request.param


@pytest.fixture(scope="session")
def vector_valid_dir(data_root: Path, vector_type: VectorType) -> Path:
    """Sub‑directory with valid vector files for each format."""
    return data_root / "io" / "vector" / "valid" / vector_type


@pytest.fixture(scope="session")
def vector_invalid_zip(data_root: Path) -> Path:
    """Corrupted zipped shapefile (negative tests)."""
    return data_root / "io" / "vector" / "invalid" / "shapefile_missing_file.zip"


# ---------------------------------------------------------------------------
# Single‑file vector shortcuts (used by converter tests)
# ---------------------------------------------------------------------------


def _collect_vector_files(fmt: str) -> list[Path]:
    base = Path(__file__).parent / "data" / "io" / "vector" / "valid" / fmt
    if fmt == "shapefile":
        return sorted(base.glob("*.zip"))
    return sorted(base.glob(f"*.{fmt}"))


@pytest.fixture(
    params=_collect_vector_files("geojson"), ids=lambda p: p.name, scope="session"
)
def geojson_path(request: pytest.FixtureRequest) -> Path:
    """Each GeoJSON file (points, lines, polygons)."""
    return request.param


@pytest.fixture(
    params=_collect_vector_files("gpkg"), ids=lambda p: p.name, scope="session"
)
def gpkg_path(request: pytest.FixtureRequest) -> Path:
    """Each GeoPackage file."""
    return request.param


@pytest.fixture(
    params=_collect_vector_files("kml"), ids=lambda p: p.name, scope="session"
)
def kml_path(request: pytest.FixtureRequest) -> Path:
    """Each KML file."""
    return request.param


@pytest.fixture(
    params=_collect_vector_files("kmz"), ids=lambda p: p.name, scope="session"
)
def kmz_path(request: pytest.FixtureRequest) -> Path:
    """Each KMZ file."""
    return request.param


@pytest.fixture(
    params=_collect_vector_files("gpx"), ids=lambda p: p.name, scope="session"
)
def gpx_path(request: pytest.FixtureRequest) -> Path:
    """Each GPX file."""
    return request.param


@pytest.fixture(
    params=_collect_vector_files("shapefile"), ids=lambda p: p.name, scope="session"
)
def shapefile_path(request: pytest.FixtureRequest) -> Path:
    """Each zipped shapefile."""
    return request.param


@pytest.fixture(
    params=_collect_vector_files("mixed"), ids=lambda p: p.name, scope="session"
)
def mixed_content_path(request: pytest.FixtureRequest) -> Path:
    """Each mixed content file."""
    return request.param


# ---------------------------------------------------------------------------
# MOTIS adapter fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def motis_fixtures_dir(data_root: Path) -> Path:
    """Directory containing MOTIS fixture data for routing tests."""
    return data_root / "routing" / "motis"


@pytest.fixture(scope="session")
def buffered_stations_dir(data_root: Path) -> Path:
    """Directory containing buffered bus station test data."""
    return data_root / "routing" / "buffered_stations"


# ---------------------------------------------------------------------------
# Network extractor fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def network_extractor_data_dir(data_root: Path) -> Path:
    """Directory containing network extractor test data."""
    return data_root / "network"


@pytest.fixture(scope="session")
def network_file(network_extractor_data_dir: Path) -> Path:
    """Path to the test network parquet file."""
    return network_extractor_data_dir / "network.parquet"


@pytest.fixture(scope="session")
def extracted_network_file(network_extractor_data_dir: Path) -> Path:
    """Path to the test network parquet file."""
    return network_extractor_data_dir / "extracted_network.parquet"


# ---------------------------------------------------------------------------
# Travel time matrices fixtures (auto-download from S3 if not present)
# ---------------------------------------------------------------------------

TRAVELTIME_MATRICES_BASE_URL = (
    "https://assets.plan4better.de/goat/fixtures/traveltime_matrices"
)
TRAVELTIME_MATRICES_FILES = [
    "walking/h3_3=8077/h3_r10_munich.parquet",
]


def _download_file(url: str, dest: Path) -> None:
    """Download a file from URL to destination path.

    Written to a temporary name of this process's own and renamed only once
    complete: an interrupted download must not leave a partial file at
    `dest`, which every later run would take for the real one.
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    logger.info(f"Downloading {url} to {dest}...")
    with tempfile.NamedTemporaryFile(
        dir=dest.parent, prefix=dest.name, suffix=".partial", delete=False
    ) as handle:
        partial = Path(handle.name)
    try:
        urllib.request.urlretrieve(url, partial)
        partial.chmod(0o644)  # a temporary file starts private
        partial.replace(dest)
    finally:
        partial.unlink(missing_ok=True)
    logger.info(f"Downloaded {dest.name} ({dest.stat().st_size / 1024 / 1024:.1f} MB)")


def _is_complete_parquet(path: Path) -> bool:
    """A Parquet file ends with its magic bytes; a truncated one does not."""
    if not path.exists() or path.stat().st_size < 8:
        return False
    with path.open("rb") as f:
        f.seek(-4, 2)
        return f.read(4) == b"PAR1"


@pytest.fixture(scope="session")
def traveltime_matrices_dir() -> Path:
    """
    Directory containing travel time matrices for heatmap tests.

    Downloads the matrices if not already present locally, with hive
    partitioning. They live in a folder of their own under data/test_fixtures:
    the tools read every partition in the folder they're given, so a developer's
    real matrices in data/traveltime_matrices (a different schema) made these
    tests fail locally while they passed in CI.
    """
    matrices_dir = (
        Path(__file__).parent.parent.parent.parent.parent
        / "data"
        / "test_fixtures"
        / "traveltime_matrices"
    )

    for rel_path in TRAVELTIME_MATRICES_FILES:
        local_path = matrices_dir / rel_path
        if _is_complete_parquet(local_path):
            continue
        # CI runs the suite in several xdist workers, each with its own
        # session: one downloads while the others wait, then find it complete.
        local_path.parent.mkdir(parents=True, exist_ok=True)
        with open(local_path.with_name(local_path.name + ".lock"), "w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if not _is_complete_parquet(local_path):
                url = f"{TRAVELTIME_MATRICES_BASE_URL}/{rel_path}"
                _download_file(url, local_path)

    return matrices_dir


@pytest.fixture(scope="session")
def walking_matrix_dir(traveltime_matrices_dir: Path) -> Path:
    """Directory containing walking travel time matrices."""
    return traveltime_matrices_dir / "walking"
