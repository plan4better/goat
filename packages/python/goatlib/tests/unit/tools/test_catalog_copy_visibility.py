"""A catalog layer whose copy another node has just written.

The layer has no DuckLake table; its copy is a file on the shared volume that
this node may see only a moment later (goatlib.utils.shared_disk). The runner
waits for it when the layer row says the copy is ready, and otherwise falls
back to DuckLake at once.
"""

from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import duckdb
import pytest
from goatlib.tools import base
from goatlib.tools.base import BaseToolRunner
from goatlib.utils import shared_disk

LAYER = "de0ad127-9bd2-42cc-8a1e-a57da46c2364"


class _Runner(BaseToolRunner):
    def _get_duckdb_connection(self) -> duckdb.DuckDBPyConnection:
        return duckdb.connect()

    def process(self, params: Any, temp_dir: Path) -> Any:  # not exercised
        raise NotImplementedError


def _runner(ready: bool) -> _Runner:
    r = _Runner()
    r.settings = MagicMock()
    r._catalog_copy_ready = lambda layer_id: ready  # type: ignore[method-assign]
    r._ensure_catalog_view = lambda layer_id, path: f"view of {path.name}"  # type: ignore[method-assign]
    return r


def _appears_after(seen_missing: int, path: Path):
    calls = {"n": 0}

    def lookup(layer_id: str) -> Path | None:
        calls["n"] += 1
        return path if calls["n"] > seen_missing else None

    return lookup, calls


def test_a_ready_copy_not_visible_yet_is_waited_for(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(shared_disk, "WAIT_SECONDS", 5)
    copy = tmp_path / "t_de0ad1279bd242cc8a1ea57da46c2364.parquet"
    lookup, calls = _appears_after(3, copy)
    with (
        patch.object(base, "_catalog_layer_parquet", side_effect=lookup),
        patch.object(base, "resolve_layer_schema", return_value=None),
    ):
        assert _runner(ready=True).resolve_layer_table_path(LAYER) == (
            f"view of {copy.name}"
        )
    assert calls["n"] == 4


def test_a_ready_copy_that_never_appears_says_so(tmp_path: Path) -> None:
    with (
        patch.object(base, "_catalog_layer_parquet", return_value=None),
        patch.object(base, "resolve_layer_schema", return_value=None),
    ):
        with pytest.raises(ValueError, match="cannot be read on this server yet"):
            _runner(ready=True).resolve_layer_table_path(LAYER)


def test_a_layer_without_a_copy_falls_back_at_once(tmp_path: Path) -> None:
    lookup, calls = _appears_after(99, tmp_path / "never.parquet")
    with (
        patch.object(base, "_catalog_layer_parquet", side_effect=lookup),
        patch.object(base, "resolve_layer_schema", return_value=None),
    ):
        path = _runner(ready=False).resolve_layer_table_path(LAYER)
    assert path.endswith("t_de0ad1279bd242cc8a1ea57da46c2364")
    assert calls["n"] == 1
