"""The self-heal rules for a catalog layer's materialize job."""

import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import UUID

import pytest
from core.core.config import Settings
from core.services.materialize_heal import (
    PENDING_REENQUEUE_AFTER,
    RUNNING_STALE_AFTER,
    copy_on_disk,
    decide_heal,
)

NOW = datetime(2026, 8, 27, 12, 0, tzinfo=timezone.utc)


def _doc(status: str, age: timedelta | None = None, **extra: object) -> dict:
    doc: dict = {"status": status, **extra}
    if age is not None:
        doc["updated_at"] = (NOW - age).isoformat()
    return doc


def test_failed_is_retried_and_reset() -> None:
    d = decide_heal(_doc("failed", timedelta(seconds=5)), now=NOW)
    assert d.should_enqueue and d.reset_to_pending


def test_a_fresh_pending_is_a_queued_job_and_is_left_alone() -> None:
    """Re-enqueueing it would race the job that is about to start."""
    d = decide_heal(_doc("pending", timedelta(seconds=10)), now=NOW)
    assert not d.should_enqueue


def test_an_old_pending_is_a_lost_enqueue() -> None:
    d = decide_heal(_doc("pending", PENDING_REENQUEUE_AFTER), now=NOW)
    assert d.should_enqueue and not d.reset_to_pending


def test_a_pending_without_a_stamp_predates_stamps_and_is_retried() -> None:
    assert decide_heal(_doc("pending"), now=NOW).should_enqueue


def test_a_live_running_job_is_left_alone() -> None:
    d = decide_heal(_doc("running", timedelta(minutes=5)), now=NOW)
    assert not d.should_enqueue


def test_a_stale_running_job_is_a_dead_worker() -> None:
    """Nothing records a heartbeat, so age is the only signal there is."""
    d = decide_heal(_doc("running", RUNNING_STALE_AFTER), now=NOW)
    assert d.should_enqueue and d.reset_to_pending


def test_ready_is_done() -> None:
    assert not decide_heal(_doc("ready", timedelta(days=1)), now=NOW).should_enqueue


def test_ready_with_failed_tiles_rebuilds_the_cache() -> None:
    """The data is served either way; without this the PMTiles never come."""
    d = decide_heal(
        _doc("ready", timedelta(hours=1), tiles="failed: disk full"), now=NOW
    )
    assert d.should_enqueue and not d.reset_to_pending


def test_no_document_at_all_is_retried() -> None:
    assert decide_heal(None, now=NOW).should_enqueue


def test_ready_with_its_file_missing_is_rebuilt_and_reset() -> None:
    """Lost storage or a database restored without its files: the document
    still says ready, but tools and tiles fail on the layer for good."""
    d = decide_heal(_doc("ready", timedelta(days=1)), now=NOW, copy_present=False)
    assert d.should_enqueue and d.reset_to_pending
    assert d.reason == "ready, file missing"


def test_ready_with_its_file_present_is_done() -> None:
    d = decide_heal(_doc("ready", timedelta(days=1)), now=NOW, copy_present=True)
    assert not d.should_enqueue


def test_ready_with_an_unknown_file_keeps_trusting_the_document() -> None:
    """An unreadable directory must not turn every re-add into a rebuild."""
    d = decide_heal(_doc("ready", timedelta(days=1)), now=NOW, copy_present=None)
    assert not d.should_enqueue


def test_a_missing_file_outranks_failed_tiles() -> None:
    """Tiles are rebuilt from the file, so the file comes first, and the tree
    shows "preparing" while it does."""
    d = decide_heal(
        _doc("ready", timedelta(hours=1), tiles="failed: disk full"),
        now=NOW,
        copy_present=False,
    )
    assert d.should_enqueue and d.reset_to_pending
    assert d.reason == "ready, file missing"


def test_a_queued_job_has_not_written_its_file_yet() -> None:
    """No file is expected before the job finishes; only `ready` promises one."""
    d = decide_heal(_doc("pending", timedelta(seconds=10)), now=NOW, copy_present=False)
    assert not d.should_enqueue
    d = decide_heal(_doc("running", timedelta(minutes=5)), now=NOW, copy_present=False)
    assert not d.should_enqueue


LAYER_ID = UUID("0b8a6f1e-3c2d-4e5f-8a9b-1c2d3e4f5a6b")


def _copy(layers_dir: Path) -> Path:
    return layers_dir / f"t_{LAYER_ID.hex}.parquet"


def test_the_copy_is_found_where_the_job_writes_it(tmp_path: Path) -> None:
    _copy(tmp_path).write_bytes(b"PAR1")
    assert copy_on_disk(tmp_path, LAYER_ID, "feature") is True
    assert copy_on_disk(tmp_path, LAYER_ID, "table") is True


def test_a_copy_missing_from_its_directory_is_missing(tmp_path: Path) -> None:
    assert copy_on_disk(tmp_path, LAYER_ID, "feature") is False


def test_a_missing_directory_is_lost_storage(tmp_path: Path) -> None:
    """The job creates the directory with its first file, so a volume that
    lost everything has no directory either."""
    assert copy_on_disk(tmp_path / "layers", LAYER_ID, "feature") is False


@pytest.mark.skipif(os.geteuid() == 0, reason="root reads any directory")
def test_an_unreadable_directory_is_unknown(tmp_path: Path) -> None:
    layers = tmp_path / "layers"
    layers.mkdir()
    _copy(layers).write_bytes(b"PAR1")
    layers.chmod(0)
    try:
        assert copy_on_disk(layers, LAYER_ID, "feature") is None
    finally:
        layers.chmod(0o755)


def test_a_layer_type_without_a_parquet_copy_is_not_judged(tmp_path: Path) -> None:
    """The job writes a parquet for feature and table layers only."""
    assert copy_on_disk(tmp_path, LAYER_ID, "raster") is None
    assert copy_on_disk(tmp_path, LAYER_ID, None) is None


def test_the_copy_name_is_the_writers() -> None:
    """core cannot import goatlib's layer helpers (their module needs the
    stack core's image lacks), so the name is spelled twice; this keeps the
    two the same."""
    from goatlib.utils.layer import layer_id_to_table_name

    assert _copy(Path(".")).name == f"{layer_id_to_table_name(str(LAYER_ID))}.parquet"


@pytest.fixture
def _settings_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AUTH", "false")
    monkeypatch.setenv("POSTGRES_SERVER", "localhost")
    monkeypatch.setenv("POSTGRES_USER", "goat")
    monkeypatch.setenv("POSTGRES_PASSWORD", "goat")
    monkeypatch.setenv("POSTGRES_DB", "goat")


@pytest.mark.usefixtures("_settings_env")
def test_core_looks_where_the_writer_writes(monkeypatch: pytest.MonkeyPatch) -> None:
    """CATALOG_LAYERS_DIR wins, else DATA_DIR/catalog/layers, as for the job
    and geoapi."""
    from goatlib.utils.layer import catalog_layers_dir

    monkeypatch.delenv("CATALOG_LAYERS_DIR", raising=False)
    assert Path(Settings().CATALOG_LAYERS_DIR) == catalog_layers_dir()

    monkeypatch.setenv("CATALOG_LAYERS_DIR", "/srv/catalog-layers")
    assert Settings().CATALOG_LAYERS_DIR == "/srv/catalog-layers"
    assert catalog_layers_dir() == Path("/srv/catalog-layers")
