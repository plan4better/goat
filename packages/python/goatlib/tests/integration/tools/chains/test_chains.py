"""Workflows run end to end with the real runner, scripts and tools.

Each test builds a workflow as the editor or the assistant stores it, runs it
the way processes submits it, with Windmill stood in (`windmill_stand_in.py`),
and checks every step's result and what the exports saved. Settings are left
unset where the assistant leaves them. The layers are the eval project's
(`world.py`).
"""

import asyncio
import json
import uuid
from typing import Any

import duckdb
import pytest
from goatlib.workflows.run_errors import error_message

from ..conftest import (
    TEST_CUSTOMER_SCHEMA,
    TEST_FOLDER_ID,
    TEST_USER_ID,
    get_pg_connection,
)
from .configs import (
    area,
    dataset,
    edge,
    export,
    if_step,
    into_export,
    keep,
    statistic,
    tool,
    where,
    workflow,
)
from .world import EINWOHNER, SCHULEN, STADTBEZIRKE, SUPERMAERKTE

pytestmark = [pytest.mark.integration, pytest.mark.asyncio(loop_scope="session")]

DISTRICTS = {"Mitte", "Nordost", "Ost", "Südost"}


def _distinct(parquet: str, column: str) -> set[Any]:
    """The distinct values of a column of a step's temp result."""
    with duckdb.connect() as con:
        rows = con.execute(
            f"SELECT DISTINCT \"{column}\" FROM read_parquet('{parquet}')"
        ).fetchall()
    return {row[0] for row in rows}


def _column_types(parquet: str) -> dict[str, str]:
    """The columns of a step's temp result and their types."""
    with duckdb.connect() as con:
        rows = con.execute(
            f"DESCRIBE SELECT * FROM read_parquet('{parquet}')"
        ).fetchall()
    return {str(row[0]): str(row[1]) for row in rows}


#: The style keys without which the map does not draw a feature layer's
#: entry: it hides the layer unless `visibility`, and fills nothing without
#: `filled` and `color` (the web's `transformers/layer.ts`).
DRAWN_KEYS = ("visibility", "filled", "color")


def _drawable(properties: Any) -> bool:
    return (
        isinstance(properties, dict)
        and properties.get("visibility") is True
        and all(key in properties for key in DRAWN_KEYS)
    )


def _json(value: Any) -> Any:
    return json.loads(value) if isinstance(value, str) else value


async def _entry_properties(settings: Any, layer_id: str) -> list[Any]:
    """The properties of every project entry showing the layer."""
    conn = await get_pg_connection(settings)
    try:
        rows = await conn.fetch(
            f"SELECT properties FROM {TEST_CUSTOMER_SCHEMA}.layer_project "
            "WHERE layer_id = $1::uuid ORDER BY id",
            layer_id,
        )
    finally:
        await conn.close()
    return [_json(row["properties"]) for row in rows]


async def _saved_layer(settings: Any, layer_id: str) -> dict[str, Any]:
    """What the layer record of a saved layer says about drawing it: its type,
    geometry type, and whether it and every project entry showing it have
    the style keys the map needs."""
    conn = await get_pg_connection(settings)
    try:
        row = await conn.fetchrow(
            f"""
            SELECT type, feature_layer_type, feature_layer_geometry_type,
                   properties
            FROM {TEST_CUSTOMER_SCHEMA}.layer
            WHERE id = $1::uuid
            """,
            layer_id,
        )
    finally:
        await conn.close()
    assert row is not None, layer_id
    entries = await _entry_properties(settings, layer_id)
    return {
        "type": row["type"],
        "feature_layer_type": row["feature_layer_type"],
        "feature_layer_geometry_type": row["feature_layer_geometry_type"],
        "drawn": _drawable(_json(row["properties"])),
        "entries_drawn": bool(entries) and all(_drawable(e) for e in entries),
    }


async def _set_entry_properties(
    settings: Any, layer_id: str, properties: dict[str, Any]
) -> None:
    """Set what an entry holds, as the web's layer tree or style panel does."""
    conn = await get_pg_connection(settings)
    try:
        await conn.execute(
            f"UPDATE {TEST_CUSTOMER_SCHEMA}.layer_project "
            "SET properties = $2::jsonb WHERE layer_id = $1::uuid",
            layer_id,
            json.dumps(properties),
        )
    finally:
        await conn.close()


