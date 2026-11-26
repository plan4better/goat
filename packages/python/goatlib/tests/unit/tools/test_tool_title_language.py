"""The legend titles a tool run writes are in the language of the run.

A run takes an optional `language` (`ToolInputBase`), which processes sets
from the request and the workflow runner hands to each step. The titles of
the tool's default style are written in it, once: German for "de", English
for any other language and for none. Field names and the user's own result
names are never translated.
"""

import asyncio
import inspect
from pathlib import Path
from typing import Any, Callable
from unittest.mock import AsyncMock, MagicMock

import duckdb
import pytest
from goatlib.analysis.schemas.aggregate import AggregationAreaType
from goatlib.analysis.schemas.catchment_area_v2 import CostType
from goatlib.analysis.schemas.heatmap_v2 import HeatmapType
from goatlib.i18n import get_translator
from goatlib.models.io import DatasetMetadata
from goatlib.tools import style as tool_style
from goatlib.tools import workflow_runner
from goatlib.tools.aggregate_points import (
    AggregatePointsToolParams,
    AggregatePointsToolRunner,
)
from goatlib.tools.aggregate_polygon import (
    AggregatePolygonToolParams,
    AggregatePolygonToolRunner,
)
from goatlib.tools.base import BaseToolRunner
from goatlib.tools.buffer import BufferToolParams, BufferToolRunner
from goatlib.tools.catchment_area_v2 import (
    CatchmentAreaV2ToolRunner,
    CatchmentAreaV2WindmillParams,
)
from goatlib.tools.dissolve import DissolveToolParams, DissolveToolRunner
from goatlib.tools.heatmap_2sfca import Heatmap2SFCAToolRunner
from goatlib.tools.heatmap_closest_average import HeatmapClosestAverageToolRunner
from goatlib.tools.heatmap_connectivity import HeatmapConnectivityToolRunner
from goatlib.tools.heatmap_gravity import HeatmapGravityToolRunner
from goatlib.tools.heatmap_v2 import (
    Heatmap2SFCAV2ToolRunner,
    HeatmapClosestAverageV2ToolRunner,
    HeatmapConnectivityV2ToolRunner,
    HeatmapGravityV2ToolRunner,
)
from goatlib.tools.huff_model import HuffModelToolRunner
from goatlib.tools.huff_model_v2 import HuffModelV2ToolRunner
from goatlib.tools.join import JoinToolParams, JoinToolRunner
from goatlib.tools.oev_gueteklassen import OevGueteklassenToolRunner
from goatlib.tools.origin_destination import OriginDestinationToolRunner
from goatlib.tools.schemas import ToolInputBase
from goatlib.tools.spatial_clustering import ZonesClusteringToolRunner
from goatlib.tools.sync_windmill import windmill_script
from goatlib.tools.travel_cost_matrix import TravelCostMatrixToolRunner
from goatlib.tools.trip_count import TripCountToolRunner
from goatlib.tools.workflow_runner import (
    WorkflowRunnerParams,
    add_run_context,
    build_tool_inputs,
)

pytestmark = pytest.mark.unit

U = "00000000-0000-0000-0000-000000000001"
IDS = {"user_id": U, "folder_id": U}


# --- The language a run takes ------------------------------------------------


@pytest.mark.parametrize(
    ("given", "kept"),
    [
        ("de", "de"),
        ("en", "en"),
        ("de-AT", "de"),
        ("DE", "de"),
        ("de-DE", "de"),
        (" de ", "de"),
        ("fr", None),
        ("fr-CH", None),
        ("", None),
        (None, None),
        ("Summe von {field}", None),
        ("de; DROP TABLE x", None),
        (5, None),
        (["de"], None),
    ],
)
def test_a_run_keeps_only_a_language_the_translations_hold(
    given: Any, kept: str | None
) -> None:
    assert ToolInputBase(**IDS, language=given).language == kept


def test_without_a_language_a_run_has_none() -> None:
    assert ToolInputBase(**IDS).language is None


