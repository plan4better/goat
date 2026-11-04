"""mirror_query: a timed-out mirror query stops, freeing its thread."""

import duckdb
import pytest

from processes import ducklake


def test_a_query_past_the_timeout_is_interrupted(monkeypatch) -> None:
    db = duckdb.connect()
    monkeypatch.setattr(ducklake, "mirror_cursor", db.cursor)
    monkeypatch.setattr(ducklake.settings, "ANALYTICS_QUERY_TIMEOUT", 0.2)
    with pytest.raises(duckdb.InterruptException):
        with ducklake.mirror_query() as con:
            con.execute(
                "SELECT count(*) FROM range(10000000000) a, range(10) b"
            ).fetchone()


def test_a_query_within_the_timeout_answers(monkeypatch) -> None:
    db = duckdb.connect()
    monkeypatch.setattr(ducklake, "mirror_cursor", db.cursor)
    with ducklake.mirror_query() as con:
        assert con.execute("SELECT 42").fetchone() == (42,)
