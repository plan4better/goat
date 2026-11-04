"""The join tool's predicted output schema matches what a run writes.

Workflows show the predicted columns before a run (column pickers, the SQL
node's input list), so a name that differs from the real output breaks SQL
written against it only once the workflow runs. Each case runs the analysis
with the parameters the runner builds and compares the written columns, in
order, with ``predict_output_schema`` given the raw node configuration. The
``bbox`` struct every GeoParquet write adds is storage detail (see
``goatlib.io.bbox_columns``) and not compared.
"""

from pathlib import Path

import duckdb
import pytest
from goatlib.analysis.data_management.join import JoinTool
from goatlib.io.bbox_columns import is_bbox_struct
from goatlib.tools.join import JoinToolParams, JoinToolRunner

DATA = Path(__file__).parent.parent.parent / "data" / "vector"

IDS = {
    "user_id": "00000000-0000-0000-0000-000000000001",
    "folder_id": "00000000-0000-0000-0000-000000000002",
    "target_layer_id": "00000000-0000-0000-0000-000000000003",
    "join_layer_id": "00000000-0000-0000-0000-000000000004",
}

ATTRIBUTE = {
    "use_spatial_relationship": False,
    "use_attribute_relationship": True,
    "attribute_relationships": [
        {"target_field": "department", "join_field": "department"},
        {"target_field": "level", "join_field": "level"},
    ],
}
SPATIAL = {
    "use_spatial_relationship": True,
    "use_attribute_relationship": False,
    "spatial_relationship": "intersects",
}

# (case, target, join, node configuration as the workflow stores it)
CASES = [
    (
        "left join picks some fields",
        "employees",
        "salary_bands",
        {**ATTRIBUTE, "join_type": "left", "join_fields": ["max_salary"]},
    ),
    (
        "inner join with join fields on, all picked",
        "employees",
        "salary_bands",
        {
            **ATTRIBUTE,
            "add_join_fields": True,
            "join_fields": ["department", "level", "min_salary", "max_salary"],
        },
    ),
    (
        "inner join with join fields off adds nothing",
        "employees",
        "salary_bands",
        {**ATTRIBUTE, "join_fields": ["max_salary"]},
    ),
    (
        "one-to-many",
        "employees",
        "salary_bands",
        {
            **ATTRIBUTE,
            "join_type": "left",
            "join_operation": "one_to_many",
            "join_fields": ["min_salary"],
        },
    ),
    (
        "statistics without a count get match_count",
        "employees",
        "salary_bands",
        {
            **ATTRIBUTE,
            "join_type": "left",
            "calculate_statistics": True,
            "column_statistics": [
                {"operation": "sum", "field": "max_salary"},
                {"operation": "mean", "field": "min_salary", "result_name": "avg_min"},
            ],
        },
    ),
    (
        "statistics with a count",
        "employees",
        "salary_bands",
        {
            **ATTRIBUTE,
            "calculate_statistics": True,
            "column_statistics": [
                {"operation": "count"},
                {"operation": "max", "field": "max_salary"},
            ],
        },
    ),
    (
        "spatial left join takes the join layer's fields, not its geometry",
        "poi_points",
        "districts",
        {
            **SPATIAL,
            "join_type": "left",
            "join_fields": ["district_name", "population"],
        },
    ),
    (
        "spatial left join without a field list takes every join field",
        "poi_points",
        "districts",
        {**SPATIAL, "join_type": "left"},
    ),
    (
        "join fields on without a field list takes every join field",
        "employees",
        "salary_bands",
        {**ATTRIBUTE, "add_join_fields": True},
    ),
    (
        "join fields on with every field unticked takes none",
        "employees",
        "salary_bands",
        {**ATTRIBUTE, "add_join_fields": True, "join_fields": []},
    ),
    (
        "disjoint keeps the target columns alone",
        "poi_points",
        "districts",
        {
            **SPATIAL,
            "spatial_relationship": "disjoint",
            "join_type": "left",
            "join_fields": ["district_name"],
        },
    ),
]


def _schema(path: Path) -> dict[str, str]:
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    try:
        rows = con.execute(f"DESCRIBE SELECT * FROM read_parquet('{path}')").fetchall()
    finally:
        con.close()
    return {r[0]: r[1] for r in rows}


def _run(tmp_path: Path, target: str, join: str, config: dict) -> list[str]:
    target_path, join_path = DATA / f"{target}.parquet", DATA / f"{join}.parquet"
    tool = JoinTool()
    try:
        result_path, _ = tool.run(
            JoinToolRunner.analysis_params(
                JoinToolParams(**IDS, **config),
                target_path,
                join_path,
                tmp_path / "out.parquet",
            )
        )[0]
    finally:
        tool.cleanup()
    return [c for c, t in _schema(Path(result_path)).items() if not is_bbox_struct(t)]


@pytest.mark.parametrize(
    ("target", "join", "config"),
    [c[1:] for c in CASES],
    ids=[c[0] for c in CASES],
)
def test_prediction_matches_the_written_columns(
    tmp_path: Path, target: str, join: str, config: dict
) -> None:
    predicted = JoinToolRunner.predict_output_schema(
        {
            "target_layer_id": _schema(DATA / f"{target}.parquet"),
            "join_layer_id": _schema(DATA / f"{join}.parquet"),
        },
        config,
    )
    assert list(predicted) == _run(tmp_path, target, join, config)


def test_join_fields_are_prefixed() -> None:
    """The case behind this test: a SQL node read ``total_accessibility``
    from the preview, but the joined layer holds ``join_total_accessibility``."""
    predicted = JoinToolRunner.predict_output_schema(
        {
            "target_layer_id": {"einwohner": "DOUBLE", "geometry": "GEOMETRY"},
            "join_layer_id": {"total_accessibility": "DOUBLE", "geometry": "GEOMETRY"},
        },
        {**SPATIAL, "join_type": "left", "join_fields": ["total_accessibility"]},
    )

    assert predicted == {
        "einwohner": "DOUBLE",
        "geometry": "GEOMETRY",
        "join_total_accessibility": "DOUBLE",
    }


def test_join_fields_left_unset_are_every_field_of_the_join_layer(
    tmp_path: Path,
) -> None:
    """The form pre-ticks every field of the join layer (`default_all`), so a
    join drafted without the form adds them all, its geometry aside."""
    written = _run(
        tmp_path, "poi_points", "districts", {**SPATIAL, "join_type": "left"}
    )
    assert [c for c in written if c.startswith("join_")] == [
        "join_district_id",
        "join_district_name",
        "join_zone_type",
        "join_population",
    ]