def test_the_language_is_hidden_from_the_forms() -> None:
    field = ToolInputBase.model_json_schema()["properties"]["language"]
    assert field["x-ui"]["hidden"] is True


def test_the_tool_script_passes_the_language_on_without_showing_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The generated wrapper takes the language like the other injected
    inputs: not in Windmill's form, but on to the parameter model."""
    seen: list[Any] = []
    monkeypatch.setattr("goatlib.tools.buffer.main", lambda params: seen.append(params))
    namespace: dict[str, Any] = {}
    exec(compile(windmill_script("f/goat/tools/buffer"), "buffer", "exec"), namespace)
    main = namespace["main"]
    assert "language" not in inspect.signature(main).parameters

    main(**IDS, input_layer_id=U, distances=[100], language="de-AT")

    [params] = seen
    assert params.language == "de"


def _run_runner_script(monkeypatch: pytest.MonkeyPatch, runner: Any) -> None:
    """The workflow runner script, run with a language, against `runner` as
    the installed goatlib's `workflow_runner.main`."""
    monkeypatch.setattr("goatlib.tools.workflow_runner.main", runner)
    namespace: dict[str, Any] = {}
    script = windmill_script("f/goat/tools/workflow_runner")
    exec(compile(script, "workflow_runner", "exec"), namespace)
    namespace["main"](
        user_id=U,
        project_id=U,
        workflow_id=U,
        folder_id=U,
        nodes=[],
        edges=[],
        language="de",
    )


