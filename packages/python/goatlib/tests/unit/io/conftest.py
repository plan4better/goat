from typing import Any

import duckdb
import pytest
from goatlib.io.converter import IOConverter


class _RecordingConnection:
    """A DuckDB connection that keeps every statement it is asked to run."""

    def __init__(self, con: duckdb.DuckDBPyConnection, statements: list[str]) -> None:
        self._con = con
        self._statements = statements

    def execute(self, query: str, *args: Any, **kwargs: Any) -> Any:
        self._statements.append(str(query))
        return self._con.execute(query, *args, **kwargs)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._con, name)


@pytest.fixture
def recorded(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Every statement the converters created during the test send to DuckDB."""
    statements: list[str] = []
    original_init = IOConverter.__init__

    def recording_init(self: IOConverter) -> None:
        original_init(self)
        self.con = _RecordingConnection(self.con, statements)

    monkeypatch.setattr(IOConverter, "__init__", recording_init)
    return statements
