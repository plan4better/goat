"""Reading workflow runs (spec 2026-10-23 §3.2, §4): summaries from
processes' job status, the progress part, the runs a conversation started,
and the permission to start one."""

import copy
import json
from pathlib import Path
from typing import Any

from assistant.asks import AskHistory, AskUserInput, CardAnswer
from assistant.workflows.runs import (
    FAILED,
    MAX_STEP_SETTINGS,
    RUN_VALUE,
    RUNNING,
    SUCCEEDED,
    SUCCEEDED_UNSAVED,
    ConversationRuns,
    is_active,
    latest_job,
    overwrites,
    refused_part,
    refused_summary,
    run_part,
    run_permission,
    started_part,
    summarize,
    unnamed_active,
)

WF = "0b6f0000-0000-0000-0000-00000000f10f"
DESCRIPTIONS: dict[str, Any] = json.loads(
    (Path(__file__).parent / "fixtures" / "process_descriptions.json").read_text(
        encoding="utf-8"
    )
)["descriptions"]
CONFIG: dict[str, Any] = {
    "nodes": [
        {
            "id": "dataset-a",
            "type": "dataset",
            "data": {"type": "dataset", "label": "Praxen"},
        },
        {
            "id": "tool-walk",
            "type": "tool",
            "data": {
                "type": "tool",
                "processId": "catchment_area_v2",
                "label": "15 Minuten zu Fuß",
            },
        },
        {
            "id": "tool-sum",
            "type": "tool",
            "data": {
                "type": "tool",
                "processId": "aggregate_points",
                "label": "Einwohner je Band",
            },
        },
        {
            "id": "export-save",
            "type": "export",
            "data": {
                "type": "export",
                "label": "Save as dataset",
                "datasetName": "Einwohner je Band",
            },
        },
    ],
    "edges": [],
}


def _job(status: str, **extra: Any) -> dict[str, Any]:
    return {
        "jobID": "j1",
        "processID": "workflow_runner",
        "status": status,
        "inputs": {"workflow_id": WF},
        "created": "2026-10-23T08:41:30Z",
        "started": "2026-10-23T08:41:31Z",
        **extra,
    }


SUCCEEDED_JOB = _job(
    "successful",
    finished="2026-10-23T08:42:10Z",
    result={
        "status": "success",
        "errors": [],
        "node_jobs": {},
        "node_results": {
            "tool-walk": {"status": "success", "feature_count": 3},
            "tool-sum": {"status": "success", "feature_count": 3},
            "export-save": {
                "layer_id": "cdba99a2-cc32-4da5-85ef-1d982b9c6dc8",
                "layer_name": "Einwohner je Band",
                "layer_project_id": 80487,
                "feature_count": 3,
            },
        },
    },
)


def test_a_finished_run_lists_its_steps_and_what_it_saved() -> None:
    summary, layer_ids = summarize(SUCCEEDED_JOB, CONFIG, workflow_id=WF)
    assert summary.status == "succeeded"
    assert summary.job_id == "j1"
    assert [(s.name, s.tool, s.status, s.rows) for s in summary.steps] == [
        ("15 Minuten zu Fuß", "catchment_area_v2", "done", 3),
        ("Einwohner je Band", "aggregate_points", "done", 3),
        ("Save as dataset", None, "done", 3),
    ]
    assert [(s.name, s.layer_project_id, s.rows) for s in summary.saved] == [
        ("Einwohner je Band", 80487, 3)
    ]
    assert layer_ids == {80487: "cdba99a2-cc32-4da5-85ef-1d982b9c6dc8"}
    assert summary.note == SUCCEEDED


def test_a_finished_run_that_saved_nothing_says_so() -> None:
    config = {"nodes": CONFIG["nodes"][:3], "edges": []}
    summary, _ = summarize(SUCCEEDED_JOB, config, workflow_id=WF)
    assert summary.saved == []
    assert summary.note == SUCCEEDED_UNSAVED


def test_a_failed_run_names_the_step_and_its_error() -> None:
    error = "step_sizes are the band edges: ... For 3 bands up to 15: [5, 10, 15]."
    job = _job(
        "failed",
        node_errors={"tool-walk": error},
        node_status={
            "tool-walk": {"status": "failed", "error": error},
            "tool-sum": {"status": "pending"},
        },
    )
    summary, layer_ids = summarize(job, CONFIG, workflow_id=WF)
    assert summary.status == "failed"
    # processes reports a failed run's failing step only: a step it reports
    # nothing for may have finished, so it is unknown, not pending.
    assert [(s.status, s.error) for s in summary.steps] == [
        ("failed", error),
        ("pending", None),
        ("unknown", None),
    ]
    assert summary.saved == [] and layer_ids == {}
    assert summary.note == FAILED
    assert "unknown" in FAILED