def _overwriting(node: dict[str, Any]) -> dict[str, Any]:
    """An export step that writes into the layer its earlier runs saved."""
    node["data"]["overwritePrevious"] = True
    return node


async def test_a_geometry_only_dissolve_feeds_the_intersection_and_the_count(
    run_workflow: Any, saved_rows: Any
) -> None:
    """Buffer, dissolve without group fields, intersect with the districts, sum
    the residents per piece. The dissolve writes a geometry alone; the
    intersection after it still carries each district's name."""
    config = workflow(
        [
            dataset("schools", SCHULEN),
            dataset("districts", STADTBEZIRKE),
            dataset("residents", EINWOHNER),
            tool("ring", "buffer", distances=[500]),
            tool("merged", "dissolve"),
            tool("per_district", "intersection"),
            tool(
                "count",
                "aggregate_polygon",
                area_type="polygon",
                column_statistics=[{"operation": "sum", "field": "einwohner"}],
            ),
            export("save", "Einwohner im Schulumfeld je Bezirk"),
        ],
        [
            edge("schools", "ring"),
            edge("ring", "merged"),
            edge("merged", "per_district"),
            edge("districts", "per_district", "overlay_layer_id"),
            edge("residents", "count", "source_layer_id"),
            edge("per_district", "count", "area_layer_id"),
            into_export("count", "save"),
        ],
    )
    run = await asyncio.to_thread(run_workflow, config)
    run.assert_succeeded()
    assert run.step("ring")["feature_count"] == 12
    assert run.step("ring")["parquet_path"].startswith(str(run.temp_root))
    assert run.step("merged")["feature_count"] == 1
    pieces = run.step("per_district")
    assert _distinct(pieces["parquet_path"], "intersection_name") == DISTRICTS
    assert run.step("count")["feature_count"] == pieces["feature_count"]
    assert saved_rows(run.step("save")["layer_id"]) == pieces["feature_count"]


async def test_a_failing_step_stops_the_run_with_its_own_message(
    run_workflow: Any,
) -> None:
    """The intersection keeps an input field the buffer before it does not
    write. The check before a run only warns about a field of a step's
    result that no join renamed (`field_maybe_missing`), so a submitted run
    gets this far. The run stops at the step and reports the step's own
    message, without the stack Windmill records for the failed job."""
    config = workflow(
        [
            dataset("schools", SCHULEN),
            dataset("districts", STADTBEZIRKE),
            tool("ring", "buffer", distances=[500]),
            tool("per_district", "intersection", input_fields=["no_such_field"]),
            tool("merged", "dissolve"),
            export("save", "Nie gespeichert"),
        ],
        [
            edge("schools", "ring"),
            edge("ring", "per_district"),
            edge("districts", "per_district", "overlay_layer_id"),
            edge("per_district", "merged"),
            into_export("merged", "save"),
        ],
    )
    run = await asyncio.to_thread(run_workflow, config)
    assert run.result["status"] == "failed"
    [error] = run.result["errors"]
    assert error["node_id"] == "per_district"
    failed = run.jobs[run.result["node_jobs"]["per_district"]].result["error"]
    assert 'File "' in failed["stack"]
    assert error["message"] == error_message({"message": failed["message"]})
    assert "no_such_field" in error["message"]
    assert 'File "' not in error["message"]
    started = [job.path.rsplit("/", 1)[-1] for job in run.jobs.values()]
    assert started == ["buffer", "intersection", "workflow_runner"]
    assert "merged" not in run.result["node_results"]
    assert "save" not in run.result["node_results"]


WEST = keep(area(12.33, 51.31, 12.385, 51.37))


