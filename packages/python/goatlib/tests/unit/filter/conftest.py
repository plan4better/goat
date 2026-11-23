"""Shared fixtures for the goatlib.filter tests.

`fixtures/filter_cases.json` is shared with the web's tests: each case has a
`name`, the layer's `fields` (name to type), the filter's `cql`, the issue
codes `validate` reports in order of path, and optionally the `rows` the web's
reader shows (`{match, rows, area?}`, a row being `{field, op, value?, value2?}`
or `"custom"` for one the rows cannot say, `area` being `"inside"` or
`"outside"` when the reader takes a spatial condition as the filter's area;
`"custom"` alone for a filter that is no list of rows), `stable` when the
web's writer writes the filter back unchanged, and a `note`.
"""

import json
from pathlib import Path
from typing import Any

FIXTURES = Path(__file__).parent / "fixtures"


def load_cases() -> list[dict[str, Any]]:
    return json.loads((FIXTURES / "filter_cases.json").read_text())


def context(fields: dict[str, str]) -> Any:
    from goatlib.style.context import DataContext, FieldInfo

    return DataContext(
        kind="vector",
        geometry="polygon",
        fields={name: FieldInfo(name=name, type=t) for name, t in fields.items()},
    )
