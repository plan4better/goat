"""The core pack (spec §7.2): who am I, the page context, find by name,
find layers inside projects."""

from uuid import UUID

import httpx
import pytest
from pydantic_ai.exceptions import ToolFailed

from assistant.context import parse_context
from assistant.login import StaticLogin
from assistant.surfaces import SURFACES
from assistant.tools.core import FIND, FIND_LAYERS, PAGE_CONTEXT, SHOW_ITEMS, WHOAMI
from assistant.tools.http import SIGN_IN_EXPIRED
from assistant.tools.runtime import InputInvalid, execute
from assistant.tools.testing import Recorder, fake_clients, signed_in, tool_env

PROJECT = UUID(int=500)


async def test_whoami_names_the_user_their_organization_and_the_policy() -> None:
    core = Recorder(
        {
            ("GET", "/api/v2/users/profile"): {
                "id": str(UUID(int=1)),
                "firstname": "Ada",
                "lastname": "Lovelace",
                "email": "ada@example.org",
            },
            ("GET", "/api/v2/users/organization"): {
                "id": str(UUID(int=100)),
                "name": "Stadt Beispiel",
            },
        }
    )
    env = tool_env(fake_clients(core=core), data_policy="restricted", locale="de")
    assert await execute(WHOAMI, env, {}) == {
        "name": "Ada Lovelace",
        "organization": "Stadt Beispiel",
        "data_policy": "restricted",
        "language": "de",
        "page": "home, content or settings (no project or catalog page open)",
    }


async def test_whoami_without_an_organization() -> None:
    core = Recorder(
        {
            ("GET", "/api/v2/users/profile"): {"firstname": "Ada", "lastname": None},
            ("GET", "/api/v2/users/organization"): httpx.Response(
                404, json={"detail": "User not found"}
            ),
        }
    )
    result = await execute(WHOAMI, tool_env(fake_clients(core=core)), {})
    assert result["name"] == "Ada" and "organization" not in result


async def test_page_context_returns_what_the_page_sent() -> None:
    page = parse_context(
        {
            "surface": "project.map",
            "project_id": str(PROJECT),
            "selected_layer_project_id": 3,
        }
    )
    result = await execute(PAGE_CONTEXT, tool_env(fake_clients(), page=page), {})
    assert result == {
        "surface": "project.map",
        "label": "a project, Map mode",
        "context": {
            "surface": "project.map",
            "project_id": str(PROJECT),
            "selected_layer_project_id": 3,
        },
    }


CONTENT_SEARCH = "/api/v2/content/search"

#: Content search hits by the types asked for, as core returns them.
HITS: dict[str, list[dict[str, object]]] = {
    "project": [
        {
            "type": "project",
            "id": str(PROJECT),
            "name": "Tool 3",
            "description": "d" * 400,
            "updated_at": "2026-10-09T00:00:00Z",
            "my_role": "viewer",
            "created_by": {"id": str(UUID(int=2)), "name": "Anna Schmidt"},
            "space_kind": "personal",
            "space_name": "Anna Schmidt",
            "folder_path": ["Schulung", "Tag 1"],
            "matched_on": ["folder"],
        }
    ],
    "layer,bundle": [
        {
            "type": "layer",
            "id": str(UUID(int=7)),
            "name": "Schulung Radwege",
            "layer_type": "feature",
            "geometry_type": "line",
            "my_role": "owner",
            "created_by": {"id": str(UUID(int=1)), "name": "Ada Lovelace"},
            "space_kind": "organization",
            "space_name": "Plan4Better",
            "folder_path": [],
            "matched_on": ["name"],
            "updated_at": "2026-10-01T00:00:00Z",
        },
        {
            "type": "bundle",
            "id": str(UUID(int=9)),
            "name": "Schulung GTFS",
            "bundle_type": "gtfs",
            "my_role": "viewer",
            "created_by": {"id": str(UUID(int=4)), "name": "Tom Schulung"},
            "space_kind": "team",
            "space_name": "Verkehr",
            "folder_path": [],
            "matched_on": ["name", "owner"],
            "updated_at": "2026-10-01T00:00:00Z",
        },
    ],
    "workflow": [
        {
            "type": "workflow",
            "id": str(UUID(int=20)),
            "name": "Huff-Modell",
            "project_id": str(PROJECT),
            "project_name": "Tool 3",
            "my_role": "viewer",
            "space_kind": "personal",
            "space_name": "Anna Schmidt",
            "folder_path": ["Schulung", "Tag 1"],
            "matched_on": ["folder"],
            "updated_at": "2026-10-09T00:00:00Z",
        },
        {
            "type": "workflow",
            "id": str(UUID(int=21)),
            "name": "Erreichbarkeit",
            "project_id": str(UUID(int=501)),
            "project_name": "Schulung Tool 4",
            "my_role": "viewer",
            "space_kind": "personal",
            "space_name": "Anna Schmidt",
            "folder_path": [],
            "matched_on": ["project"],
            "updated_at": "2026-10-09T00:00:00Z",
        },
    ],
    "layout": [],
}


