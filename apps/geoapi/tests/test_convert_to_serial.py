"""Turning an existing number column into a serial (``convert_to_serial``).

A typical case: ``vorhaben_id`` holds 1-17 and 19 on 18 features, typed by
hand, and workflows, filters and dashboards refer to it by name. Converting
must keep the name and every value, and the next feature must get 20, not the
free 18.

Against a real, file-backed DuckLake, like ``test_generated_fields.py``.
"""

from __future__ import annotations

import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Generator
from unittest.mock import patch

import duckdb
import pytest
from goatlib.utils.generated_fields import GeneratedField, SerialCounters

from geoapi.dependencies import LayerInfo
from geoapi.services.feature_write_service import FeatureWriteService

LAYER_ID = "abc123de-f456-7890-1234-5678901234ab"
POINT = {"type": "Point", "coordinates": [7.1, 50.7]}
SERVICE = FeatureWriteService()
HAND_TYPED = [*range(1, 18), 19]


class _LockedManager:
    def __init__(self, con: duckdb.DuckDBPyConnection) -> None:
        self._con = con
        self._lock = threading.Lock()

    @contextmanager
    def connection(self) -> Generator[duckdb.DuckDBPyConnection, None, None]:
        with self._lock:
            yield self._con


@pytest.fixture()
def lake(tmp_path: Path) -> Generator[duckdb.DuckDBPyConnection, None, None]:
    con = duckdb.connect(":memory:")
    con.execute("INSTALL spatial; LOAD spatial; INSTALL ducklake; LOAD ducklake;")
    con.execute(
        f"ATTACH 'ducklake:{tmp_path}/meta.ducklake' AS lake "
        f"(DATA_PATH '{tmp_path}/data')"
    )
    con.execute("CREATE SCHEMA lake.s")
    with patch(
        "geoapi.services.feature_write_service.ducklake_write_manager",
        _LockedManager(con),
    ):
        yield con
    con.close()


def _layer(con: duckdb.DuckDBPyConnection, column_type: str, values: list) -> LayerInfo:
    """A layer whose ``vorhaben_id`` holds ``values``, one feature each."""
    con.execute(
        f"CREATE TABLE lake.s.t (geometry GEOMETRY, titel VARCHAR, "
        f"vorhaben_id {column_type}, status VARCHAR)"
    )
    for i, value in enumerate(values):
        con.execute(
            "INSERT INTO lake.s.t VALUES (ST_Point(7.1, 50.7), ?, ?, 'neu')",
            [f"V{i}", value],
        )
    return LayerInfo(layer_id=LAYER_ID, schema_name="s", table_name="t")


def _rows(con: duckdb.DuckDBPyConnection) -> list[tuple]:
    return con.execute(
        "SELECT rowid, titel, vorhaben_id FROM lake.s.t ORDER BY rowid"
    ).fetchall()


def _type(con: duckdb.DuckDBPyConnection) -> str:
    return dict((r[0], r[1]) for r in con.execute("DESCRIBE lake.s.t").fetchall())[
        "vorhaben_id"
    ]


def _convert(layer: LayerInfo, start: int = 1) -> tuple[dict, SerialCounters]:
    counters = SerialCounters()
    result = SERVICE.convert_to_serial(
        layer, GeneratedField("vorhaben_id", "serial", start), counters
    )
    return result, counters


def _create(
    layer: LayerInfo, marks: dict[str, int], start: int = 1, **properties: Any
) -> str:
    counters = SerialCounters(high_water=dict(marks))
    feature_id = SERVICE.create_feature(
        layer_info=layer,
        geometry=POINT,
        properties=properties,
        column_names=["geometry", "titel", "vorhaben_id", "status"],
        geometry_column="geometry",
        field_config={"vorhaben_id": {"kind": "serial", "start": start}},
        serial_counters=counters,
    )
    marks.update(counters.assigned)
    return feature_id


def test_a_hand_typed_column_keeps_its_numbers_and_continues_after_19(lake) -> None:
    """A GOAT "Number" column is DOUBLE: its values move into a BIGINT column
    of the same name. Same rows, same feature ids, same numbers; the mark is
    19, so the next feature gets 20 and 18 stays free."""
    layer = _layer(lake, "DOUBLE", [float(v) for v in HAND_TYPED])
    before = _rows(lake)

    result, counters = _convert(layer)

    assert result == {"filled": 0, "rebuilt": True, "max": 19}
    assert counters.assigned == {"vorhaben_id": 19}
    assert _type(lake) == "BIGINT"
    after = _rows(lake)
    assert [(r, t, int(v)) for r, t, v in before] == after
    assert [v for _, _, v in after] == HAND_TYPED

    marks = dict(counters.assigned)
    first = _create(layer, marks, vorhaben_id=18, titel="neu")
    value = lake.execute(
        "SELECT vorhaben_id FROM lake.s.t WHERE rowid = ?", [int(first) - 1]
    ).fetchone()[0]
    assert value == 20  # the typed 18 is ignored, and 18 is not handed out
    # Delete it again: still no reuse.
    SERVICE.delete_feature(layer, first)
    _create(layer, marks)
    assert sorted(v for _, _, v in _rows(lake)) == [*HAND_TYPED, 21]
    assert 18 not in [v for _, _, v in _rows(lake)]


