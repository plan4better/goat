"""A project's workflows and print layouts: listed by name, shown as cards."""

from uuid import UUID

import pytest

from assistant.context import parse_context
from assistant.tools.core import SHOW_ITEMS
from assistant.tools.project import GET_LAYOUTS, GET_WORKFLOWS
from assistant.tools.runtime import InputInvalid, ToolEnv, execute
from assistant.tools.testing import Recorder, fake_clients, tool_env

PROJECT = UUID(int=500)
WORKFLOW = UUID(int=700)
LAYOUT = UUID(int=800)
BASE = f"/api/v2/project/{PROJECT}"


def _core() -> Recorder:
    return Recorder(
        {
            ("GET", BASE): {"id": str(PROJECT), "name": "Nahmobilität Allach"},
            ("GET", f"{BASE}/workflow"): [
                {
                    "id": str(WORKFLOW),
                    "name": "Einzugsgebiete Fahrrad",
                    "description": "d" * 400,
                    "is_default": True,
                    "updated_at": "2026-10-01T00:00:00Z",
                    "config": {
                        "nodes": [
                            {
                                "type": "dataset",
                                "data": {"layerName": "Mobilitätspunkte"},
                            },
                            {"type": "tool", "data": {"processId": "catchment_area"}},
                            {"type": "tool", "data": {"processId": "catchment_area"}},
                            {"type": "tool", "data": {"processId": "buffer"}},
                        ]
                    },
                }
            ],
            ("GET", f"{BASE}/report-layout"): [
                {
                    "id": str(LAYOUT),
                    "name": "Plan A3",
                    "config": {
                        "page": {"size": "A3", "orientation": "landscape"},
                        "elements": [
                            {"type": "map"},
                            {"type": "legend"},
                            {"type": "map"},
                        ],
                    },
                }
            ],
        }
    )


def _open_project_env(core: Recorder) -> ToolEnv:
    page = parse_context({"surface": "project.map", "project_id": str(PROJECT)})
    return tool_env(fake_clients(core=core), page=page)


async def test_workflows_name_their_tools_and_inputs_not_their_config() -> None:
    result = await execute(GET_WORKFLOWS, _open_project_env(_core()), {})
    assert result["project_name"] == "Nahmobilität Allach"
    [workflow] = result["workflows"]
    assert workflow["name"] == "Einzugsgebiete Fahrrad"
    assert workflow["tools"] == ["catchment_area", "buffer"]
    assert workflow["inputs"] == ["Mobilitätspunkte"]
    assert len(workflow["description"]) == 201
    assert "config" not in workflow


async def test_layouts_name_their_page_and_elements() -> None:
    result = await execute(GET_LAYOUTS, _open_project_env(_core()), {})
    assert result["layouts"] == [
        {
            "id": str(LAYOUT),
            "name": "Plan A3",
            "page": "A3 landscape",
            "elements": ["map", "legend"],
        }
    ]


async def test_another_projects_workflows_by_id_and_none_without_one() -> None:
    core = _core()
    result = await execute(
        GET_WORKFLOWS, tool_env(fake_clients(core=core)), {"project_id": str(PROJECT)}
    )
    assert result["workflows"][0]["id"] == str(WORKFLOW)
    with pytest.raises(InputInvalid):
        await execute(GET_LAYOUTS, tool_env(fake_clients(core=core)), {})


async def test_workflow_and_layout_cards_carry_their_project() -> None:
    result = await execute(
        SHOW_ITEMS,
        tool_env(fake_clients(core=_core())),
        {
            "groups": [
                {
                    "items": [
                        {
                            "kind": "workflow",
                            "id": str(WORKFLOW),
                            "project_id": str(PROJECT),
                        },
                        {
                            "kind": "layout",
                            "id": str(LAYOUT),
                            "project_id": str(PROJECT),
                        },
                        {
                            "kind": "layout",
                            "id": str(UUID(int=801)),
                            "project_id": str(PROJECT),
                        },
                    ]
                }
            ]
        },
    )
    assert result["groups"][0]["items"] == [
        {
            "kind": "workflow",
            "id": str(WORKFLOW),
            "project_id": str(PROJECT),
            "name": "Einzugsgebiete Fahrrad",
            "project_name": "Nahmobilität Allach",
        },
        {
            "kind": "layout",
            "id": str(LAYOUT),
            "project_id": str(PROJECT),
            "name": "Plan A3",
            "project_name": "Nahmobilität Allach",
        },
    ]
    assert result["not_found"] == [f"layout:{PROJECT}:{UUID(int=801)}"]


async def test_a_workflow_card_needs_its_project() -> None:
    with pytest.raises(InputInvalid):
        await execute(
            SHOW_ITEMS,
            tool_env(fake_clients(core=_core())),
            {"groups": [{"items": [{"kind": "workflow", "id": str(WORKFLOW)}]}]},
        )
