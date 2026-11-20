"""Styles inside workflow and report layout configs (an export's `outputStyle`, a
print layout's `locked_layer_styles`) are checked and stamped like a style save
(GOAT Style spec 14): a newer minor or major refuses the save with 422, anything
else is stored with the lowest version its keys need."""

from typing import Any

import pytest
from core.core.config import settings
from httpx import AsyncClient
from tests.authz.test_template_api import _create_project, _create_workflow
from tests.authz.test_workflow_shape_checks import _valid_config

API = settings.API_V2_STR
STYLE = {"version": "1.0.0", "kind": "vector", "symbol": {"fill": {"color": "#00aa00"}}}
V0 = {"color": [0, 170, 0]}


def _workflow(style: Any) -> dict[str, Any]:
    config = _valid_config()
    config["nodes"].append(
        {
            "id": "export-1",
            "type": "export",
            "position": {"x": 600, "y": 0},
            "data": {"type": "export", "label": "Save", "outputStyle": style},
        }
    )
    return config


def _output_style(config: dict[str, Any]) -> Any:
    [node] = [n for n in config["nodes"] if n["id"] == "export-1"]
    return node["data"]["outputStyle"]


def _layout(style: Any) -> dict[str, Any]:
    return {
        "elements": [{"type": "map", "config": {"locked_layer_styles": {"7": style}}}]
    }


def _locked_style(config: dict[str, Any]) -> Any:
    return config["elements"][0]["config"]["locked_layer_styles"]["7"]


#: Where the refused style sits in the request, so the client can tell which.
OUTPUT_STYLE = "/config/nodes/2/data/outputStyle/version"
LOCKED_STYLE = "/config/elements/0/config/locked_layer_styles/7/version"


def _assert_refused(response: Any, version: str, path: str) -> None:
    assert response.status_code == 422, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "newer_version"
    [issue] = detail["issues"]
    assert issue["code"] == "newer_version" and version in issue["message"]
    assert issue["path"] == path


@pytest.mark.asyncio
async def test_a_newer_output_style_refuses_the_workflow_save(
    client: AsyncClient, fixture_get_home_folder: dict[str, object]
) -> None:
    project_id = await _create_project(client, str(fixture_get_home_folder["id"]))
    url = f"{API}/project/{project_id}/workflow"
    created = await client.post(
        url, json={"name": "w", "config": _workflow({**STYLE, "version": "1.9.0"})}
    )
    _assert_refused(created, "1.9.0", OUTPUT_STYLE)
    assert (await client.get(url)).json() == []

    workflow_id = await _create_workflow(client, project_id, _workflow(STYLE))
    updated = await client.put(
        f"{url}/{workflow_id}",
        json={"config": _workflow({**STYLE, "version": "9.0.0"})},
    )
    _assert_refused(updated, "9.0.0", OUTPUT_STYLE)
    stored = (await client.get(f"{url}/{workflow_id}")).json()["config"]
    assert _output_style(stored) == STYLE


@pytest.mark.asyncio
async def test_output_styles_are_stored_with_the_lowest_version(
    client: AsyncClient, fixture_get_home_folder: dict[str, object]
) -> None:
    project_id = await _create_project(client, str(fixture_get_home_folder["id"]))
    url = f"{API}/project/{project_id}/workflow"
    created = await client.post(
        url, json={"name": "w", "config": _workflow({**STYLE, "version": "1.0.9"})}
    )
    assert created.status_code == 201, created.text
    assert _output_style(created.json()["config"]) == STYLE
    workflow_id = created.json()["id"]
    for sent, kept in (({**STYLE, "version": 1}, STYLE), (V0, V0)):
        updated = await client.put(
            f"{url}/{workflow_id}", json={"config": _workflow(sent)}
        )
        assert updated.status_code == 200, updated.text
        stored = (await client.get(f"{url}/{workflow_id}")).json()["config"]
        assert _output_style(stored) == kept


@pytest.mark.asyncio
async def test_a_report_layouts_locked_styles_are_checked_and_stamped(
    client: AsyncClient, fixture_get_home_folder: dict[str, object]
) -> None:
    project_id = await _create_project(client, str(fixture_get_home_folder["id"]))
    url = f"{API}/project/{project_id}/report-layout"
    refused = await client.post(
        url, json={"name": "r", "config": _layout({**STYLE, "version": "1.9.0"})}
    )
    _assert_refused(refused, "1.9.0", LOCKED_STYLE)

    created = await client.post(
        url, json={"name": "r", "config": _layout({**STYLE, "version": "1.0.9"})}
    )
    assert created.status_code == 201, created.text
    assert _locked_style(created.json()["config"]) == STYLE
    layout_id = created.json()["id"]
    updated = await client.put(
        f"{url}/{layout_id}",
        json={"config": _layout({**STYLE, "version": "2.0.0"})},
    )
    _assert_refused(updated, "2.0.0", LOCKED_STYLE)
    updated = await client.put(
        f"{url}/{layout_id}", json={"config": _layout({**STYLE, "version": 1})}
    )
    assert updated.status_code == 200, updated.text
    assert _locked_style(updated.json()["config"]) == STYLE