def test_the_workflow_runner_script_passes_the_language_on(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: list[dict[str, Any]] = []

    def runner(**kwargs: Any) -> None:
        seen.append(kwargs)

    # The signature of this goatlib's runner.
    runner.__signature__ = inspect.signature(workflow_runner.main)  # type: ignore[attr-defined]
    _run_runner_script(monkeypatch, runner)

    [kwargs] = seen
    assert kwargs["language"] == "de"


def test_the_workflow_runner_script_runs_an_older_runner_without_the_language(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A worker whose goatlib predates the language still runs the workflow
    (with English titles) when the script is synced before it is updated."""
    seen: list[dict[str, Any]] = []

    def older_runner(
        user_id: str,
        project_id: str,
        workflow_id: str,
        folder_id: str,
        nodes: list,
        edges: list,
        variables: list | None = None,
    ) -> None:
        seen.append({"user_id": user_id, "variables": variables})

    _run_runner_script(monkeypatch, older_runner)

    assert seen == [{"user_id": U, "variables": None}]


def _runner_params(language: str | None, nodes: list[dict[str, Any]]) -> Any:
    return WorkflowRunnerParams(
        user_id=U,
        project_id=U,
        workflow_id=U,
        folder_id=U,
        nodes=nodes,
        edges=[],
        language=language,
    )


@pytest.mark.parametrize("language", ["de", None])
def test_every_workflow_step_gets_the_language_of_the_run(
    language: str | None,
) -> None:
    """Also over a language a step's saved settings hold: only the run says
    which language its results are written in."""
    steps = [
        {
            "id": node_id,
            "data": {
                "type": "tool",
                "processId": "buffer",
                "config": {"distances": [100], "language": "en"},
            },
        }
        for node_id in ("first", "second")
    ]
    params = _runner_params(language, steps)

    for step in steps:
        inputs = build_tool_inputs(step, [], steps, {}, params)
        assert inputs["language"] == language


def test_the_run_context_names_the_language() -> None:
    inputs = add_run_context(
        {},
        {"id": "n"},
        user_id=U,
        project_id=U,
        folder_id=U,
        workflow_id=U,
        language="de",
    )
    assert inputs["language"] == "de"


@pytest.mark.parametrize(("given", "kept"), [("de-AT", "de"), ("fr", None)])
def test_the_workflow_run_keeps_only_a_language_the_translations_hold(
    given: str, kept: str | None
) -> None:
    assert _runner_params(given, []).language == kept


# --- The titles of each kind, per language -----------------------------------


def _stat(operation: str, **extra: Any) -> dict[str, Any]:
    stat = {"operation": operation, **extra}
    if operation != "count":
        stat["field"] = "value"
    return stat


def _aggregate_points(language: str | None, **stat: Any) -> Any:
    return AggregatePointsToolParams(
        **IDS,
        source_layer_id=U,
        area_type=AggregationAreaType.h3_grid,
        h3_resolution=8,
        column_statistics=[stat],
        language=language,
    )


def _title(doc: dict[str, Any] | None) -> str:
    assert doc is not None
    [c] = doc["classify"]
    return c["title"]


Build = Callable[[str | None], dict[str, Any] | None]


def _own(runner_class: type, geometry: str = "polygon", **params: Any) -> Build:
    """A tool whose title does not depend on its other parameters."""
    return lambda language: runner_class().get_layer_style(
        MagicMock(language=language, **params), MagicMock(), geometry, "r"
    )


def _real(
    runner_class: type, make: Callable[[str | None], Any], geometry: str
) -> Build:
    return lambda language: runner_class().get_layer_style(
        make(language), MagicMock(), geometry, "r"
    )


def _catchment(cost: str) -> Build:
    def build(language: str | None) -> dict[str, Any] | None:
        params = CatchmentAreaV2WindmillParams(
            **IDS,
            routing_mode="walking",
            starting_points={"latitude": [48.1], "longitude": [11.5]},
            catchment_area_type="polygon",
            cost_type=cost,
            max_cost=15 if cost == "time" else 1500,
            language=language,
        )
        runner = CatchmentAreaV2ToolRunner()
        runner._duckdb_con = None  # no result to read: the bands from the params
        return runner.get_layer_style(params, MagicMock(), "polygon", "r")

    return build


def _join(language: str | None) -> dict[str, Any] | None:
    """A join's mean of the join layer's `value`, on a result whose mean
    column varies (the join reads its range before it classifies)."""
    params = JoinToolParams(
        **IDS,
        target_layer_id=U,
        join_layer_id=U,
        use_attribute_relationship=False,
        use_spatial_relationship=True,
        spatial_relationship="intersects",
        calculate_statistics=True,
        column_statistics=[_stat("mean")],
        language=language,
    )
    con = duckdb.connect()
    try:
        con.execute("INSTALL spatial; LOAD spatial;")
        con.execute(
            """CREATE TABLE result AS SELECT 'n' || i AS name,
            ST_Buffer(ST_Point(i, 0), 0.4) AS geometry, 1::DOUBLE AS match_count,
            (i % 4)::DOUBLE AS value_mean FROM range(10) t(i)"""
        )
        runner = JoinToolRunner()
        runner._duckdb_con = con
        return runner.get_layer_style(params, MagicMock(), "polygon", "result")
    finally:
        con.close()


#: Per title kind: how a run's default is built, its German title and its
#: English one.
TITLES: dict[str, tuple[Build, str, str]] = {
    "statistic, count": (
        _real(
            AggregatePointsToolRunner,
            lambda language: _aggregate_points(language, **_stat("count")),
            "polygon",
        ),
        "Anzahl",
        "Count",
    ),
    "statistic of a field": (
        _real(
            AggregatePointsToolRunner,
            lambda language: _aggregate_points(language, **_stat("sum")),
            "polygon",
        ),
        "Summe von value",
        "Sum of value",
    ),
    "statistic of a field, area weighted": (
        _real(
            AggregatePolygonToolRunner,
            lambda language: AggregatePolygonToolParams(
                **IDS,
                source_layer_id=U,
                weighted_by_intersecting_area=True,
                column_statistics=[_stat("sum")],
                area_type=AggregationAreaType.polygon,
                area_layer_id=U,
                language=language,
            ),
            "polygon",
        ),
        "Summe von value (flächengewichtet)",
        "Sum of value (area weighted)",
    ),
    "statistic of a dissolve": (
        _real(
            DissolveToolRunner,
            lambda language: DissolveToolParams(
                **IDS,
                input_layer_id=U,
                calculate_statistics=True,
                field_statistics=[_stat("standard_deviation")],
                language=language,
            ),
            "polygon",
        ),
        "Standardabweichung von value",
        "Standard deviation of value",
    ),
    "statistic of a join": (_join, "Mittelwert von value", "Mean of value"),
    "the user's own result name": (
        _real(
            AggregatePointsToolRunner,
            lambda language: _aggregate_points(
                language, **_stat("sum", result_name="Residents")
            ),
            "polygon",
        ),
        "Residents",
        "Residents",
    ),
    "origin-destination lines": (
        _own(OriginDestinationToolRunner, "line", weight_column="trips"),
        "Summe von trips",
        "Sum of trips",
    ),
    "origin-destination points": (
        lambda language: OriginDestinationToolRunner().points_style(
            MagicMock(language=language, weight_column="trips")
        ),
        "Summe von trips",
        "Sum of trips",
    ),
    "heatmap gravity": (
        _own(HeatmapGravityToolRunner),
        "Erreichbarkeit (Gravitation)",
        "Accessibility (gravity)",
    ),
    "heatmap gravity v2": (
        _own(HeatmapGravityV2ToolRunner, heatmap_type=HeatmapType.gravity),
        "Erreichbarkeit (Gravitation)",
        "Accessibility (gravity)",
    ),
    "heatmap closest average": (
        _own(HeatmapClosestAverageToolRunner),
        "Mittlere Reisezeit zu den nächsten Zielen",
        "Average travel time to the closest destinations",
    ),
    "heatmap closest average v2, distance": (
        _own(
            HeatmapClosestAverageV2ToolRunner,
            heatmap_type=HeatmapType.closest_average,
            cost_type=CostType.distance,
        ),
        "Mittlere Entfernung zu den nächsten Zielen",
        "Average distance to the closest destinations",
    ),
    "heatmap connectivity": (
        _own(HeatmapConnectivityToolRunner),
        "Erreichbare Fläche",
        "Area reached",
    ),
    "heatmap connectivity v2": (
        _own(HeatmapConnectivityV2ToolRunner, heatmap_type=HeatmapType.connectivity),
        "Erreichbare Fläche",
        "Area reached",
    ),
    "heatmap 2SFCA": (
        _own(Heatmap2SFCAToolRunner),
        "Angebot je Nachfrage",
        "Supply per demand",
    ),
    "heatmap 2SFCA v2": (
        _own(Heatmap2SFCAV2ToolRunner, heatmap_type=HeatmapType.two_sfca),
        "Angebot je Nachfrage",
        "Supply per demand",
    ),
    "huff": (_own(HuffModelToolRunner, "point"), "Marktanteil", "Market share"),
    "huff v2": (_own(HuffModelV2ToolRunner, "point"), "Marktanteil", "Market share"),
    "trip count": (
        _own(TripCountToolRunner, "point"),
        "Fahrten im Zeitfenster",
        "Trips in the time window",
    ),
    "travel cost matrix, time": (
        _own(
            TravelCostMatrixToolRunner,
            "point",
            routing_mode="walking",
            cost_type=CostType.time,
        ),
        "Mittlere Reisezeit von den Startpunkten",
        "Average travel time from the origins",
    ),
    "travel cost matrix, distance": (
        _own(
            TravelCostMatrixToolRunner,
            "point",
            routing_mode="walking",
            cost_type=CostType.distance,
        ),
        "Mittlere Entfernung von den Startpunkten",
        "Average distance from the origins",
    ),
    "buffer bands": (
        _real(
            BufferToolRunner,
            lambda language: BufferToolParams(
                **IDS, input_layer_id=U, distances=[100, 200], language=language
            ),
            "polygon",
        ),
        "Pufferabstand",
        "Buffer distance",
    ),
    "catchment bands, time": (_catchment("time"), "Reisezeit", "Travel time"),
    "catchment bands, distance": (_catchment("distance"), "Entfernung", "Distance"),
    "clustering zones": (_own(ZonesClusteringToolRunner, nb_cluster=5), "Zone", "Zone"),
    "clustering summary": (
        lambda language: ZonesClusteringToolRunner()._get_summary_style(
            MagicMock(language=language, nb_cluster=5)
        ),
        "Zone",
        "Zone",
    ),
    "public transport classes": (
        _own(OevGueteklassenToolRunner, station_config=None),
        "ÖV-Güteklasse",
        "Public transport quality class",
    ),
    "public transport stations": (
        lambda language: tool_style.oev_gueteklassen_stations_style(language),
        "Haltestellenkategorie",
        "Station category",
    ),
}


@pytest.mark.parametrize("kind", list(TITLES))
def test_a_german_run_writes_the_german_title(kind: str) -> None:
    build, german, _ = TITLES[kind]
    assert _title(build("de")) == german


@pytest.mark.parametrize("kind", list(TITLES))
@pytest.mark.parametrize("language", ["fr", None])
def test_any_other_run_writes_the_english_title(
    kind: str, language: str | None
) -> None:
    build, _, english = TITLES[kind]
    assert _title(build(language)) == english


def test_a_title_reads_the_run_s_language() -> None:
    assert tool_style.style_title("sum", "de", field="Einwohner") == (
        "Summe von Einwohner"
    )
    assert tool_style.style_title("sum", "de-AT", field="x") == "Summe von x"
    assert tool_style.style_title("sum", "fr", field="x") == "Sum of x"
    assert tool_style.style_title("sum", None, field="x") == "Sum of x"


def test_a_field_name_is_never_translated() -> None:
    """A field named like a text of the translations stays as it is."""
    assert tool_style.style_title("sum", "de", field="count") == "Summe von count"


def test_a_title_the_german_texts_lack_is_english(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    german = get_translator("de")
    titles = {
        key: text
        for key, text in german._translations["style_titles"].items()
        if key != "buffer_distance"
    }
    monkeypatch.setitem(german._translations, "style_titles", titles)

    assert tool_style.style_title("buffer_distance", "de") == "Buffer distance"
    assert tool_style.style_title("travel_time", "de") == "Reisezeit"


def test_a_title_no_language_holds_is_its_key() -> None:
    assert tool_style.style_title("no_such_title", "de") == "no_such_title"


# --- The title a run stores --------------------------------------------------


class _CountRunner(BaseToolRunner[ToolInputBase]):
    tool_class = object
    output_geometry_type = "polygon"
    default_output_name = "Result"

    def process(self, params: Any, temp_dir: Path) -> Any:
        raise NotImplementedError

    def get_layer_style(
        self, params: Any, metadata: Any, geometry: Any, relation: Any
    ) -> Any:
        return tool_style.numeric_default(
            "v",
            "colorbrewer:Oranges",
            geometry,
            tool_style.style_title("count", params.language),
        )


@pytest.mark.parametrize(("language", "title"), [("de", "Anzahl"), (None, "Count")])
def test_the_toolbox_run_stores_the_title_in_its_language(
    monkeypatch: pytest.MonkeyPatch,
    runner_event_loop: asyncio.AbstractEventLoop,
    language: str | None,
    title: str,
) -> None:
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute(
        """CREATE TABLE result AS SELECT (i + 1)::DOUBLE AS v,
        ST_Buffer(ST_Point(i, 0), 0.4) AS geometry FROM range(20) t(i)"""
    )
    runner = _CountRunner()
    runner._duckdb_con = con
    monkeypatch.setattr(runner, "_get_ducklake_snapshot_id", lambda *a: 3)
    monkeypatch.setattr("goatlib.tools.base.table_path_parts", lambda r: ("a", "b"))
    runner.db_service = MagicMock(create_layer=AsyncMock())
    runner_event_loop.run_until_complete(
        runner._create_db_records(
            output_layer_id="L",
            params=ToolInputBase(**IDS, language=language),
            output_name="Result",
            metadata=DatasetMetadata(path="x", source_type="vector"),
            table_info={"table_name": "result", "geometry_type": "POLYGON"},
        )
    )
    con.close()
    stored = runner.db_service.create_layer.call_args.kwargs["style"]
    assert _title(stored) == title