async def test_an_if_on_a_filtered_dataset_runs_its_true_branch_only(
    run_workflow: Any, saved_rows: Any
) -> None:
    """The If counts the rows the dataset's filter keeps, and the buffer
    behind it gets the same rows."""
    config = workflow(
        [
            dataset("schools", SCHULEN, keep(where("schulart", "is", "Grundschule"))),
            if_step("enough", statistic("count", "<", 10)),
            tool("ring", "buffer", distances=[300]),
            tool("points", "centroid"),
            export("save", "Grundschulen 300 m"),
            export("never", "Nie gespeichert"),
        ],
        [
            edge("schools", "enough", "input"),
            edge("enough", "ring", branch="true"),
            edge("enough", "points", branch="false"),
            into_export("ring", "save"),
            into_export("points", "never"),
        ],
    )
    run = await asyncio.to_thread(run_workflow, config)
    run.assert_succeeded()
    assert run.step("enough")["active_handle"] == "true"
    assert run.step("ring")["feature_count"] == 6
    assert run.step("points")["status"] == "skipped"
    assert run.step("never")["status"] == "skipped"
    assert saved_rows(run.step("save")["layer_id"]) == 6


async def test_an_export_behind_a_dataset_saves_the_rows_its_area_keeps(
    run_workflow: Any, saved_rows: Any
) -> None:
    config = workflow(
        [dataset("shops", SUPERMAERKTE, WEST), export("save", "Märkte im Westen")],
        [into_export("shops", "save")],
    )
    run = await asyncio.to_thread(run_workflow, config)
    run.assert_succeeded()
    assert saved_rows(run.step("save")["layer_id"]) == 6


async def test_a_district_named_with_an_umlaut_clips_the_grid_it_is_counted_in(
    run_workflow: Any, saved_rows: Any
) -> None:
    """Clip the population grid to the district called "Südost", take each
    piece's centroid, and count the centroids per district."""
    config = workflow(
        [
            dataset("residents", EINWOHNER),
            dataset("one", STADTBEZIRKE, keep(where("name", "is", "Südost"))),
            dataset("districts", STADTBEZIRKE),
            tool("cut", "clip"),
            tool("centres", "centroid"),
            tool(
                "count",
                "aggregate_points",
                area_type="polygon",
                column_statistics=[{"operation": "count"}],
            ),
            export("save", "Zellen je Bezirk"),
        ],
        [
            edge("residents", "cut"),
            edge("one", "cut", "overlay_layer_id"),
            edge("cut", "centres"),
            edge("centres", "count", "source_layer_id"),
            edge("districts", "count", "area_layer_id"),
            into_export("count", "save"),
        ],
    )
    run = await asyncio.to_thread(run_workflow, config)
    run.assert_succeeded()
    assert run.step("cut")["feature_count"] == 12
    assert run.step("centres")["feature_count"] == 12
    assert run.step("count")["feature_count"] == 4
    assert saved_rows(run.step("save")["layer_id"]) == 4


async def test_districts_without_the_school_rings_union_with_the_market_rings(
    run_workflow: Any, saved_rows: Any
) -> None:
    """Every ring lies inside one district: the difference keeps four
    districts with holes; the union gives each market ring as its own piece
    plus the four districts around the holes."""
    config = workflow(
        [
            dataset("districts", STADTBEZIRKE),
            dataset("schools", SCHULEN),
            dataset("shops", SUPERMAERKTE),
            tool("school_rings", "buffer", distances=[300]),
            tool("shop_rings", "buffer", distances=[300]),
            tool("rest", "difference"),
            tool("both", "union"),
            export("save", "Bezirke und Marktumfeld"),
        ],
        [
            edge("schools", "school_rings"),
            edge("shops", "shop_rings"),
            edge("districts", "rest"),
            edge("school_rings", "rest", "overlay_layer_id"),
            edge("rest", "both"),
            edge("shop_rings", "both", "overlay_layer_id"),
            into_export("both", "save"),
        ],
    )
    run = await asyncio.to_thread(run_workflow, config)
    run.assert_succeeded()
    assert run.step("rest")["feature_count"] == 4
    assert run.step("both")["feature_count"] == 16
    assert saved_rows(run.step("save")["layer_id"]) == 16


