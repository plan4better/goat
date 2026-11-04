"""Unit tests for DissolveTool statistics columns."""

from pathlib import Path

import duckdb
from goatlib.analysis.geoprocessing.dissolve import DissolveTool
from goatlib.analysis.schemas.base import FieldStatistic
from goatlib.analysis.schemas.geoprocessing import DissolveParams
from goatlib.tools.dissolve import DissolveToolRunner

GROUP = "Art der Fläche"
FIELD = 'Einwohner über 65 "alt"'


def _q(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def test_statistic_columns_are_the_predicted_columns(tmp_path: Path) -> None:
    """The run names each statistic as the schema prediction does: its
    result_name, else `count` or `{operation}_{field}`; group and field
    names hold spaces, an umlaut and a double quote."""
    source = str(tmp_path / "source.parquet")
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute(f"""
        COPY (
            SELECT category AS {_q(GROUP)}, value AS {_q(FIELD)},
                   ST_GeomFromText(wkt) AS geom
            FROM (VALUES
                ('a', 10, 'POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))'),
                ('a', 20, 'POLYGON((1 0, 2 0, 2 1, 1 1, 1 0))'),
                ('b', 40, 'POLYGON((5 5, 6 5, 6 6, 5 6, 5 5))')
            ) t(category, value, wkt)
        ) TO '{source}' (FORMAT PARQUET)
    """)
    con.close()
    statistics = [
        {"operation": "sum", "field": FIELD},
        {"operation": "mean", "field": FIELD, "result_name": "Mittel der Älteren"},
        {"operation": "count", "result_name": 'Anzahl "Flächen"'},
    ]
    output_path = str(tmp_path / "out.parquet")

    DissolveTool().run(
        DissolveParams(
            input_path=source,
            dissolve_fields=[GROUP],
            field_statistics=[FieldStatistic(**s) for s in statistics],
            output_path=output_path,
        )
    )

    predicted = DissolveToolRunner.predict_output_schema(
        {"input_layer_id": {GROUP: "VARCHAR", FIELD: "INTEGER"}},
        {
            "dissolve_fields": [GROUP],
            "calculate_statistics": True,
            "field_statistics": statistics,
        },
    )
    con = duckdb.connect()
    con.execute("LOAD spatial;")
    rel = con.execute(f"SELECT * FROM '{output_path}' ORDER BY {_q(GROUP)}")
    names = [d[0] for d in rel.description]
    rows = [dict(zip(names, row)) for row in rel.fetchall()]
    con.close()

    # The parquet writer adds a bbox column for spatial filtering; it is no
    # layer column.
    assert set(names) - {"bbox"} == set(predicted)
    assert [r[f"sum_{FIELD}"] for r in rows] == [30, 40]
    assert [r["Mittel der Älteren"] for r in rows] == [15, 40]
    assert [r['Anzahl "Flächen"'] for r in rows] == [2, 1]