def _content_search(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json={"items": HITS[request.url.params["types"]]})


TEMPLATES = {
    "items": [
        {
            "id": str(UUID(int=30)),
            "name": "Schulung Huff",
            "description": None,
            "payload_kind": "workflow",
            "catalog_status": "published",
            "created_by": {"id": str(UUID(int=3)), "name": "GOAT"},
        }
    ]
}


async def test_find_searches_everything_the_user_can_open() -> None:
    core = Recorder(
        {
            ("GET", CONTENT_SEARCH): _content_search,
            ("GET", "/api/v2/template"): TEMPLATES,
        }
    )
    result = await execute(
        FIND, tool_env(fake_clients(core=core)), {"query": "Schulung", "limit": 5}
    )
    [project] = result["projects"]
    assert len(project.pop("description")) == 201
    # Found by its folder: the colleague who owns it is not named.
    assert project == {
        "id": str(PROJECT),
        "name": "Tool 3",
        "space": "personal",
        "folder": "Schulung / Tag 1",
        "matched_on": ["folder"],
        "updated_at": "2026-10-09T00:00:00Z",
    }
    # A layer reports its layer type, a bundle is one dataset with its kind.
    assert [
        (d["name"], d.get("type"), d.get("bundle_type"), d["space"])
        for d in result["datasets"]
    ] == [
        ("Schulung Radwege", "feature", None, "organization Plan4Better"),
        ("Schulung GTFS", "bundle", "gtfs", "team Verkehr"),
    ]
    # The user's own say "you"; a name only where the search matched the owner.
    assert [d.get("owner") for d in result["datasets"]] == ["you", "Tom Schulung"]
    # Next to the projects, a workflow found only by its project's name is left out.
    assert [(w["name"], w["project_name"]) for w in result["workflows"]] == [
        ("Huff-Modell", "Tool 3")
    ]
    assert result["layouts"] == []
    assert result["templates"] == [
        {
            "id": str(UUID(int=30)),
            "name": "Schulung Huff",
            "kind": "workflow",
            "published": True,
        }
    ]
    searches = [r for r in core.requests if r.url.path == CONTENT_SEARCH]
    assert sorted(r.url.params["types"] for r in searches) == [
        "layer,bundle",
        "layout",
        "project",
        "workflow",
    ]
    assert {
        (r.url.params["search"], r.url.params["size"], r.url.params["page"])
        for r in searches
    } == {("Schulung", "5", "1")}
    template = next(r for r in core.requests if r.url.path == "/api/v2/template")
    assert dict(template.url.params) == {
        "search": "Schulung",
        "source": "all",
        "size": "5",
        "page": "1",
    }


async def test_find_one_kind_asks_only_for_that_kind() -> None:
    core = Recorder(
        {
            ("GET", CONTENT_SEARCH): _content_search,
            ("GET", "/api/v2/template"): {"items": []},
        }
    )
    result = await execute(
        FIND,
        tool_env(fake_clients(core=core)),
        {"query": "Schulung", "kind": "workflow"},
    )
    # Asked for workflows, the ones found by their project's name stay.
    assert [w["name"] for w in result["workflows"]] == ["Huff-Modell", "Erreichbarkeit"]
    assert result["workflows"][1]["matched_on"] == ["project"]
    assert result["projects"] == [] and result["datasets"] == []
    assert [
        r.url.params.get("types") for r in core.requests if r.url.path == CONTENT_SEARCH
    ] == ["workflow"]
    template = next(r for r in core.requests if r.url.path == "/api/v2/template")
    assert template.url.params["kind"] == "workflow"