async def test_schools_and_markets_merged_give_each_district_a_place(
    run_workflow: Any, saved_rows: Any
) -> None:
    config = workflow(
        [
            dataset("schools", SCHULEN),
            dataset("shops", SUPERMAERKTE),
            dataset("districts", STADTBEZIRKE),
            tool("places", "merge"),
            tool(
                "named",
                "join",
                use_spatial_relationship=True,
                use_attribute_relationship=False,
            ),
            export("save", "Bezirke mit Ort"),
        ],
        [
            edge("schools", "places", "input_path_1"),
            edge("shops", "places", "input_path_2"),
            edge("districts", "named", "target_layer_id"),
            edge("places", "named", "join_layer_id"),
            into_export("named", "save"),
        ],
    )
    run = await asyncio.to_thread(run_workflow, config)
    run.assert_succeeded()
    assert run.step("places")["feature_count"] == 24
    assert run.step("named")["feature_count"] == 4
    assert saved_rows(run.step("save")["layer_id"]) == 4


async def test_a_filter_that_keeps_nothing_saves_an_empty_result(
    run_workflow: Any, saved_rows: Any
) -> None:
    config = workflow(
        [
            dataset("schools", SCHULEN, keep(where("schulart", "is", "Hochschule"))),
            tool("ring", "buffer", distances=[300]),
            export("save", "Hochschulen 300 m"),
        ],
        [edge("schools", "ring"), into_export("ring", "save")],
    )
    run = await asyncio.to_thread(run_workflow, config)
    run.assert_succeeded()
    assert run.step("ring")["feature_count"] == 0
    assert saved_rows(run.step("save")["layer_id"]) == 0


async def test_an_erase_that_leaves_nothing_hands_the_centroid_an_empty_layer(
    run_workflow: Any, saved_rows: Any
) -> None:
    """Rings of 20 km around the schools cover every district, so erasing
    them leaves no district. The centroid after the erase gets a result
    without rows, gives one with its geometry column, and the export saves
    it."""
    config = workflow(
        [
            dataset("districts", STADTBEZIRKE),
            dataset("schools", SCHULEN),
            tool("rings", "buffer", distances=[20000]),
            tool("rest", "difference"),
            tool("centres", "centroid"),
            export("save", "Bezirke ohne Schulumfeld"),
        ],
        [
            edge("schools", "rings"),
            edge("districts", "rest"),
            edge("rings", "rest", "overlay_layer_id"),
            edge("rest", "centres"),
            into_export("centres", "save"),
        ],
    )
    run = await asyncio.to_thread(run_workflow, config)
    run.assert_succeeded()
    assert run.step("rings")["feature_count"] == 12
    assert run.step("rest")["feature_count"] == 0
    assert run.step("centres")["feature_count"] == 0
    for step in ("rest", "centres"):
        types = _column_types(run.step(step)["parquet_path"])
        assert types["geometry"].startswith("GEOMETRY"), (step, types)
    assert saved_rows(run.step("save")["layer_id"]) == 0


#: Schools of a kind the world has none of.
NO_SCHOOLS = keep(where("schulart", "is", "Hochschule"))


async def test_an_empty_result_is_saved_as_a_layer_of_the_step_s_geometry(
    run_workflow: Any, tool_settings: Any
) -> None:
    """A buffer gives polygons, also when it gives none: the export saves a
    polygon layer with a style, which the map draws once it has rows."""
    config = workflow(
        [
            dataset("schools", SCHULEN, NO_SCHOOLS),
            tool("ring", "buffer", distances=[300]),
            export("save", "Hochschulen 300 m"),
        ],
        [edge("schools", "ring"), into_export("ring", "save")],
    )
    run = await asyncio.to_thread(run_workflow, config)
    run.assert_succeeded()
    assert run.step("ring")["type"] == "feature"
    saved = await _saved_layer(tool_settings, run.step("save")["layer_id"])
    assert saved == {
        "type": "feature",
        "feature_layer_type": "tool",
        "feature_layer_geometry_type": "polygon",
        "drawn": True,
        "entries_drawn": True,
    }


async def test_a_dataset_filter_that_keeps_nothing_saves_the_dataset_s_geometry(
    run_workflow: Any, tool_settings: Any, saved_rows: Any
) -> None:
    config = workflow(
        [dataset("schools", SCHULEN, NO_SCHOOLS), export("save", "Hochschulen")],
        [into_export("schools", "save")],
    )
    run = await asyncio.to_thread(run_workflow, config)
    run.assert_succeeded()
    layer_id = run.step("save")["layer_id"]
    assert saved_rows(layer_id) == 0
    saved = await _saved_layer(tool_settings, layer_id)
    assert (saved["type"], saved["feature_layer_geometry_type"]) == ("feature", "point")


