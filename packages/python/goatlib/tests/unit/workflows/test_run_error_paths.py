"""Local paths in a failed step's message.

A step's error text can carry a path on the worker: DuckDB names the file an
IO error is about, and a temp result lives under the user's and the
workflow's ids. The message people see shows `<path>` instead; addresses
that are not local paths, and text that only looks like one, stay.
"""

import pytest
from goatlib.workflows.run_errors import error_message

TEMP_RESULT = (
    "/app/data/temporary/user_00000000000000000000000000000001"
    "/w_6eef6701416b4a11a33f8bbfc9d6aeda/n_ring/t_494007e3fa2846e5.parquet"
)


@pytest.mark.parametrize(
    ("raw", "shown"),
    [
        (
            f'IO Error: No files found that match the pattern "{TEMP_RESULT}"',
            'IO Error: No files found that match the pattern "<path>"',
        ),
        (
            "IO Error: Cannot open file '/tmp/layer_go1u9q4h.parquet': "
            "No such file or directory",
            "IO Error: Cannot open file '<path>': No such file or directory",
        ),
        (
            "No temp parquet found under /tmp/pytest-of-p4b/pytest-737/"
            "test_x0/temporary/user_1/w_2/n_ring.",
            "No temp parquet found under <path>.",
        ),
        (
            "Invalid Input Error: /data/ducklake/user_1/t_2.parquet is "
            "not a parquet file",
            "Invalid Input Error: <path> is not a parquet file",
        ),
        (
            "IO Error: Cannot open file:///tmp/layer_go1u9q4h.parquet",
            "IO Error: Cannot open <path>",
        ),
    ],
)
def test_a_local_path_is_not_shown(raw: str, shown: str) -> None:
    assert error_message({"message": raw}) == shown
    assert error_message(RuntimeError(raw)) == shown


@pytest.mark.parametrize(
    "kept",
    [
        "HTTP 404 for https://tiles.example.org/data/layer/1.pmtiles",
        "Could not read s3://goat-data/users/1/layer.parquet",
        'Binder Error: column "km/h" not found',
        'Parser Error: syntax error at or near "/" in SELECT a/b/c FROM input_1',
        "The dates 2026/10/21 and 2026/10/22 overlap",
        "Conversion Error: SELECT x /2/3 FROM input_1",
        "Binder Error: SELECT total /pop/area FROM input_1",
        "Parser Error: WHERE name LIKE '%/foo/bar%'",
        "GET /api/v2/layers/3fa85f64/features failed with 502",
        "The input layer has no geometry column.",
    ],
)
def test_text_that_is_not_a_local_path_stays(kept: str) -> None:
    assert error_message({"message": kept}) == kept