def test_a_running_run_shows_the_running_step() -> None:
    job = _job(
        "running",
        node_status={
            "tool-walk": {"status": "completed"},
            "tool-sum": {"status": "running"},
        },
    )
    summary, _ = summarize(job, CONFIG, workflow_id=WF)
    assert summary.status == "running" and summary.note == RUNNING
    part = run_part(summary, project_id="p1", started_here=True, card_id=None)
    assert part == {
        "workflow_id": WF,
        "project_id": "p1",
        "job_id": "j1",
        "status": "running",
        "started": True,
        "card_id": None,
        "done": 1,
        "total": 3,
        "step": "Einwohner je Band",
        "started_at": "2026-10-23T08:41:31Z",
        "saved": 0,
    }


def test_a_skipped_step_and_a_dismissed_job() -> None:
    job = _job(
        "dismissed",
        result={
            "node_results": {"tool-walk": {"status": "skipped", "skipped_by": "if-1"}}
        },
    )
    summary, _ = summarize(job, CONFIG, workflow_id=WF)
    assert summary.status == "cancelled"
    assert [s.status for s in summary.steps] == ["skipped", "unknown", "unknown"]


def test_a_long_error_is_cut() -> None:
    job = _job("failed", node_errors={"tool-walk": "x" * 900})
    summary, _ = summarize(job, CONFIG, workflow_id=WF)
    error = summary.steps[0].error
    assert error is not None and len(error) == 500


PT_CATCHMENT: dict[str, Any] = {
    "nodes": [
        {
            "id": "dataset-a",
            "type": "dataset",
            "data": {
                "type": "dataset",
                "label": "Praxen",
                "layerId": "cdba99a2-cc32-4da5-85ef-1d982b9c6dc8",
                "filter": {"op": "and", "expressions": []},
            },
        },
        {
            "id": "tool-pt",
            "type": "tool",
            "data": {
                "type": "tool",
                "processId": "catchment_area_v2",
                "label": "30 Minuten mit dem ÖV",
                "config": {
                    "routing_mode": "pt",
                    "max_cost": "{{@minutes}}",
                    "steps": 3,
                    "speed": None,
                    "pt_modes": ["bus", "tram", "subway"],
                    "pt_day": "weekday",
                    "pt_start_time": 25200,
                    "pt_end_time": 30600,
                    "access_max_time": 15,
                    "catchment_area_type": "polygon",
                    "starting_points": {"layer_id": "x", "type": "layer"},
                    "point_grid_layer_id": "cdba99a2-cc32-4da5-85ef-1d982b9c6dc8",
                    "point_grid_layer_filter": "name = 'x'",
                    "pt_network_bundle_id": "b0000000-0000-0000-0000-0000000000b1",
                    "_pt_network_bundle_id_is_custom": False,
                    "show_advanced": True,
                    "reference_field": "",
                    "result_layer_name": "Einzugsgebiet " + "x" * 90,
                    "opportunities": [{"layer_id": "y", "potential": 1}],
                },
            },
        },
        {
            "id": "export-save",
            "type": "export",
            "data": {
                "type": "export",
                "label": "Save as dataset",
                "datasetName": "Einzugsgebiete",
            },
        },
    ],
    "edges": [],
    "variables": [
        {"id": "v1", "name": "minutes", "type": "number", "defaultValue": 30}
    ],
}


def test_a_tool_step_lists_the_settings_the_run_used() -> None:
    """The method as it ran: the mode, the limit (its variable resolved), the
    time window as times of day; no ids, filters, geometries, empty values,
    result layer names or the editor's own flags."""
    summary, _ = summarize(_job("successful"), PT_CATCHMENT, workflow_id=WF)
    walk, export = summary.steps
    assert walk.tool == "catchment_area_v2"
    assert walk.settings == {
        "routing_mode": "pt",
        "max_cost": 30,
        "steps": 3,
        "pt_modes": "bus, tram, subway",
        "pt_day": "weekday",
        "pt_start_time": "07:00",
        "pt_end_time": "08:30",
        "access_max_time": 15,
        "catchment_area_type": "polygon",
    }
    assert export.settings is None
    assert "settings" not in export.model_dump(exclude_none=True)