async def test_an_empty_erase_saved_as_it_is_keeps_its_input_s_geometry(
    run_workflow: Any, tool_settings: Any
) -> None:
    """The erase keeps the geometry of its input layer, the districts."""
    config = workflow(
        [
            dataset("districts", STADTBEZIRKE),
            dataset("schools", SCHULEN),
            tool("rings", "buffer", distances=[20000]),
            tool("rest", "difference"),
            export("save", "Bezirke ohne Schulumfeld"),
        ],
        [
            edge("schools", "rings"),
            edge("districts", "rest"),
            edge("rings", "rest", "overlay_layer_id"),
            into_export("rest", "save"),
        ],
    )
    run = await asyncio.to_thread(run_workflow, config)
    run.assert_succeeded()
    assert run.step("rest")["feature_count"] == 0
    saved = await _saved_layer(tool_settings, run.step("save")["layer_id"])
    assert (saved["type"], saved["feature_layer_geometry_type"]) == (
        "feature",
        "polygon",
    )


async def test_an_export_saved_empty_is_drawn_once_a_run_gives_it_rows(
    run_workflow: Any, tool_settings: Any, saved_rows: Any
) -> None:
    """The first run keeps no school, the second keeps the primary schools;
    the second run writes into the layer the first one saved."""
    workflow_id = str(uuid.uuid4())

    def rings_of(schools: dict[str, Any]) -> dict[str, Any]:
        return workflow(
            [
                dataset("schools", SCHULEN, schools),
                tool("ring", "buffer", distances=[300]),
                _overwriting(export("save", "Schulumfeld")),
            ],
            [edge("schools", "ring"), into_export("ring", "save")],
        )

    first = await asyncio.to_thread(run_workflow, rings_of(NO_SCHOOLS), workflow_id)
    second = await asyncio.to_thread(
        run_workflow,
        rings_of(keep(where("schulart", "is", "Grundschule"))),
        workflow_id,
    )
    first.assert_succeeded()
    second.assert_succeeded()
    layer_id = first.step("save")["layer_id"]
    assert second.step("save")["layer_id"] == layer_id
    assert second.step("save")["overwritten"] is True
    assert saved_rows(layer_id) == 6
    saved = await _saved_layer(tool_settings, layer_id)
    assert (saved["type"], saved["feature_layer_geometry_type"]) == (
        "feature",
        "polygon",
    )
    assert saved["drawn"] and saved["entries_drawn"]


async def test_custom_sql_that_finds_nothing_hands_the_buffer_an_empty_layer(
    run_workflow: Any, tool_settings: Any, saved_rows: Any
) -> None:
    config = workflow(
        [
            dataset("schools", SCHULEN),
            tool(
                "pick",
                "custom_sql",
                sql_query="SELECT * FROM input_1 WHERE schulart = 'Hochschule'",
            ),
            tool("ring", "buffer", distances=[300]),
            export("save", "Hochschulen 300 m"),
        ],
        [
            edge("schools", "pick", "input_layer_1_id"),
            edge("pick", "ring"),
            into_export("ring", "save"),
        ],
    )
    run = await asyncio.to_thread(run_workflow, config)
    run.assert_succeeded()
    assert run.step("pick")["feature_count"] == 0
    assert _column_types(run.step("pick")["parquet_path"])["geometry"].startswith(
        "GEOMETRY"
    )
    assert run.step("ring")["feature_count"] == 0
    layer_id = run.step("save")["layer_id"]
    assert saved_rows(layer_id) == 0
    saved = await _saved_layer(tool_settings, layer_id)
    assert (saved["type"], saved["feature_layer_geometry_type"]) == (
        "feature",
        "polygon",
    )


def _custom_sql_export(sql: str) -> dict[str, Any]:
    """Schools through a custom SQL step into an export that overwrites."""
    return workflow(
        [
            dataset("schools", SCHULEN),
            tool("pick", "custom_sql", sql_query=sql),
            _overwriting(export("save", "Auswahl")),
        ],
        [edge("schools", "pick", "input_layer_1_id"), into_export("pick", "save")],
    )


