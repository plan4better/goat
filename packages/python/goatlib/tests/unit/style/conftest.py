"""Shared fixtures and helpers for the goatlib.style tests.

The fixtures hold the checked examples of the GOAT Style specification
(`docs/style-spec.md`, the JSON examples under a `<!-- check: ... -->` comment)
and the sample datasets the examples refer to. An example's `line` serves only
as a test id.
"""

import json
from pathlib import Path
from typing import Any

import pytest

FIXTURES = Path(__file__).parent / "fixtures"


def load_examples() -> list[dict[str, Any]]:
    return json.loads((FIXTURES / "spec_examples.json").read_text())


@pytest.fixture(scope="session")
def spec_examples() -> list[dict[str, Any]]:
    return load_examples()


@pytest.fixture(scope="session")
def contexts() -> dict[str, Any]:
    from goatlib.style.context import DataContext

    raw = json.loads((FIXTURES / "sample_datasets.json").read_text())
    return {name: DataContext.from_dict(d) for name, d in raw.items()}


def codes(model: Any, raw: Any) -> list[str]:
    """Sorted issue codes of parsing `raw` with `model`."""
    from goatlib.style.parse import parse

    return sorted(i.code for i in parse(model, raw)[1])


def codes_of(result: tuple[Any, list[Any]]) -> list[str]:
    """Sorted codes of a `(model, issues)` pair."""
    return sorted(i.code for i in result[1])


def check(doc: dict[str, Any], geometry: str | None) -> list[Any]:
    """Parse a document, then run the whole-document checks on it."""
    from goatlib.style.check import check_document
    from goatlib.style.parse import parse_for_write

    style, issues = parse_for_write(doc)
    assert issues == [], issues
    return check_document(doc, style, geometry)
