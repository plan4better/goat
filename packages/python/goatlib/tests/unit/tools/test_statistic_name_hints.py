"""The editor's hint for an empty result name is the name the run writes.

Join and aggregate points name a statistic `{field}_{operation}`, dissolve and
aggregate polygon `{operation}_{field}`. The editor shows the placeholder a
schema gives (a statistics selector falls back to `{field}_{operation}`), and
the assistant reads the result name's description.
"""

import json
import re

import pytest
from goatlib.i18n import resolve_schema_translations
from goatlib.tools.aggregate_points import AggregatePointsToolParams
from goatlib.tools.aggregate_polygon import AggregatePolygonToolParams
from goatlib.tools.dissolve import DissolveToolParams
from goatlib.tools.join import JoinToolParams

FIELD_FIRST = "{field}_{operation}"
OPERATION_FIRST = "{operation}_{field}"


def _ui(prop: dict) -> dict:
    """A property's x-ui, also when it sits beside an anyOf."""
    return prop.get("x-ui", {})


def _placeholder(schema: dict, setting: str) -> str | None:
    """The placeholder the editor shows for an empty result name."""
    prop = schema["properties"][setting]
    if _ui(prop).get("widget") == "field-statistics-selector":
        options = _ui(prop).get("widget_options", {})
        return options.get("placeholder_template", FIELD_FIRST)
    result_name = _item(schema, setting)["properties"]["result_name"]
    return _ui(result_name).get("widget_options", {}).get("placeholder_template")


def _item(schema: dict, setting: str) -> dict:
    ref = re.search(
        r'"\$ref": "#/\$defs/(\w+)"', json.dumps(schema["properties"][setting])
    )
    assert ref, setting
    return schema["$defs"][ref.group(1)]


@pytest.mark.parametrize(
    ("params_class", "setting", "order"),
    [
        (AggregatePointsToolParams, "column_statistics", FIELD_FIRST),
        (AggregatePolygonToolParams, "column_statistics", OPERATION_FIRST),
        (DissolveToolParams, "field_statistics", OPERATION_FIRST),
        (JoinToolParams, "column_statistics", FIELD_FIRST),
    ],
)
def test_the_result_name_hints_name_the_column_the_run_writes(
    params_class: type, setting: str, order: str
) -> None:
    raw = params_class.model_json_schema()
    assert _placeholder(raw, setting) == order

    result_name = _item(raw, setting)["properties"]["result_name"]
    assert order in result_name["description"]
    for language in ("en", "de"):
        schema = resolve_schema_translations(raw, language)
        described = _ui(_item(schema, setting)["properties"]["result_name"])
        assert order in described["description"], language
