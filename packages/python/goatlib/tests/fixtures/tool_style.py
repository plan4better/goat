"""From an analysis test's result to its tool's default style.

The analysis tests run the analysis classes; the default style comes from the
tool runner's `get_layer_style` and the runner's parameters. `tool_params`
gives the runner's parameters for the options the analysis ran with, and
`check_tool_style` asserts that the style the tool's run stores for the
result keeps the style contract (`goatlib.tools.style_contract`).
"""

from pathlib import Path
from typing import Any

import duckdb
from goatlib.tools.style_contract import Expectation, assert_tool_style
from pydantic import BaseModel

#: The user, folder and layer every bridged parameter set names.
U = "00000000-0000-0000-0000-000000000001"


def tool_params(
    params_class: type[BaseModel],
    analysis_params: BaseModel | None = None,
    **fields: Any,
) -> Any:
    """`params_class`, a tool's parameters, with the options of
    `analysis_params` (the analysis's parameters the test ran with) except
    their file paths, a user and a folder, and `fields`: the layer ids and
    what else the tool names differently."""
    options = (
        {}
        if analysis_params is None
        else {
            key: value
            for key, value in analysis_params.model_dump().items()
            if "path" not in key
        }
    )
    return params_class(**{"user_id": U, "folder_id": U, **options, **fields})


def check_tool_style(
    runner_class: type,
    params: Any,
    result: str | Path,
    geometry: str | None = None,
    *,
    document: dict[str, Any] | None = None,
    expect: Expectation | None = None,
) -> dict[str, Any]:
    """Asserts that the default style the tool's run stores for `result`, a
    parquet file the analysis wrote, keeps the style contract, and returns
    it: `get_layer_style`, or `document` for a second layer. The geometry is
    read from the rows unless given."""
    con = duckdb.connect()
    try:
        con.execute("INSTALL spatial; LOAD spatial;")
        runner = runner_class()
        return assert_tool_style(
            runner,
            params,
            f"read_parquet('{result}')",
            geometry,
            con=con,
            document=document,
            expect=expect,
        )
    finally:
        con.close()