async def test_find_datasets_skips_the_templates() -> None:
    core = Recorder({("GET", CONTENT_SEARCH): _content_search})
    result = await execute(
        FIND, tool_env(fake_clients(core=core)), {"query": "rad", "kind": "dataset"}
    )
    assert len(result["datasets"]) == 2 and result["templates"] == []
    assert core.paths() == [CONTENT_SEARCH]


SEARCH = "/api/v2/project/layers/search"


async def test_find_layers_searches_layers_inside_projects() -> None:
    core = Recorder(
        {
            ("GET", SEARCH): {
                "items": [
                    {
                        "project_id": str(PROJECT),
                        "project_name": "Radverkehr Berlin",
                        "project_updated_at": "2026-09-01T00:00:00Z",
                        "layer_project_id": 11,
                        "layer_name": "Radwege",
                        "dataset_name": "Radwege",
                        "layer_type": "feature",
                        "geometry_type": "line",
                    },
                    {
                        "project_id": str(UUID(int=501)),
                        "project_name": "Mobilität Potsdam",
                        "layer_project_id": 40,
                        "layer_name": "Abstellanlagen",
                        "dataset_name": "Fahrradständer 2024",
                        "layer_type": "table",
                        "locked": False,
                    },
                    # Locked: core sends no dataset name (null or left out).
                    {
                        "project_id": str(UUID(int=501)),
                        "project_name": "Mobilität Potsdam",
                        "layer_project_id": 41,
                        "layer_name": "Interne Planung",
                        "dataset_name": None,
                        "layer_type": "feature",
                        "geometry_type": "polygon",
                        "locked": True,
                    },
                ],
                "total": 7,
                "page": 1,
                "size": 2,
            }
        }
    )
    env = tool_env(fake_clients(core=core), login=StaticLogin("user-token"))
    result = await execute(FIND_LAYERS, env, {"query": "rad", "limit": 2})
    assert result == {
        "layers": [
            {
                "project_id": str(PROJECT),
                "project_name": "Radverkehr Berlin",
                "layer_project_id": 11,
                # The dataset's name is left out when it is the layer's own.
                "name": "Radwege",
                "type": "feature",
                "geometry_type": "line",
                "project_updated_at": "2026-09-01T00:00:00Z",
            },
            {
                "project_id": str(UUID(int=501)),
                "project_name": "Mobilität Potsdam",
                "layer_project_id": 40,
                "name": "Abstellanlagen",
                "dataset_name": "Fahrradständer 2024",
                "type": "table",
            },
            {
                "project_id": str(UUID(int=501)),
                "project_name": "Mobilität Potsdam",
                "layer_project_id": 41,
                "name": "Interne Planung",
                "type": "feature",
                "geometry_type": "polygon",
                "locked": True,
            },
        ],
        "total": 7,
    }
    [request] = core.requests
    assert request.url.path == SEARCH
    assert dict(request.url.params) == {"search": "rad", "size": "2", "page": "1"}
    assert request.headers["Authorization"] == "Bearer user-token"


async def test_find_layers_is_offered_everywhere_and_returns_no_data_values() -> None:
    assert FIND_LAYERS.surfaces == frozenset(SURFACES)
    assert FIND_LAYERS.returns_data is False and FIND_LAYERS.mcp is False
    assert "core_find" in FIND_LAYERS.description
    assert "inside" in FIND_LAYERS.description


async def test_find_layers_checks_its_arguments_before_calling_core() -> None:
    core = Recorder({("GET", SEARCH): {"items": [], "total": 0}})
    env = tool_env(fake_clients(core=core))
    for args in (
        {"query": "r"},
        {"query": " r  "},
        {"query": "rad", "limit": 51},
        {"q": "rad"},
    ):
        with pytest.raises(InputInvalid):
            await execute(FIND_LAYERS, env, args)
    assert core.requests == []
    assert await execute(FIND_LAYERS, env, {"query": "rad"}) == {
        "layers": [],
        "total": 0,
    }
    assert core.requests[0].url.params["size"] == "20"
    await execute(FIND_LAYERS, env, {"query": "  rad "})
    assert core.requests[1].url.params["search"] == "rad"


