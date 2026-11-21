"""Defaults shared by goatlib's tasks and tools, read from the env at call time."""

from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest


@pytest.mark.unit
@pytest.mark.parametrize(
    "module", ["goatlib.tasks.sync_windmill", "goatlib.tools.sync_windmill"]
)
def test_windmill_workspace_defaults_to_goat(
    monkeypatch: pytest.MonkeyPatch, module: str
) -> None:
    import importlib

    build_parser = importlib.import_module(module).build_parser
    monkeypatch.delenv("WINDMILL_WORKSPACE", raising=False)
    assert build_parser().parse_args([]).workspace == "goat"
    monkeypatch.setenv("WINDMILL_WORKSPACE", "other")
    assert build_parser().parse_args([]).workspace == "other"


@pytest.mark.unit
def test_print_base_url_default(monkeypatch: pytest.MonkeyPatch) -> None:
    from goatlib.config.print import DEFAULT_PRINT_BASE_URL, print_base_url

    monkeypatch.delenv("PRINT_BASE_URL", raising=False)
    assert print_base_url() == DEFAULT_PRINT_BASE_URL == "http://goat-web:3000"
    monkeypatch.setenv("PRINT_BASE_URL", "http://web:3000/")
    assert print_base_url() == "http://web:3000"


class _NavigatedError(Exception):
    pass


def _browser_recording(urls: list[str]) -> Any:
    async def goto(url: str, **_: Any) -> None:
        urls.append(url)
        raise _NavigatedError

    page = MagicMock()
    page.goto = goto
    context = MagicMock()
    context.new_page = AsyncMock(return_value=page)
    context.close = AsyncMock()
    browser = MagicMock()
    browser.new_context = AsyncMock(return_value=context)
    return browser


@pytest.mark.unit
async def test_both_print_report_urls_use_the_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from goatlib.config.print import DEFAULT_PRINT_BASE_URL
    from goatlib.tools.print_report import PrintReportParams, PrintReportRunner

    monkeypatch.delenv("PRINT_BASE_URL", raising=False)
    runner = PrintReportRunner()
    params = PrintReportParams(
        user_id="00000000-0000-0000-0000-000000000001",
        folder_id="00000000-0000-0000-0000-000000000002",
        project_id="00000000-0000-0000-0000-000000000003",
        layout_id="00000000-0000-0000-0000-000000000004",
    )
    report_url = runner._get_report_url(params)
    assert report_url.startswith(f"{DEFAULT_PRINT_BASE_URL}/print/")

    # The token is stored on the origin the report is then loaded from.
    urls: list[str] = []
    monkeypatch.setattr(
        runner, "_get_browser", AsyncMock(return_value=_browser_recording(urls))
    )
    with pytest.raises(_NavigatedError):
        await runner._render_page(report_url, "pdf", access_token="t")
    assert urls == [f"{DEFAULT_PRINT_BASE_URL}/print"]


@pytest.mark.unit
def test_base_data_source_is_read_from_the_env_at_call_time(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from goatlib.tasks import sync_base_data

    monkeypatch.delenv("GOAT_BASE_DATA_URL", raising=False)
    assert sync_base_data.SyncBaseDataParams().sources[0].url == (
        "https://goat-base-data.plan4better.de/"
    )
    monkeypatch.setenv("GOAT_BASE_DATA_URL", "https://mirror.example/base/")
    assert sync_base_data.default_source_url() == "https://mirror.example/base/"
    assert sync_base_data.SyncBaseDataParams().sources[0].url == (
        "https://mirror.example/base/"
    )


@pytest.mark.unit
def test_base_data_cli_mirrors_from_the_env_source(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from goatlib.tasks import sync_base_data

    monkeypatch.setenv("GOAT_BASE_DATA_URL", "https://mirror.example/base/")
    mirror = MagicMock()
    monkeypatch.setattr(sync_base_data, "mirror", mirror)
    assert sync_base_data._cli(["mirror", "--to", "/tmp/unused"]) == 0
    assert mirror.call_args.args[0] == "https://mirror.example/base/"


@pytest.mark.unit
def test_the_windmill_script_does_not_bake_in_the_base_data_source() -> None:
    # A default rendered into the generated script would be passed explicitly
    # on every run and hide GOAT_BASE_DATA_URL on the worker.
    from goatlib.tasks.registry import TASK_REGISTRY
    from goatlib.tasks.sync_windmill import generate_task_script

    task = next(t for t in TASK_REGISTRY if t.name == "sync_base_data")
    assert "goat-base-data.plan4better.de" not in generate_task_script(task)


@pytest.mark.unit
def test_upload_limit_default_is_shared(monkeypatch: pytest.MonkeyPatch) -> None:
    from goatlib.config.io import DEFAULT_MAX_UPLOAD_BYTES, IOSettings
    from goatlib.tools.base import ToolSettings

    monkeypatch.delenv("MAX_UPLOAD_DATASET_FILE_SIZE", raising=False)
    assert DEFAULT_MAX_UPLOAD_BYTES == 5 * 1024 * 1024 * 1024
    assert IOSettings().max_upload_dataset_file_size == DEFAULT_MAX_UPLOAD_BYTES
    assert ToolSettings.from_env().max_upload_dataset_file_size == (
        DEFAULT_MAX_UPLOAD_BYTES
    )


@pytest.mark.unit
def test_starting_point_marker_is_the_web_apps_own_icon() -> None:
    from goatlib.tools.style import starting_points_style

    marker = starting_points_style()["symbol"]["marker"]
    assert (marker["shape"], marker["icon"]) == ("icon", "goat:foundation-marker")


@pytest.mark.unit
def test_new_layer_thumbnail_default_is_root_relative() -> None:
    import inspect

    from goatlib.tools.db import ToolDatabaseService

    default = (
        inspect.signature(ToolDatabaseService.create_layer)
        .parameters["thumbnail_url"]
        .default
    )
    assert default == "/assets/img/goat_new_dataset_thumbnail.png"


@pytest.mark.unit
@pytest.mark.parametrize(
    "old_thumbnail_url",
    [
        "/assets/img/goat_new_dataset_thumbnail.png",
        "https://assets.plan4better.de/img/goat_new_dataset_thumbnail.png",
    ],
)
async def test_empty_table_layer_keeps_the_default_thumbnail(
    monkeypatch: pytest.MonkeyPatch, old_thumbnail_url: str
) -> None:
    from datetime import datetime, timezone
    from uuid import uuid4

    from goatlib.tasks.generate_thumbnails import (
        DEFAULT_TABLE_THUMBNAIL_URL,
        ItemToProcess,
        ThumbnailGeneratorTask,
    )

    assert DEFAULT_TABLE_THUMBNAIL_URL == "/assets/img/goat_new_dataset_thumbnail.png"
    task = ThumbnailGeneratorTask()
    update = AsyncMock()
    delete = MagicMock()
    monkeypatch.setattr(task, "_render_table_thumbnail", AsyncMock(return_value=None))
    monkeypatch.setattr(task, "_update_thumbnail_url", update)
    monkeypatch.setattr(task, "_delete_old_thumbnail", delete)
    item = ItemToProcess(
        type="layer",
        id=uuid4(),
        updated_at=datetime.now(timezone.utc),
        old_thumbnail_url=old_thumbnail_url,
        layer_type="table",
    )
    result = await task._process_table_item(item)
    assert result.thumbnail_url == DEFAULT_TABLE_THUMBNAIL_URL
    assert update.await_args.args[2] == DEFAULT_TABLE_THUMBNAIL_URL
    delete.assert_not_called()