def test_a_run_lists_the_settings_it_was_sent() -> None:
    """The run's own nodes and variables, as processes keeps them with the
    job, not the stored config: the toolbox sends other variable values and
    the editor its unsaved nodes."""
    sent = copy.deepcopy(PT_CATCHMENT)
    sent["nodes"][1]["data"]["config"]["routing_mode"] = "bicycle"
    sent["nodes"][1]["data"]["config"]["pt_end_time"] = 32400
    sent["variables"][0]["defaultValue"] = 45
    job = _job(
        "successful",
        inputs={
            "workflow_id": WF,
            "nodes": sent["nodes"],
            "edges": [],
            "variables": [{"name": "minutes", "type": "number", "defaultValue": 45}],
        },
    )
    summary, _ = summarize(job, PT_CATCHMENT, workflow_id=WF)
    settings = summary.steps[0].settings
    assert settings is not None
    assert settings["routing_mode"] == "bicycle"
    assert settings["max_cost"] == 45
    assert settings["pt_end_time"] == "09:00"


def test_a_run_without_its_nodes_lists_the_stored_settings() -> None:
    """A node the run's inputs do not hold, or a job without them, reads the
    stored config."""
    job = _job("successful", inputs={"workflow_id": WF, "nodes": []})
    summary, _ = summarize(job, PT_CATCHMENT, workflow_id=WF)
    settings = summary.steps[0].settings
    assert settings is not None and settings["routing_mode"] == "pt"
    assert settings["max_cost"] == 30


def test_statistics_and_opportunities_are_listed_compactly() -> None:
    config = {
        "nodes": [
            {
                "id": "tool-sum",
                "type": "tool",
                "data": {
                    "type": "tool",
                    "processId": "aggregate_points",
                    "config": {
                        "source_layer_id": "cdba99a2-cc32-4da5-85ef-1d982b9c6dc8",
                        "area_type": "polygon",
                        "column_statistics": [
                            {"operation": "sum", "field": "einwohner"},
                            {"operation": "count", "field": None},
                            {"operation": "mean", "field": "{{@field}}"},
                        ],
                    },
                },
            },
            {
                "id": "tool-heat",
                "type": "tool",
                "data": {
                    "type": "tool",
                    "processId": "heatmap_gravity",
                    "config": {
                        "routing_mode": "walking",
                        "opportunities": [
                            {
                                "input_path": "/data/x.parquet",
                                "input_layer_filter": {"op": "="},
                                "layer_project_id": 7,
                                "name": "Schulen",
                                "max_cost": 15,
                                "sensitivity": 300000,
                            },
                            {"name": "Kitas " + "x" * 80, "max_cost": 10},
                        ],
                    },
                },
            },
        ],
        "variables": [{"name": "field", "defaultValue": "alter"}],
    }
    summary, _ = summarize(_job("successful"), config, workflow_id=WF)
    aggregate, heatmap = summary.steps
    assert aggregate.settings == {
        "area_type": "polygon",
        "column_statistics": "sum(einwohner), count, mean(alter)",
    }
    assert heatmap.settings is not None
    opportunities = heatmap.settings["opportunities"]
    assert isinstance(opportunities, str)
    assert opportunities.startswith("Schulen (max_cost 15), Kitas xxx")
    assert len(opportunities) == 80 and opportunities.endswith("…")


def test_a_single_statistic_object_is_listed_as_one() -> None:
    """The aggregate and join tools also take one statistic object instead of
    a list; other objects (starting points) stay out."""
    config = {
        "nodes": [
            {
                "id": "tool-sum",
                "type": "tool",
                "data": {
                    "type": "tool",
                    "processId": "aggregate_polygon",
                    "config": {
                        "column_statistics": {"operation": "sum", "field": "einwohner"},
                        "starting_points": {"name": "x", "max_cost": 5},
                    },
                },
            }
        ]
    }
    summary, _ = summarize(_job("successful"), config, workflow_id=WF)
    assert summary.steps[0].settings == {"column_statistics": "sum(einwohner)"}


def test_a_dataset_step_and_a_tool_without_settings_list_none() -> None:
    summary, _ = summarize(_job("successful"), CONFIG, workflow_id=WF)
    assert [step.settings for step in summary.steps] == [None, None, None]


