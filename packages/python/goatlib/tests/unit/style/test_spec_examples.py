import pytest
from goatlib.style.context import MapContext
from goatlib.style.validate import validate, validate_map

from .conftest import load_examples

MAP_CONTEXT = MapContext(
    layers={413: frozenset({"s1"}), 410: frozenset({"s1"}), 414: frozenset({"s1"})}
)


@pytest.mark.parametrize(
    "ex", load_examples(), ids=lambda e: f"line{e['line']}-{e['target']}"
)
def test_spec_example(ex: dict, contexts: dict) -> None:
    if ex["target"] == "maplibre":
        pytest.skip("MapLibre output is checked by the compiler tests")
    if ex["target"] == "map":
        issues = validate_map(ex["doc"], MAP_CONTEXT)
    else:
        issues = validate(ex["doc"], contexts[ex["target"]])
    got = {i.code for i in issues}
    if ex["expect"]:
        assert set(ex["expect"]) <= got, [(i.code, i.path, i.message) for i in issues]
    else:
        assert [(i.code, i.path, i.message) for i in issues if i.level == "error"] == []
