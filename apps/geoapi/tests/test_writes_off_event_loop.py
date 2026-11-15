"""The write routes keep DuckDB off the event loop.

A DuckLake write that waits (on the catalog in Postgres, on NFS) must block
only its own request. Run on the event loop, it froze the whole pod: no tile,
no feature read and no /healthz until the write returned.
"""

import ast
from pathlib import Path

import geoapi.routers.features_write as features_write

SERVICE = "feature_write_service"


def _direct_service_calls(tree: ast.AST) -> list[str]:
    """Calls ``feature_write_service.<method>(...)`` made directly, not handed
    to ``asyncio.to_thread``."""
    found = []
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id == SERVICE
        ):
            found.append(f"{node.func.attr} (line {node.lineno})")
    return found


def test_write_routes_run_duckdb_in_a_thread() -> None:
    tree = ast.parse(Path(features_write.__file__).read_text())
    assert _direct_service_calls(tree) == []


def test_the_service_calls_go_through_to_thread() -> None:
    """Guards the check above against passing because the calls moved away."""
    tree = ast.parse(Path(features_write.__file__).read_text())
    handed_over = [
        node.args[0].attr
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "to_thread"
        and node.args
        and isinstance(node.args[0], ast.Attribute)
        and isinstance(node.args[0].value, ast.Name)
        and node.args[0].value.id == SERVICE
    ]
    assert "create_features_bulk" in handed_over
    assert len(handed_over) >= 16
