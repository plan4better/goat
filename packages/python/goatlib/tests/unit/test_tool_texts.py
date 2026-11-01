"""The texts the assistant's model reads say what a tool's output means."""

import json
from pathlib import Path

import pytest

TRANSLATIONS = Path(__file__).parents[2] / "src/goatlib/i18n/translations"


def _texts(language: str) -> dict:
    return json.loads((TRANSLATIONS / f"{language}.json").read_text())


@pytest.mark.parametrize(
    ("language", "path", "words"),
    [
        ("en", ("tools", "difference", "description"), ["cut", "not whole"]),
        (
            "de",
            ("tools", "difference", "description"),
            ["zugeschnitten", "nicht ganze Objekte", "Eingabeobjekte"],
        ),
        ("en", ("fields", "steps_style", "description"), ["ring", "cumulative"]),
        ("de", ("fields", "steps_style", "description"), ["Ring", "kumulativ"]),
        (
            "en",
            ("fields", "catchment_area_type", "description"),
            ["hexagon", "upper estimate"],
        ),
        (
            "de",
            ("fields", "catchment_area_type", "description"),
            ["Sechseck", "Obergrenze"],
        ),
        (
            "en",
            ("fields", "weighted_by_intersecting_area", "description"),
            [
                "share of each source",
                "count",
                "min and max",
                "standard deviation",
                "H3",
                "centroid",
            ],
        ),
        (
            "de",
            ("fields", "weighted_by_intersecting_area", "description"),
            [
                "Anteil",
                "Anzahl",
                "Minimum und Maximum",
                "Standardabweichung",
                "H3-Gitter",
                "Zentroid",
            ],
        ),
        (
            "en",
            ("fields", "statistic_result_name", "description"),
            ["{field}_{operation}", "count"],
        ),
        (
            "de",
            ("fields", "statistic_result_name", "description"),
            ["{field}_{operation}", "count"],
        ),
        (
            "en",
            ("fields", "statistic_result_name_operation_first", "description"),
            ["{operation}_{field}", "count"],
        ),
        (
            "de",
            ("fields", "statistic_result_name_operation_first", "description"),
            ["{operation}_{field}", "count"],
        ),
    ],
)
def test_the_text_names_the_output_meaning(language, path, words) -> None:
    node = _texts(language)
    for key in path:
        node = node[key]
    for word in words:
        assert word in node, (language, path, word)
    assert "—" not in node and "–" not in node


def test_the_weighting_text_is_one_text_in_english() -> None:
    """The schema descriptions repeat the English field text word for word."""
    from goatlib.analysis.schemas.aggregate import AggregatePolygonParams
    from goatlib.tools.aggregate_polygon import AggregatePolygonToolParams

    text = _texts("en")["fields"]["weighted_by_intersecting_area"]["description"]
    for params in (AggregatePolygonParams, AggregatePolygonToolParams):
        field = params.model_fields["weighted_by_intersecting_area"]
        assert field.description == text, params.__name__


def test_the_operation_first_result_name_text_is_one_text_in_english() -> None:
    """The schema description of an `{operation}_{field}` result name repeats
    the English field text word for word."""
    from goatlib.analysis.schemas.base import OPERATION_FIRST_RESULT_NAME

    key = "statistic_result_name_operation_first"
    assert _texts("en")["fields"][key]["description"] == OPERATION_FIRST_RESULT_NAME