def test_a_step_lists_at_most_15_settings() -> None:
    config = {
        "nodes": [
            {
                "id": "tool-many",
                "type": "tool",
                "data": {
                    "type": "tool",
                    "processId": "buffer",
                    "config": {f"setting_{n:02d}": n for n in range(20)},
                },
            }
        ]
    }
    summary, _ = summarize(_job("successful"), config, workflow_id=WF)
    [step] = summary.steps
    assert step.settings is not None
    assert list(step.settings) == [f"setting_{n:02d}" for n in range(15)]


def _one_tool(process_id: str, config: dict[str, Any]) -> dict[str, Any]:
    return {
        "nodes": [
            {
                "id": "tool-one",
                "type": "tool",
                "data": {"type": "tool", "processId": process_id, "config": config},
            }
        ]
    }


def test_sql_text_says_nothing_but_a_potential_expression_does() -> None:
    """SQL literals can hold data values, also under the Restricted policy;
    a heatmap's potential expression is its method."""
    config = _one_tool(
        "custom_sql",
        {
            "sql_query": "SELECT * FROM input_1 WHERE name = 'Anna Muster'",
            "boolean_sql": "einwohner > 1200",
            "source_sql": "SELECT 1",
            "select_sql": "SELECT 2",
            "opportunity_1_potential_expression": "capacity * 2",
            "potential_expression": "beds / 10",
        },
    )
    summary, _ = summarize(_job("successful"), config, workflow_id=WF)
    assert summary.steps[0].settings == {
        "opportunity_1_potential_expression": "capacity * 2",
        "potential_expression": "beds / 10",
    }


#: An editor-saved catchment, 20 settings in the description's order: the
#: result layer names come first and the shape settings last.
EDITOR_CATCHMENT: dict[str, Any] = {
    "result_layer_name": "Einzugsgebiet",
    "starting_points_layer_name": "Startpunkte",
    "routing_mode": "walking",
    "pt_modes": ["bus", "tram"],
    "pt_max_transfers": 5,
    "street_network_bundle_id": "default",
    "starting_points": {"layer_id": "x"},
    "reference_field": "",
    "cost_type": "time",
    "max_cost": 15,
    "speed": 5,
    "steps": 3,
    "step_sizes": [5, 10, 15],
    "pt_day": "weekday",
    "pt_start_time": 25200,
    "pt_end_time": 32400,
    "show_advanced": True,
    "catchment_area_type": "polygon",
    "shape_style": "separated",
    "steps_style": "cumulative",
}


def test_result_layer_names_do_not_crowd_out_the_method() -> None:
    """Names of result layers are skipped before the cap counts, so the
    shape settings at the end of a full config stay listed."""
    assert len(EDITOR_CATCHMENT) == 20
    config = _one_tool("catchment_area_v2", EDITOR_CATCHMENT)
    summary, _ = summarize(_job("successful"), config, workflow_id=WF)
    settings = summary.steps[0].settings
    assert settings is not None
    assert {"catchment_area_type", "shape_style", "steps_style"} <= set(settings)
    assert settings["shape_style"] == "separated"
    assert "result_layer_name" not in settings
    assert "starting_points_layer_name" not in settings


def test_an_opportunitys_method_is_never_a_presentation_setting() -> None:
    config = _one_tool(
        "heatmap_gravity",
        {
            "result_layer_name": "Heatmap",
            "routing_mode": "walking",
            "opportunity_1_layer_project_id": 7,
            "opportunity_1_max_cost": 10,
            "opportunity_1_sensitivity": 300000,
            "opportunity_1_potential_field": "beds",
            "opportunity_1_potential_expression": "beds * 2",
            "opportunity_1_n_destinations": 3,
        },
    )
    summary, _ = summarize(_job("successful"), config, workflow_id=WF)
    assert summary.steps[0].settings == {
        "routing_mode": "walking",
        "opportunity_1_max_cost": 10,
        "opportunity_1_sensitivity": 300000,
        "opportunity_1_potential_field": "beds",
        "opportunity_1_potential_expression": "beds * 2",
        "opportunity_1_n_destinations": 3,
    }


