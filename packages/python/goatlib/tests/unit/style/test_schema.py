import json
from importlib import resources

import pytest
from goatlib.style.schema import SCHEMA_ID, json_schema

from .conftest import load_examples


def checked_in() -> dict:
    return json.loads(
        resources.files("goatlib.style")
        .joinpath("data", "goat-style.schema.json")
        .read_text()
    )


def test_the_checked_in_schema_is_current() -> None:
    assert json_schema() == checked_in()


def test_schema_shape() -> None:
    schema = json_schema()
    assert (
        schema["$id"]
        == SCHEMA_ID
        == "https://goat.plan4better.de/schemas/goat-style-1.json"
    )
    assert {"LayerStyle", "MapDocument", "catalog"} <= set(schema["$defs"])
    assert "goat:green" in schema["$defs"]["catalog"]["properties"]["palettes"]["enum"]


VALID = [e for e in load_examples() if not e["expect"] and e["target"] != "maplibre"]


def test_valid_spec_examples_fit_the_schema() -> None:
    jsonschema = pytest.importorskip("jsonschema")
    schema = json_schema()
    validators = {
        root: jsonschema.Draft202012Validator({**schema, "$ref": f"#/$defs/{root}"})
        for root in ("LayerStyle", "MapDocument")
    }
    failures = []
    for ex in VALID:
        validator = validators["MapDocument" if ex["target"] == "map" else "LayerStyle"]
        failures += [
            (ex["line"], e.message[:120]) for e in validator.iter_errors(ex["doc"])
        ]
    assert failures == []


def test_schema_lists_the_per_layer_keys() -> None:
    from goatlib.style.models.parts import PER_LAYER_KEYS

    assert json_schema()["x-per-layer"] == sorted(PER_LAYER_KEYS)


def test_schema_carries_the_default_ranges() -> None:
    from goatlib.style.colors import DEFAULT_RANGES

    assert json_schema()["x-default-ranges"] == {
        k: list(v) for k, v in DEFAULT_RANGES.items()
    }


def test_schema_carries_the_icon_groups() -> None:
    from goatlib.style.catalog import icon_groups

    assert json_schema()["x-icon-groups"] == icon_groups()