def test_an_integer_column_becomes_bigint_and_max_still_works(lake) -> None:
    """Rebuilt, not ALTERed: an in-place INTEGER -> BIGINT promotion leaves
    max() failing on a connection that read the column's statistics before
    — exactly what the conversion's own checks just did."""
    layer = _layer(lake, "INTEGER", [3, 1, 2])
    lake.execute("SELECT max(vorhaben_id) FROM lake.s.t").fetchall()
    result, counters = _convert(layer)
    assert result["rebuilt"] is True
    assert _type(lake) == "BIGINT"
    assert [v for _, _, v in _rows(lake)] == [3, 1, 2]
    marks = dict(counters.assigned)
    _create(layer, marks)
    assert [v for _, _, v in _rows(lake)] == [3, 1, 2, 4]


def test_a_bigint_column_is_kept_as_it_is(lake) -> None:
    layer = _layer(lake, "BIGINT", [2, 1])
    result, _ = _convert(layer)
    assert result["rebuilt"] is False
    columns = [r[0] for r in lake.execute("DESCRIBE lake.s.t").fetchall()]
    assert columns == ["geometry", "titel", "vorhaben_id", "status"]


def test_a_rebuilt_column_moves_to_the_end_but_keeps_its_name(lake) -> None:
    layer = _layer(lake, "DOUBLE", [1.0, 2.0])
    _convert(layer)
    columns = [r[0] for r in lake.execute("DESCRIBE lake.s.t").fetchall()]
    assert columns == ["geometry", "titel", "status", "vorhaben_id"]


def test_blank_rows_are_numbered_after_the_highest_in_feature_order(lake) -> None:
    layer = _layer(lake, "DOUBLE", [3.0, None, 1.0, None])
    result, counters = _convert(layer)
    assert result["filled"] == 2
    assert [v for _, _, v in _rows(lake)] == [3, 4, 1, 5]
    assert counters.assigned == {"vorhaben_id": 5}


def test_blank_rows_start_at_start_when_it_is_above_the_values(lake) -> None:
    layer = _layer(lake, "BIGINT", [1, 2, None])
    _convert(layer, start=100)
    assert [v for _, _, v in _rows(lake)] == [1, 2, 100]


def test_duplicates_are_refused_and_nothing_changes(lake) -> None:
    layer = _layer(lake, "DOUBLE", [1.0, 2.0, 2.0, 5.0, 5.0, 5.0, 7.0])
    before = _rows(lake)
    with pytest.raises(ValueError) as refused:
        _convert(layer)
    message = str(refused.value)
    assert "more than once" in message
    assert "2 (2×)" in message and "5 (3×)" in message
    assert _type(lake) == "DOUBLE"
    assert _rows(lake) == before


def test_many_duplicates_list_a_few(lake) -> None:
    layer = _layer(lake, "BIGINT", [v for v in range(1, 9) for _ in range(2)])
    with pytest.raises(ValueError, match=r"and more"):
        _convert(layer)


@pytest.mark.parametrize(
    ("values", "fragment"),
    [([1.0, 1.5, 2.0], "1.5"), ([1.0, float("nan")], "not a whole number")],
)
def test_fractions_are_refused(lake, values: list, fragment: str) -> None:
    layer = _layer(lake, "DOUBLE", values)
    with pytest.raises(ValueError) as refused:
        _convert(layer)
    assert "not a whole number" in str(refused.value)
    assert fragment in str(refused.value)
    assert _type(lake) == "DOUBLE"


def test_a_decimal_fraction_is_refused(lake) -> None:
    layer = _layer(lake, "DECIMAL(10,2)", [1, 2.25])
    with pytest.raises(ValueError, match="not a whole number"):
        _convert(layer)


def test_a_text_column_is_refused(lake) -> None:
    layer = _layer(lake, "VARCHAR", ["1", "2"])
    with pytest.raises(ValueError, match="only a number column"):
        _convert(layer)


def test_a_system_column_is_refused(lake) -> None:
    layer = _layer(lake, "BIGINT", [1])
    with pytest.raises(ValueError, match="protected"):
        SERVICE.convert_to_serial(layer, GeneratedField("geometry", "serial"))


def test_an_empty_column_converts_and_starts_at_start(lake) -> None:
    layer = _layer(lake, "DOUBLE", [])
    result, counters = _convert(layer, start=10)
    assert result == {"filled": 0, "rebuilt": True, "max": None}
    assert counters.assigned == {}
    marks: dict[str, int] = {}
    _create(layer, marks, start=10)
    assert [v for _, _, v in _rows(lake)] == [10]