def _catchment_defaults(
    config: dict[str, Any], variables: list[dict[str, Any]] | None = None
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """The settings and defaults of a catchment step with ``config``."""
    workflow = _one_tool("catchment_area_v2", config)
    workflow["variables"] = variables or []
    summary, _ = summarize(
        _job("successful"),
        workflow,
        workflow_id=WF,
        descriptions={"catchment_area_v2": DESCRIPTIONS["catchment_area_v2"]},
    )
    [step] = summary.steps
    return step.settings, step.defaults


def test_a_transit_catchment_lists_the_time_window_it_left_at_its_default() -> None:
    """A draft leaves out what fits at its default: the summary still gives
    the window the run used, as times of day, the day and the modes, apart
    from the settings the run was sent. A setting sent as null is left out
    as well (the tool's script drops it)."""
    settings, defaults = _catchment_defaults(
        {"routing_mode": "{{@mode}}", "max_cost": 30, "steps": 3, "pt_end_time": None},
        variables=[{"name": "mode", "defaultValue": "pt"}],
    )
    assert settings == {"routing_mode": "pt", "max_cost": 30, "steps": 3}
    assert defaults is not None
    assert defaults["pt_start_time"] == "07:00"
    assert defaults["pt_end_time"] == "09:00"
    assert defaults["pt_day"] == "weekday"
    assert defaults["pt_modes"] == (
        "bus, tram, rail, subway, ferry, cable_car, gondola, funicular"
    )
    assert defaults["catchment_area_type"] == "polygon"
    # Shown for walking and cycling only, and a time measure only.
    assert "shape_style" not in defaults and "cost_type" not in defaults


def test_a_walking_catchment_lists_no_transit_defaults() -> None:
    """The editor hides the transit settings on a walk, and so does the
    summary. A default the tool resolves from other settings (the speed by
    mode, the limit by mode and measure) is not listed: the description's
    static value is not always the one that runs."""
    _, defaults = _catchment_defaults(
        {"routing_mode": "walking", "max_cost": 15, "steps": 1}
    )
    assert defaults == {
        "cost_type": "time",
        "catchment_area_type": "polygon",
        "shape_style": "combined",
        "steps_style": "separate",
    }
    _, distance = _catchment_defaults(
        {"routing_mode": "car", "cost_type": "distance", "steps": 2}
    )
    assert distance is not None
    assert "max_cost" not in distance and "speed" not in distance


def test_a_setting_the_run_was_sent_is_not_repeated_as_a_default() -> None:
    settings, defaults = _catchment_defaults(
        {
            "routing_mode": "pt",
            "pt_start_time": 61200,
            "pt_day": "sunday",
            "catchment_area_type": "hexagonal_grid",
        }
    )
    assert settings is not None and settings["pt_start_time"] == "17:00"
    assert defaults is not None
    assert not {"pt_start_time", "pt_day", "catchment_area_type"} & set(defaults)
    assert defaults["pt_end_time"] == "09:00"
    # A grid has no bands to shape.
    assert "steps" not in defaults and "steps_style" not in defaults


def test_a_chosen_transit_network_shows_its_date_not_the_day() -> None:
    """The form computes whether a network other than the default one is
    chosen: then a date replaces the day, and the date has no default."""
    _, default_network = _catchment_defaults(
        {"routing_mode": "pt", "pt_network_bundle_id": "default"}
    )
    _, own_network = _catchment_defaults(
        {"routing_mode": "pt", "pt_network_bundle_id": "b0000000-0000-0000-0000-01"}
    )
    assert default_network is not None and default_network["pt_day"] == "weekday"
    assert own_network is not None and "pt_day" not in own_network


def test_a_tool_without_its_description_lists_no_defaults() -> None:
    config = _one_tool("catchment_area_v2", {"routing_mode": "pt"})
    for descriptions in (None, {}, {"buffer": DESCRIPTIONS["buffer"]}):
        summary, _ = summarize(
            _job("successful"), config, workflow_id=WF, descriptions=descriptions
        )
        [step] = summary.steps
        assert step.settings == {"routing_mode": "pt"} and step.defaults is None
        assert "defaults" not in step.model_dump(exclude_none=True)


def test_result_names_and_layer_inputs_are_no_defaults() -> None:
    summary, _ = summarize(
        _job("successful"),
        _one_tool("buffer", {"distances": [500]}),
        workflow_id=WF,
        descriptions={"buffer": DESCRIPTIONS["buffer"]},
    )
    [step] = summary.steps
    assert step.defaults == {
        "distance_type": "constant",
        "units": "meters",
        "polygon_union": False,
        "num_triangles": 8,
        "cap_style": "CAP_ROUND",
        "join_style": "JOIN_ROUND",
    }


def test_a_step_lists_at_most_15_defaults_in_the_descriptions_order() -> None:
    description = {
        "inputs": {
            f"setting_{n:02d}": {"schema": {"type": "integer", "default": n}}
            for n in range(20)
        }
    }
    summary, _ = summarize(
        _job("successful"),
        _one_tool("many", {f"setting_{n:02d}": n for n in range(20, 40)}),
        workflow_id=WF,
        descriptions={"many": description},
    )
    [step] = summary.steps
    assert step.settings is not None and len(step.settings) == MAX_STEP_SETTINGS
    assert step.defaults == {f"setting_{n:02d}": n for n in range(15)}


def test_a_refused_run_lists_its_issues() -> None:
    summary = refused_summary(WF, [{"message": "Walk: bad band edges."}, {"code": "x"}])
    assert summary.status == "refused" and summary.job_id is None
    assert summary.issues == ["Walk: bad band edges."]


def test_started_part_records_the_job_before_its_first_status() -> None:
    assert started_part(
        workflow_id=WF, project_id="p1", job_id="j1", total=3, card_id="c1"
    ) == {
        "workflow_id": WF,
        "project_id": "p1",
        "job_id": "j1",
        "status": "running",
        "started": True,
        "card_id": "c1",
        "done": 0,
        "total": 3,
        "step": None,
        "started_at": None,
        "saved": 0,
    }


def test_refused_part_records_the_pick_of_a_run_that_never_started() -> None:
    assert refused_part(workflow_id=WF, project_id="p1", total=3, card_id="c1") == {
        "workflow_id": WF,
        "project_id": "p1",
        "job_id": None,
        "status": "refused",
        "started": False,
        "card_id": "c1",
        "done": 0,
        "total": 3,
        "step": None,
        "started_at": None,
        "saved": 0,
    }


def test_latest_job_is_the_newest_run_of_that_workflow() -> None:
    jobs = {
        "jobs": [
            {
                "jobID": "a",
                "processID": "workflow_runner",
                "status": "successful",
                "inputs": {"workflow_id": WF},
                "created": "2026-10-23T08:00:00Z",
            },
            {
                "jobID": "b",
                "processID": "workflow_runner",
                "status": "running",
                "inputs": {"workflow_id": WF},
                "created": "2026-10-23T09:00:00Z",
            },
            {
                "jobID": "c",
                "processID": "workflow_runner",
                "status": "running",
                "inputs": {"workflow_id": "other"},
                "created": "2026-10-23T10:00:00Z",
            },
            {
                "jobID": "d",
                "processID": "buffer",
                "status": "running",
                "inputs": {"workflow_id": WF},
                "created": "2026-10-23T11:00:00Z",
            },
        ]
    }
    latest = latest_job(jobs, WF)
    assert latest is not None and latest["jobID"] == "b" and is_active(latest)
    assert latest_job({"jobs": []}, WF) is None


def test_an_active_run_without_inputs_cannot_be_told_apart() -> None:
    """processes leaves a job's inputs out when it could not read the job's
    details: an active one may be a run of any workflow."""
    unnamed = {
        "jobID": "x",
        "processID": "workflow_runner",
        "status": "running",
        "created": "2026-10-23T09:00:00Z",
    }
    assert unnamed_active({"jobs": [unnamed]})
    assert unnamed_active({"jobs": [{**unnamed, "status": "accepted"}]})
    assert not unnamed_active({"jobs": [{**unnamed, "status": "successful"}]})
    assert not unnamed_active({"jobs": [{**unnamed, "processID": "buffer"}]})
    assert not unnamed_active(
        {"jobs": [{**unnamed, "inputs": {"workflow_id": "other"}}]}
    )
    assert not unnamed_active({"jobs": []}) and not unnamed_active(None)


def _create_part(workflow_id: str) -> dict[str, Any]:
    return {
        "type": "tool",
        "tool_name": "workflow_create",
        "state": "output",
        "args": {},
        "output": {"workflow": {"id": workflow_id, "name": "W", "project_id": "p1"}},
    }


def _run_part(
    job_id: str, *, started: bool, card_id: str | None = None
) -> dict[str, Any]:
    return {
        "type": "data",
        "name": "workflow-run",
        "id": f"workflow-run:{job_id}",
        "data": {
            "workflow_id": WF,
            "job_id": job_id,
            "status": "running",
            "started": started,
            "card_id": card_id,
        },
    }


def test_the_conversation_runs_come_from_its_stored_parts() -> None:
    """Review Focus 4: an answer stopped while it waited has no tool output;
    its run part still says the conversation started that job."""
    messages = [
        {"role": "user", "parts": [{"type": "user_text", "text": "build it"}]},
        {"role": "assistant", "parts": [_create_part(WF)]},
        {
            "role": "assistant",
            "parts": [
                {
                    "type": "tool",
                    "tool_name": "workflow_run",
                    "state": "input-available",
                    "args": {"workflow_id": WF},
                },
                _run_part("j1", started=True, card_id="c1"),
                _run_part("j0", started=False),
            ],
        },
    ]
    runs = ConversationRuns.from_stored(messages)
    assert runs.created == {WF}
    assert runs.started == {"j1"}
    assert runs.used_cards == {"c1"}


def test_a_workflow_built_here_runs_without_asking() -> None:
    runs = ConversationRuns(created={WF})
    assert run_permission(runs, AskHistory(), WF, CONFIG, None) == (True, None)
    runs.started.add("j1")
    assert run_permission(runs, AskHistory(), WF, CONFIG, "j1") == (True, None)


def test_a_run_of_the_users_or_an_overwriting_export_needs_a_card() -> None:
    runs = ConversationRuns(created={WF})
    assert run_permission(runs, AskHistory(), WF, CONFIG, "theirs") == (False, None)
    overwriting = {
        "nodes": [
            *CONFIG["nodes"][:3],
            {
                "id": "export-save",
                "type": "export",
                "data": {"type": "export", "overwritePrevious": True},
            },
        ],
        "edges": [],
    }
    assert overwrites(overwriting)
    assert run_permission(runs, AskHistory(), WF, overwriting, None) == (False, None)


def test_an_overwrite_flag_counts_as_the_runner_reads_it() -> None:
    """The runner reads overwritePrevious as truthy, not only as True."""

    def flagged(value: Any) -> dict[str, Any]:
        export = {"type": "export", "overwritePrevious": value}
        return {"nodes": [{"id": "export-save", "type": "export", "data": export}]}

    assert overwrites(flagged(1)) and overwrites(flagged("yes"))
    assert not overwrites(flagged(0)) and not overwrites(flagged(None))


def test_a_workflow_from_elsewhere_needs_a_card() -> None:
    assert run_permission(ConversationRuns(), AskHistory(), WF, CONFIG, None) == (
        False,
        None,
    )


def _run_picks(*card_ids: str) -> AskHistory:
    """Cards that asked before a run of WF, each answered with Run."""
    card = AskUserInput.model_validate(
        {
            "questions": [
                {
                    "question": "Run it now?",
                    "header": "Run",
                    "options": [
                        {
                            "label": "Run",
                            "description": "Starts it.",
                            "value": RUN_VALUE.format(workflow_id=WF),
                        },
                        {"label": "Not now", "description": "Leaves it."},
                    ],
                }
            ]
        }
    )
    return AskHistory(
        cards={card_id: card for card_id in card_ids},
        answers={
            card_id: CardAnswer.model_validate(
                {"card_id": card_id, "answers": [{"question": 0, "options": [0]}]}
            )
            for card_id in card_ids
        },
    )


def test_a_run_pick_allows_a_run_of_a_workflow_from_elsewhere() -> None:
    asks = _run_picks("ask-run1")
    assert run_permission(ConversationRuns(), asks, WF, CONFIG, "theirs") == (
        True,
        "ask-run1",
    )


def test_a_run_pick_a_run_used_allows_no_other() -> None:
    runs = ConversationRuns(used_cards={"ask-run1"})
    assert run_permission(runs, _run_picks("ask-run1"), WF, CONFIG, None) == (
        False,
        None,
    )
    assert run_permission(
        runs, _run_picks("ask-run1", "ask-run2"), WF, CONFIG, None
    ) == (True, "ask-run2")


def test_a_run_that_needs_no_card_uses_up_an_outstanding_pick() -> None:
    """One pick, one run: a pick left over from a run that needed none would
    otherwise allow a later run the user never confirmed."""
    runs = ConversationRuns(created={WF})
    assert run_permission(runs, _run_picks("ask-run1"), WF, CONFIG, None) == (
        True,
        "ask-run1",
    )
