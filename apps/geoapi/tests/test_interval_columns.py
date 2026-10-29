"""INTERVAL columns (a GTFS time such as 25:10:00) are text, not numbers.

"int" is a substring of "interval", which every integer check on a type name
would otherwise match.
"""

from datetime import timedelta

import duckdb

from geoapi.routers.features_write import _duckdb_type_to_kind
from geoapi.services.feature_service import _json_value_expr, format_interval
from geoapi.services.layer_service import LayerService


def test_an_interval_is_a_string_not_an_integer() -> None:
    assert LayerService._duckdb_to_json_type("INTERVAL") == "string"
    assert LayerService._duckdb_to_json_type("INTEGER") == "integer"
    assert _duckdb_type_to_kind("INTERVAL") == "string"


def test_both_feature_paths_render_a_time_past_midnight_alike() -> None:
    # The single-feature path formats the Python value...
    assert format_interval(timedelta(days=1, seconds=600)) == "24:10:00"
    assert format_interval(timedelta(hours=7, minutes=5)) == "07:05:00"
    # ...and the items path the stored value, in SQL.
    rendered = duckdb.execute(
        f"SELECT {_json_value_expr('t', 'INTERVAL')} "
        "FROM (SELECT CAST('24:10:00' AS INTERVAL) AS t UNION ALL SELECT NULL)"
    ).fetchall()
    assert rendered == [("24:10:00",), (None,)]