async def test_a_table_layer_overwritten_with_geometries_becomes_a_map_layer(
    run_workflow: Any, tool_settings: Any, saved_rows: Any
) -> None:
    """A custom SQL result without rows has no geometry type to save, so the
    first run saves a table layer. The second run finds schools; the layer
    it overwrites becomes a point layer with a style."""
    workflow_id = str(uuid.uuid4())
    sql = "SELECT * FROM input_1 WHERE schulart = '{}'"
    first = await asyncio.to_thread(
        run_workflow, _custom_sql_export(sql.format("Hochschule")), workflow_id
    )
    first.assert_succeeded()
    layer_id = first.step("save")["layer_id"]
    saved = await _saved_layer(tool_settings, layer_id)
    assert saved["type"] == "table"

    second = await asyncio.to_thread(
        run_workflow, _custom_sql_export(sql.format("Grundschule")), workflow_id
    )
    second.assert_succeeded()
    assert second.step("save")["layer_id"] == layer_id
    assert saved_rows(layer_id) == 6
    saved = await _saved_layer(tool_settings, layer_id)
    assert saved == {
        "type": "feature",
        "feature_layer_type": "tool",
        "feature_layer_geometry_type": "point",
        "drawn": True,
        "entries_drawn": True,
    }


#: What the web's layer tree writes into every entry it rearranges, tables
#: included (`ProjectLayerTree.tsx`, `formatDndDataForApi`).
TREE_KEYS = {"legend": {"collapsed": False}}

SCHOOLS_OF = "SELECT * FROM input_1 WHERE schulart = '{}'"


async def test_a_table_entry_holding_the_tree_s_keys_is_drawn_once_it_has_points(
    run_workflow: Any, tool_settings: Any
) -> None:
    workflow_id = str(uuid.uuid4())
    first = await asyncio.to_thread(
        run_workflow, _custom_sql_export(SCHOOLS_OF.format("Hochschule")), workflow_id
    )
    first.assert_succeeded()
    layer_id = first.step("save")["layer_id"]
    await _set_entry_properties(tool_settings, layer_id, TREE_KEYS)

    second = await asyncio.to_thread(
        run_workflow, _custom_sql_export(SCHOOLS_OF.format("Grundschule")), workflow_id
    )
    second.assert_succeeded()
    assert second.step("save")["layer_id"] == layer_id
    [entry] = await _entry_properties(tool_settings, layer_id)
    assert _drawable(entry), entry
    assert entry["legend"] == {"collapsed": False}


async def test_an_entry_with_its_own_style_keeps_it_when_its_layer_gets_points(
    run_workflow: Any, tool_settings: Any
) -> None:
    workflow_id = str(uuid.uuid4())
    first = await asyncio.to_thread(
        run_workflow, _custom_sql_export(SCHOOLS_OF.format("Hochschule")), workflow_id
    )
    first.assert_succeeded()
    layer_id = first.step("save")["layer_id"]
    own = {"visibility": True, "filled": False, "color": [1, 2, 3], "opacity": 0.4}
    await _set_entry_properties(tool_settings, layer_id, own)

    second = await asyncio.to_thread(
        run_workflow, _custom_sql_export(SCHOOLS_OF.format("Grundschule")), workflow_id
    )
    second.assert_succeeded()
    [entry] = await _entry_properties(tool_settings, layer_id)
    assert {key: entry[key] for key in own} == own


