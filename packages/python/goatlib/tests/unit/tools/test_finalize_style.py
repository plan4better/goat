"""The style a saved workflow result gets (spec 17): the remembered or tool
style, converted when it is version 0, computed for the saved data."""

from typing import Iterator

import duckdb
import pytest
from goatlib.tools.finalize_layer import FinalizeLayerRunner

pytestmark = pytest.mark.unit

GREENS = ["#edf8e9", "#bae4b3", "#74c476", "#31a354", "#006d2c"]


@pytest.fixture
def runner() -> Iterator[FinalizeLayerRunner]:
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute(
        "CREATE TABLE t AS SELECT i::DOUBLE AS v, ST_Point(i, 0) AS geometry "
        "FROM range(1, 21) r(i)"
    )
    runner = FinalizeLayerRunner()
    runner._duckdb_con = con
    yield runner
    con.close()


def test_finalize_converts_a_version_0_output_style_with_the_real_geometry(
    runner: FinalizeLayerRunner,
) -> None:
    v0 = {
        "color": [255, 0, 0],
        "radius": 5,
        "color_field": {"name": "v", "type": "number"},
        "color_scale": "quantile",
        "color_range": {"name": "Custom", "colors": GREENS},
        "color_scale_breaks": {"breaks": [4, 8, 12, 16], "min": 1, "max": 20},
    }
    doc = runner._layer_style(
        v0, geometry_type="POINT", relation="t", data_snapshot=9, layer_id="L"
    )
    assert doc is not None and doc["version"] == 1
    assert "marker" in doc["symbol"]
    [c] = doc["classify"]
    assert c["computed"]["data"] == "ducklake:9" and len(c["classes"]) == 5
    assert all(k.get("id") for k in c["classes"])


def test_a_current_style_is_kept_and_a_missing_one_gets_the_default(
    runner: FinalizeLayerRunner,
) -> None:
    v1 = {"version": 1, "kind": "vector", "symbol": {"marker": {"size": 4}}}
    kept = runner._layer_style(
        v1, geometry_type="POINT", relation="t", data_snapshot=None, layer_id="L"
    )
    assert kept == v1
    default = runner._layer_style(
        None, geometry_type="POINT", relation="t", data_snapshot=None, layer_id="L"
    )
    assert default is not None and "marker" in default["symbol"]
    assert (
        runner._layer_style(
            v1, geometry_type=None, relation="t", data_snapshot=None, layer_id="L"
        )
        is None
    )


def test_an_output_style_that_does_not_validate_gets_the_default(
    runner: FinalizeLayerRunner,
) -> None:
    broken = {"version": 1, "kind": "vector", "symbol": {"marker": {"color": "nope"}}}
    doc = runner._layer_style(
        broken, geometry_type="POINT", relation="t", data_snapshot=None, layer_id="L"
    )
    assert doc is not None and doc["symbol"]["marker"]["color"] != "nope"


def test_a_style_that_cannot_be_computed_is_saved_uncomputed(
    runner: FinalizeLayerRunner,
) -> None:
    v1 = {
        "version": 1,
        "kind": "vector",
        "symbol": {"marker": {"color": "#ff0000"}},
        "classify": [
            {
                "id": "v",
                "field": "v",
                "method": "quantile",
                "count": 5,
                "palette": GREENS,
            }
        ],
    }
    doc = runner._layer_style(
        v1,
        geometry_type="POINT",
        relation="no_such_table",
        data_snapshot=3,
        layer_id="L",
    )
    assert doc is not None and "computed" not in doc["classify"][0]


def test_the_windmill_finalize_script_takes_and_passes_the_style() -> None:
    """The workflow runner sends the style as `style`; Windmill only hands the
    script the inputs its own `main` names."""
    import ast
    import inspect
    from unittest.mock import patch

    from goatlib.tools import finalize_layer
    from goatlib.tools.sync_windmill import WindmillSyncer

    scripts: dict[str, str] = {}

    def capture(self: object, path: str, content: str, **_: object) -> dict:
        scripts[path] = content
        return {}

    with patch.object(WindmillSyncer, "sync_special_script", capture):
        WindmillSyncer("http://windmill.test", "token").sync_workflow_scripts()
    [content] = [c for p, c in scripts.items() if "finalize" in p]
    main = next(n for n in ast.parse(content).body if isinstance(n, ast.FunctionDef))
    assert [a.arg for a in main.args.args] == list(
        inspect.signature(finalize_layer.main).parameters
    )
    assert "style=style" in content