async def test_find_layers_reports_a_core_error_as_a_failed_call() -> None:
    core = Recorder(
        {("GET", SEARCH): httpx.Response(401, json={"detail": "Unauthorized"})}
    )
    with pytest.raises(ToolFailed):
        await execute(FIND_LAYERS, tool_env(fake_clients(core=core)), {"query": "rad"})


# -- core.show_items -----------------------------------------------------------

OTHER = UUID(int=501)
DATASET = UUID(int=900)


def _items_core() -> Recorder:
    return Recorder(
        {
            ("GET", f"/api/v2/project/{PROJECT}"): {
                "id": str(PROJECT),
                "name": "Radverkehr Berlin",
            },
            ("GET", f"/api/v2/project/{PROJECT}/layer"): [
                {
                    "id": 11,
                    "layer_id": str(UUID(int=911)),
                    "name": "Radwege",
                    "type": "feature",
                    "feature_layer_geometry_type": "line",
                },
                {
                    "id": 12,
                    "name": "Interne Planung",
                    "type": "feature",
                    "locked": True,
                },
            ],
            ("GET", f"/api/v2/layer/{DATASET}"): {
                "id": str(DATASET),
                "name": "Fahrradständer 2024",
                "type": "table",
            },
            # Another organization's project: core answers 401 for no access too.
            ("GET", f"/api/v2/project/{OTHER}"): httpx.Response(
                401, json={"detail": "x"}
            ),
        }
    )


async def test_show_items_resolves_every_card_in_core_in_the_answers_order() -> None:
    core = _items_core()
    result = await execute(
        SHOW_ITEMS,
        # A valid sign-in: the 401 for the other project is no access.
        tool_env(fake_clients(core=core), login=signed_in(300)),
        {
            "groups": [
                {
                    "title": "Projekte",
                    "items": [
                        {
                            "kind": "project",
                            "id": str(PROJECT),
                            "note": "Radnetz und Abstellanlagen",
                        },
                        {"kind": "project", "id": str(OTHER)},
                    ],
                },
                {
                    "items": [
                        {
                            "kind": "layer",
                            "id": "11",
                            "project_id": str(PROJECT),
                            "note": "Radwege",
                        },
                        {"kind": "layer", "id": "12", "project_id": str(PROJECT)},
                        {"kind": "layer", "id": "99", "project_id": str(PROJECT)},
                        {"kind": "dataset", "id": str(DATASET)},
                    ]
                },
            ]
        },
    )
    assert result == {
        "groups": [
            {
                "title": "Projekte",
                "items": [
                    {
                        "kind": "project",
                        "id": str(PROJECT),
                        "name": "Radverkehr Berlin",
                        "note": "Radnetz und Abstellanlagen",
                    }
                ],
            },
            {
                "items": [
                    # The note only repeated the name: dropped.
                    {
                        "kind": "layer",
                        "id": "11",
                        "project_id": str(PROJECT),
                        "dataset_id": str(UUID(int=911)),
                        "name": "Radwege",
                        "project_name": "Radverkehr Berlin",
                        "detail": "feature · line",
                    },
                    {
                        "kind": "layer",
                        "id": "12",
                        "project_id": str(PROJECT),
                        "name": "Interne Planung",
                        "project_name": "Radverkehr Berlin",
                        "detail": "feature",
                        "locked": True,
                    },
                    {
                        "kind": "dataset",
                        "id": str(DATASET),
                        "dataset_id": str(DATASET),
                        "name": "Fahrradständer 2024",
                        "detail": "table",
                    },
                ]
            },
        ],
        "not_found": [f"project:{OTHER}", f"layer:{PROJECT}:99"],
        "left_out": [],
    }
    # The project is read once for its card and its layers.
    assert core.paths().count(f"/api/v2/project/{PROJECT}") == 1
    assert core.paths().count(f"/api/v2/project/{PROJECT}/layer") == 1


async def test_show_items_shows_the_first_ten_once_each() -> None:
    core = _items_core()
    project = {"kind": "project", "id": str(PROJECT)}
    layers = [
        {"kind": "layer", "id": str(n), "project_id": str(PROJECT)}
        for n in range(100, 111)
    ]
    result = await execute(
        SHOW_ITEMS,
        tool_env(fake_clients(core=core)),
        {
            "groups": [
                {"items": [project, project]},
                {"items": layers[:6]},
                {"items": layers[6:]},
            ]
        },
    )
    assert result["groups"][0]["items"][0]["id"] == str(PROJECT)
    # The duplicate is dropped; nine layers fit, the tenth and eleventh are left out.
    assert len(result["not_found"]) == 9
    assert result["left_out"] == [f"layer:{PROJECT}:109", f"layer:{PROJECT}:110"]


