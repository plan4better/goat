"""An overwrite makes tiles only for a table with rows.

A new layer and a temp result without rows get no PMTiles; their tiles come
from the table itself. An overwrite (a workflow re-run, a layer refresh) with
no rows does the same, rather than run tippecanoe on an empty GeoJSON.
"""

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from goatlib.io import pmtiles
from goatlib.tools.layer_replace import LayerReplaceMixin


class _Host(LayerReplaceMixin):
    duckdb_con = None

    def __init__(self, tiles_dir: Path) -> None:
        self.settings = SimpleNamespace(
            pmtiles_enabled=True,
            pmtiles_min_zoom=0,
            pmtiles_max_zoom=14,
            tiles_data_dir=str(tiles_dir),
        )


@pytest.fixture
def tiles_made(monkeypatch: pytest.MonkeyPatch) -> list[Any]:
    made: list[Any] = []
    monkeypatch.setattr(
        pmtiles.PMTilesGenerator,
        "generate_from_table",
        lambda self, **kwargs: made.append(kwargs["table_name"]),
    )
    return made


def _table(feature_count: int) -> dict[str, Any]:
    return {
        "table_name": "lake.user_1.t_1",
        "feature_count": feature_count,
        "columns": {"id": "INTEGER", "geometry": "GEOMETRY"},
        "geometry_column": "geometry",
    }


def test_no_tiles_for_an_overwrite_without_rows(
    tiles_made: list[Any], tmp_path: Path
) -> None:
    _Host(tmp_path)._regenerate_pmtiles(user_id="u", layer_id="l", table_info=_table(0))
    assert tiles_made == []


def test_tiles_for_an_overwrite_with_rows(
    tiles_made: list[Any], tmp_path: Path
) -> None:
    _Host(tmp_path)._regenerate_pmtiles(user_id="u", layer_id="l", table_info=_table(3))
    assert tiles_made == ["lake.user_1.t_1"]