async def test_a_re_run_beside_a_copy_styles_the_entry_it_points_at_its_new_layer(
    run_workflow: Any, tool_settings: Any
) -> None:
    """A copy of the project still shows the first run's table, so the
    second run writes a new layer and points its own project's entry at it
    (copy-on-write). That entry was made for a table and holds only the
    layer tree's keys; it is drawn after the run. The copy keeps the table."""
    workflow_id = str(uuid.uuid4())
    first = await asyncio.to_thread(
        run_workflow, _custom_sql_export(SCHOOLS_OF.format("Hochschule")), workflow_id
    )
    first.assert_succeeded()
    table_id = first.step("save")["layer_id"]
    await _set_entry_properties(tool_settings, table_id, TREE_KEYS)
    copy_project = uuid.uuid4()
    conn = await get_pg_connection(tool_settings)
    try:
        await conn.execute(
            f"INSERT INTO {TEST_CUSTOMER_SCHEMA}.project (id, user_id, folder_id, name) "
            "VALUES ($1, $2, $3, 'Kopie')",
            copy_project,
            uuid.UUID(TEST_USER_ID),
            uuid.UUID(TEST_FOLDER_ID),
        )
        # A project copy's entry: the same layer, stamped for the copied
        # workflow.
        await conn.execute(
            f'INSERT INTO {TEST_CUSTOMER_SCHEMA}.layer_project (layer_id, project_id, name, "order", other_properties) '
            "VALUES ($1::uuid, $2, 'Auswahl', 0, $3::jsonb)",
            table_id,
            copy_project,
            json.dumps(
                {
                    "workflow_export": {
                        "workflow_id": str(uuid.uuid4()),
                        "export_node_id": "save",
                    }
                }
            ),
        )
    finally:
        await conn.close()

    second = await asyncio.to_thread(
        run_workflow, _custom_sql_export(SCHOOLS_OF.format("Grundschule")), workflow_id
    )
    second.assert_succeeded()
    layer_id = second.step("save")["layer_id"]
    assert layer_id != table_id, "the copy's table must not be overwritten"
    saved = await _saved_layer(tool_settings, layer_id)
    assert (saved["type"], saved["feature_layer_geometry_type"]) == ("feature", "point")
    [entry] = await _entry_properties(tool_settings, layer_id)
    assert _drawable(entry), entry
    assert entry["legend"] == {"collapsed": False}
    assert (await _saved_layer(tool_settings, table_id))["type"] == "table"


async def test_a_table_result_stays_a_table_layer_when_overwritten(
    run_workflow: Any, tool_settings: Any
) -> None:
    workflow_id = str(uuid.uuid4())
    config = _custom_sql_export("SELECT name, schulart FROM input_1")
    first = await asyncio.to_thread(run_workflow, config, workflow_id)
    second = await asyncio.to_thread(run_workflow, config, workflow_id)
    first.assert_succeeded()
    second.assert_succeeded()
    layer_id = first.step("save")["layer_id"]
    assert second.step("save")["layer_id"] == layer_id
    saved = await _saved_layer(tool_settings, layer_id)
    assert (saved["type"], saved["feature_layer_geometry_type"]) == ("table", None)


async def test_a_setting_from_a_variable_reaches_the_tool_as_a_list(
    run_workflow: Any,
) -> None:
    config = workflow(
        [dataset("schools", SCHULEN), tool("ring", "buffer", distances="{{@radius}}")],
        [edge("schools", "ring")],
        variables=[
            {"id": "v-radius", "name": "radius", "type": "number", "defaultValue": 300}
        ],
    )
    run = await asyncio.to_thread(run_workflow, config)
    run.assert_succeeded()
    assert run.args("ring")["distances"] == [300]
    assert run.step("ring")["feature_count"] == 12


async def test_running_a_workflow_again_replaces_its_temp_results(
    run_workflow: Any, saved_rows: Any
) -> None:
    config = workflow(
        [dataset("shops", SUPERMAERKTE, WEST), export("save", "Märkte im Westen")],
        [into_export("shops", "save")],
    )
    workflow_id = str(uuid.uuid4())
    first = await asyncio.to_thread(run_workflow, config, workflow_id)
    second = await asyncio.to_thread(run_workflow, config, workflow_id)
    first.assert_succeeded()
    second.assert_succeeded()
    folder = (
        second.temp_root
        / f"user_{TEST_USER_ID.replace('-', '')}"
        / f"w_{workflow_id.replace('-', '')}"
        / "n_shops"
    )
    assert len(list(folder.glob("t_*.parquet"))) == 1
    saved = {first.step("save")["layer_id"], second.step("save")["layer_id"]}
    assert len(saved) == 2
    assert [saved_rows(layer_id) for layer_id in saved] == [6, 6]