@pytest.mark.parametrize(
    "item",
    [
        {"kind": "layer", "id": "11"},
        {"kind": "layer", "id": "radwege", "project_id": str(PROJECT)},
        {"kind": "project", "id": "Radverkehr"},
        {"kind": "dataset", "id": str(DATASET), "project_id": str(PROJECT)},
        {"kind": "workflow", "id": str(PROJECT)},
    ],
)
async def test_show_items_checks_ids_before_calling_core(item: dict[str, str]) -> None:
    core = _items_core()
    with pytest.raises(InputInvalid):
        await execute(
            SHOW_ITEMS,
            tool_env(fake_clients(core=core)),
            {"groups": [{"items": [item]}]},
        )
    assert core.requests == []


@pytest.mark.parametrize(
    "login", [StaticLogin(None), signed_in(-60)], ids=["no token", "expired token"]
)
async def test_show_items_names_an_expired_sign_in(login: StaticLogin) -> None:
    """A 401 for an expired sign-in is not an item that was not found: the
    model must not say the item does not exist."""
    core = _items_core()
    core.routes[("GET", f"/api/v2/layer/{DATASET}")] = httpx.Response(
        401, json={"detail": "x"}
    )
    with pytest.raises(ToolFailed, match="sign-in expired") as caught:
        await execute(
            SHOW_ITEMS,
            tool_env(fake_clients(core=core), login=login),
            {"groups": [{"items": [{"kind": "dataset", "id": str(DATASET)}]}]},
        )
    assert caught.value.message == SIGN_IN_EXPIRED


async def test_show_items_takes_records_for_items() -> None:
    expected = {
        "groups": [
            {
                "items": [
                    {
                        "kind": "dataset",
                        "id": str(DATASET),
                        "dataset_id": str(DATASET),
                        "name": "Fahrradständer 2024",
                        "detail": "table",
                    }
                ]
            }
        ],
        "not_found": [],
        "left_out": [],
    }
    item = {"kind": "dataset", "id": str(DATASET)}
    for args in (
        {"groups": [{"records": [item]}]},
        # A bare list is one untitled group.
        {"items": [item]},
        {"records": [item]},
    ):
        result = await execute(
            SHOW_ITEMS, tool_env(fake_clients(core=_items_core())), args
        )
        assert result == expected, args
    # The schema still names the list ``items``.
    group = SHOW_ITEMS.json_schema()["$defs"]["ItemGroupInput"]["properties"]
    assert "items" in group and "records" not in group


async def test_show_items_group_title_uses_goats_terms_and_may_be_left_out() -> None:
    title = SHOW_ITEMS.json_schema()["$defs"]["ItemGroupInput"]["properties"]["title"]
    assert title["description"] == (
        "A short heading for the group in the user's language, with GOAT's terms "
        "(Layer, Workflow, Datensatz in German). Leave it out when the group's "
        "cards say it already."
    )


async def test_show_items_is_offered_everywhere_and_returns_no_data_values() -> None:
    assert SHOW_ITEMS.surfaces == frozenset(SURFACES)
    assert SHOW_ITEMS.returns_data is False and SHOW_ITEMS.mcp is False
    assert "catalog_show_records" in SHOW_ITEMS.description


async def test_show_items_shows_a_bundle_with_its_kind() -> None:
    bundle = UUID(int=950)
    core = Recorder(
        {
            ("GET", f"/api/v2/bundle/{bundle}"): {
                "id": str(bundle),
                "name": "MVV GTFS Fahrplan 2026",
                "bundle_type": "pt_network_gtfs",
            }
        }
    )
    result = await execute(
        SHOW_ITEMS,
        tool_env(fake_clients(core=core)),
        {
            "groups": [
                {"items": [{"kind": "bundle", "id": str(bundle), "note": "Fahrplan"}]}
            ]
        },
    )
    assert result["groups"][0]["items"] == [
        {
            "kind": "bundle",
            "id": str(bundle),
            "name": "MVV GTFS Fahrplan 2026",
            "detail": "pt_network_gtfs",
            "note": "Fahrplan",
        }
    ]
