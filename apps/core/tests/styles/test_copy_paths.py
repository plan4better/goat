"""core's copy paths carry style rows and map state (spec 10)."""

from typing import Any
from uuid import UUID

import pytest
from core.core.config import settings
from core.crud.crud_template import template as crud_template
from core.db.models._link_model import LayerProjectGroup
from core.db.models.layer_style import LayerStyle
from core.services.style import add_first_styles, insert_dataset_default
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from tests.styles.conftest import StyleWorld

API = settings.API_V2_STR
S = settings.SCHEMA
GREEN = {"version": 1, "kind": "vector", "symbol": {"fill": {"color": "#00aa00"}}}


@pytest.fixture(autouse=True)
def tracker_reads_the_scratch_lake(lake: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "DUCKLAKE_CATALOG_SCHEMA", lake)


async def styled(db: AsyncSession, world: StyleWorld) -> UUID:
    """The world's layer with two named styles, the second active, in a closed and
    hidden group, with map state set."""
    await insert_dataset_default(db, world.layer_id, GREEN)
    await add_first_styles(db, [world.layer_project_id])
    second = LayerStyle(
        layer_project_id=world.layer_project_id,
        name="Density",
        position=1,
        document={**GREEN, "opacity": 0.5},
    )
    group = LayerProjectGroup(
        name="G", project_id=world.project_id, visible=False, expanded=False
    )
    db.add_all([second, group])
    await db.commit()
    await db.execute(
        text(
            f"UPDATE {S}.layer_project SET active_style_id = :s, visible = false, "
            "position = 'below_labels', legend_expanded = false, layer_project_group_id = :g "
            "WHERE id = :lp"
        ),
        {"s": second.id, "g": group.id, "lp": world.layer_project_id},
    )
    await db.commit()
    assert second.id is not None
    return second.id


@pytest.mark.asyncio
async def test_a_project_copy_carries_map_state_and_every_named_style(
    client: AsyncClient, db_session: AsyncSession, api_style_world: StyleWorld
) -> None:
    world = api_style_world
    second = await styled(db_session, world)
    copied = await client.post(f"{API}/project/{world.project_id}/copy", json={})
    assert copied.status_code in (200, 201), copied.text
    body = (await client.get(f"{API}/project/{copied.json()['id']}/map")).json()
    [group] = body["map"]["layers"]
    assert (group["visible"], group.get("expanded")) == (False, False)
    [entry] = group["children"]
    assert (entry["visible"], entry["position"], entry["legend"]) == (
        False,
        "below_labels",
        {"expanded": False},
    )
    styles = body["styles"][str(entry["id"])]
    assert (styles["active"]["name"], styles["active"]["document"]["opacity"]) == (
        "Density",
        0.5,
    )
    assert [o["name"] for o in styles["others"]] == ["Default"]
    assert styles["active"]["id"] != str(second)


@pytest.mark.asyncio
async def test_output_style_comes_from_the_export_results_active_style(
    db_session: AsyncSession, style_world: StyleWorld
) -> None:
    world = style_world
    await styled(db_session, world)
    workflow_id = "6b1c9f2e-0000-4000-8000-000000000001"
    await db_session.execute(
        text(
            f"UPDATE {S}.layer_project SET other_properties = CAST(:o AS jsonb) WHERE id = :lp"
        ),
        {
            "o": '{"workflow_export": {"workflow_id": "%s", "export_node_id": "n1"}}'
            % workflow_id,
            "lp": world.layer_project_id,
        },
    )
    await db_session.commit()
    styles: dict[str, Any] = await crud_template._export_styles(
        db_session, world.project_id, UUID(workflow_id)
    )
    assert styles == {"n1": {**GREEN, "opacity": 0.5}}
