"""A column a tool writes under a user-given name is read by the next tool.

Result names and the columns of uploaded layers hold spaces, umlauts and
double quotes; every tool that reads such a column refers to it as one quoted
identifier.
"""

import json
from pathlib import Path

import duckdb
import pytest
from goatlib.analysis.data_management.join import JoinTool
from goatlib.analysis.geoanalysis.aggregate_points import AggregatePointsTool
from goatlib.analysis.geoanalysis.aggregate_polygon import AggregatePolygonTool
from goatlib.analysis.schemas.aggregate import (
    AggregatePointsParams,
    AggregatePolygonParams,
    AggregationAreaType,
)
from goatlib.analysis.schemas.base import FieldStatistic, StatisticOperation
from goatlib.analysis.schemas.data_management import (
    AttributeRelationship,
    JoinOperationType,
    JoinParams,
    JoinType,
    MultipleMatchingRecordsType,
    SortConfiguration,
    SortOrder,
)

SUM_NAME = "Einwohner im Einzugsbereich"
COUNT_NAME = 'Anzahl "alt"'
AREA_NAME = "Name des Gebiets"
AREA_KEY = 'Kennung "intern"'
JOIN_AREA = "Gebiet"
JOIN_SIZE = "Fläche km²"


def _q(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _read(path: str | Path) -> list[dict]:
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    rel = con.execute(f"SELECT * FROM read_parquet('{path}')")
    names = [d[0] for d in rel.description]
    rows = [dict(zip(names, row)) for row in rel.fetchall()]
    con.close()
    return rows


def _as_dict(value: object) -> dict:
    return json.loads(value) if isinstance(value, str) else dict(value)


@pytest.fixture
def aggregated(tmp_path: Path) -> str:
    """Points summed onto two areas whose columns hold spaces and quotes:
    north gets 10 + 20 from two points, south 40 from one."""
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    areas = str(tmp_path / "areas.parquet")
    points = str(tmp_path / "points.parquet")
    con.execute(f"""
        COPY (
            SELECT id, name AS {_q(AREA_NAME)}, kennung AS {_q(AREA_KEY)},
                   ST_GeomFromText(wkt) AS geom
            FROM (VALUES
                (1, 'Nord', 'N1',
                 'POLYGON((11.50 48.10, 11.51 48.10, 11.51 48.11, 11.50 48.11, 11.50 48.10))'),
                (2, 'Süd', 'S1',
                 'POLYGON((11.52 48.10, 11.53 48.10, 11.53 48.11, 11.52 48.11, 11.52 48.10))')
            ) t(id, name, kennung, wkt)
        ) TO '{areas}' (FORMAT PARQUET)
    """)
    con.execute(f"""
        COPY (
            SELECT * FROM (VALUES
                (10, ST_Point(11.501, 48.101)),
                (20, ST_Point(11.502, 48.102)),
                (40, ST_Point(11.521, 48.101))
            ) t(value, geom)
        ) TO '{points}' (FORMAT PARQUET)
    """)
    con.close()
    output_path = str(tmp_path / "aggregated.parquet")
    AggregatePointsTool().run(
        AggregatePointsParams(
            source_path=points,
            area_type=AggregationAreaType.polygon,
            area_layer_path=areas,
            column_statistics=[
                FieldStatistic(
                    operation=StatisticOperation.sum,
                    field="value",
                    result_name=SUM_NAME,
                ),
                FieldStatistic(
                    operation=StatisticOperation.count, result_name=COUNT_NAME
                ),
            ],
            output_path=output_path,
        )
    )
    return output_path


def _by_area(rows: list[dict]) -> dict[str, dict]:
    return {row[AREA_NAME]: row for row in rows}


def test_aggregate_points_keeps_area_columns_and_result_names(
    aggregated: str,
) -> None:
    rows = _by_area(_read(aggregated))
    assert rows["Nord"][SUM_NAME] == 30
    assert rows["Nord"][COUNT_NAME] == 2
    assert rows["Nord"][AREA_KEY] == "N1"
    assert rows["Süd"][SUM_NAME] == 40
    assert rows["Süd"][COUNT_NAME] == 1


@pytest.mark.parametrize("weighted", [False, True])
def test_aggregate_polygon_sums_the_named_columns(
    aggregated: str, tmp_path: Path, weighted: bool
) -> None:
    """The aggregated areas, summed onto one area that covers both, grouped
    by an area column whose name holds spaces."""
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    cover = str(tmp_path / "cover.parquet")
    con.execute(f"""
        COPY (
            SELECT 1 AS id, ST_GeomFromText(
                'POLYGON((11.49 48.09, 11.54 48.09, 11.54 48.12, 11.49 48.12, 11.49 48.09))'
            ) AS geom
        ) TO '{cover}' (FORMAT PARQUET)
    """)
    con.close()
    output_path = str(tmp_path / "summed.parquet")
    AggregatePolygonTool().run(
        AggregatePolygonParams(
            source_path=aggregated,
            area_type=AggregationAreaType.polygon,
            area_layer_path=cover,
            column_statistics=[
                FieldStatistic(operation=StatisticOperation.sum, field=SUM_NAME),
                FieldStatistic(
                    operation=StatisticOperation.sum,
                    field=COUNT_NAME,
                    result_name='Summe "alt"',
                ),
            ],
            weighted_by_intersecting_area=weighted,
            group_by_field=[AREA_NAME],
            output_path=output_path,
        )
    )

    (row,) = _read(output_path)
    assert row[f"sum_{SUM_NAME}"] == pytest.approx(70)
    assert row['Summe "alt"'] == pytest.approx(3)
    grouped = _as_dict(row[f"sum_{SUM_NAME}_grouped"])
    assert grouped == {"Nord": pytest.approx(30), "Süd": pytest.approx(40)}
    grouped = _as_dict(row['Summe "alt"_grouped'])
    assert grouped == {"Nord": pytest.approx(2), "Süd": pytest.approx(1)}


def _join_params(
    target: str, join: str, output_path: str, **overrides: object
) -> JoinParams:
    settings: dict = {
        "target_path": target,
        "join_path": join,
        "output_path": output_path,
        "use_spatial_relationship": False,
        "use_attribute_relationship": True,
        "attribute_relationships": [
            AttributeRelationship(target_field=AREA_NAME, join_field=JOIN_AREA)
        ],
        "join_operation": JoinOperationType.one_to_one,
        "multiple_matching_records": MultipleMatchingRecordsType.first_record,
        "join_type": JoinType.left,
    }
    return JoinParams(**{**settings, **overrides})


@pytest.mark.parametrize(
    ("overrides", "expected"),
    [
        ({}, {f"join_{JOIN_SIZE}": 12.5}),
        (
            {
                "sort_configuration": SortConfiguration(
                    field=JOIN_SIZE, sort_order=SortOrder.descending
                )
            },
            {f"join_{JOIN_SIZE}": 12.5},
        ),
        (
            {"join_operation": JoinOperationType.one_to_many},
            {f"join_{JOIN_SIZE}": 12.5},
        ),
        (
            {
                "multiple_matching_records": (
                    MultipleMatchingRecordsType.calculate_statistics
                ),
                "field_statistics": [
                    FieldStatistic(
                        operation=StatisticOperation.sum,
                        field=JOIN_SIZE,
                        result_name="Fläche gesamt",
                    )
                ],
            },
            {"Fläche gesamt": 12.5, "match_count": 1},
        ),
        (
            {"multiple_matching_records": MultipleMatchingRecordsType.count_only},
            {"match_count": 1},
        ),
    ],
    ids=["first_record", "sorted", "one_to_many", "statistics", "count_only"],
)
def test_join_keeps_the_target_columns_and_reads_the_join_columns(
    aggregated: str, tmp_path: Path, overrides: dict, expected: dict
) -> None:
    """The aggregated areas as the target of an attribute join on a column
    whose name holds spaces, with a join layer whose columns do too."""
    con = duckdb.connect()
    join = str(tmp_path / "sizes.parquet")
    con.execute(f"""
        COPY (
            SELECT gebiet AS {_q(JOIN_AREA)}, size AS {_q(JOIN_SIZE)}
            FROM (VALUES ('Nord', 12.5), ('Süd', 7.5)) t(gebiet, size)
        ) TO '{join}' (FORMAT PARQUET)
    """)
    con.close()
    output_path = str(tmp_path / "joined.parquet")
    tool = JoinTool()
    tool.run(_join_params(aggregated, join, output_path, **overrides))
    tool.cleanup()

    rows = _by_area(_read(output_path))
    north = rows["Nord"]
    assert north[SUM_NAME] == 30
    assert north[COUNT_NAME] == 2
    assert north[AREA_KEY] == "N1"
    for column, value in expected.items():
        assert north[column] == value, column
    assert rows["Süd"][SUM_NAME] == 40
