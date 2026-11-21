"""Raster file styles get computed values like vector ones (spec 9.2, 9.4, 12): their
fingerprint is the file's address, a style computed from another one is stale, and a
read or a save asks processes, which reads the file."""

import copy
import hashlib
from typing import Any
from uuid import UUID, uuid4

import pytest
from core.core.config import settings
from core.db.models._link_model import LayerProjectLink
from core.db.models.layer import Layer
from core.db.models.layer_style import LayerStyle, LayerStyleRevision
from core.db.models.user import User
from core.services import style as style_service
from core.services.map_document import map_for_project
from core.services.style import check_style, read_stored, read_style, save_style
from sqlalchemy.ext.asyncio import AsyncSession
from tests.styles.conftest import StyleWorld

S = settings.SCHEMA
URL = "https://cdn.example/dem.tif"
FINGERPRINT = "url:" + hashlib.sha256(URL.encode()).hexdigest()[:16]
RAMP = {
    "version": "1.0.0",
    "kind": "raster",
    "render": {"type": "continuous", "palette": "goat:elevation"},
}


class Compute:
    """processes' style-check of a raster file: the band's range as the domain."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def __call__(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs)
        document = copy.deepcopy(kwargs["document"])
        if kwargs.get("compute"):
            document["render"]["computed"] = {
                "at": "2026-10-26T10:00:00Z",
                "data": kwargs["fingerprint"],
                "domain": [100, 400],
            }
        return {"document": document, "issues": []}


async def raster_style(
    db: AsyncSession, world: StyleWorld, document: dict[str, Any]
) -> tuple[UUID, UUID]:
    user = await db.get(User, world.user_id)
    assert user is not None
    layer = Layer(
        id=uuid4(),
        user_id=world.user_id,
        name="dem",
        type="raster",
        data_type="cog",
        url=URL,
    )
    db.add(layer)
    await db.flush()
    link = LayerProjectLink(
        project_id=world.project_id, layer_id=layer.id, name="dem", properties={}
    )
    db.add(link)
    await db.flush()
    style = LayerStyle(layer_project_id=link.id, name="Elevation", document=document)
    db.add(style)
    await db.flush()
    db.add(LayerStyleRevision(style_id=style.id, revision=1, document=document))
    await db.commit()
    assert style.id is not None
    return style.id, layer.id


@pytest.mark.asyncio
async def test_a_raster_files_fingerprint_is_its_address(
    db_session: AsyncSession, style_world: StyleWorld
) -> None:
    style_id, _ = await raster_style(db_session, style_world, RAMP)
    stored = await read_stored(db_session, style_id)
    assert stored.fingerprint == FINGERPRINT


@pytest.mark.asyncio
async def test_a_raster_style_without_its_domain_is_computed_on_read(
    db_session: AsyncSession, style_world: StyleWorld, monkeypatch: pytest.MonkeyPatch
) -> None:
    style_id, _ = await raster_style(db_session, style_world, RAMP)
    check = Compute()
    monkeypatch.setattr(style_service, "style_check", check)
    result = await read_style(
        db_session, await read_stored(db_session, style_id), access_token="t"
    )
    assert result.stale is False and result.revision == 2
    assert result.document["render"]["computed"]["domain"] == [100, 400]
    assert check.calls[0]["fingerprint"] == FINGERPRINT


@pytest.mark.asyncio
async def test_the_map_marks_a_raster_style_computed_from_another_file_stale(
    db_session: AsyncSession, style_world: StyleWorld
) -> None:
    computed = copy.deepcopy(RAMP)
    computed["render"]["computed"] = {
        "at": "t",
        "data": "url:0000000000000000",
        "domain": [1, 2],
    }
    _, layer_id = await raster_style(db_session, style_world, computed)
    answer = await map_for_project(
        db_session, project_id=style_world.project_id, user_id=style_world.user_id
    )
    [entry] = [s for s in answer.styles.values() if s.active.name == "Elevation"]
    assert entry.active.stale is True


@pytest.mark.asyncio
async def test_saving_a_raster_style_that_needs_the_band_asks_processes(
    db_session: AsyncSession, style_world: StyleWorld, monkeypatch: pytest.MonkeyPatch
) -> None:
    image = {"version": "1.0.0", "kind": "raster", "render": {"type": "image"}}
    style_id, _ = await raster_style(db_session, style_world, image)
    check = Compute()
    monkeypatch.setattr(style_service, "style_check", check)
    saved = await save_style(
        db_session,
        style_id=style_id,
        base_rev=1,
        document=RAMP,
        actor_id=style_world.user_id,
        access_token="t",
    )
    assert len(check.calls) == 1 and check.calls[0]["fingerprint"] == FINGERPRINT
    assert saved.document["render"]["computed"]["domain"] == [100, 400]


@pytest.mark.asyncio
async def test_a_save_or_check_with_a_direction_outside_maplibres_bounds_is_an_error(
    db_session: AsyncSession, style_world: StyleWorld, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A document being written is not brought inside the bounds: the value is an
    error the author (the AI too) sees, and the save keeps the stored value."""
    hillshade = {"version": "1.0.0", "kind": "raster", "render": {"type": "hillshade"}}
    style_id, _ = await raster_style(
        db_session,
        style_world,
        {**hillshade, "render": {**hillshade["render"], "direction": 300}},
    )
    check = Compute()
    monkeypatch.setattr(style_service, "style_check", check)
    turned = {**hillshade, "render": {**hillshade["render"], "direction": 360}}
    saved = await save_style(
        db_session,
        style_id=style_id,
        base_rev=1,
        document=turned,
        actor_id=style_world.user_id,
        access_token="t",
    )
    assert check.calls == []
    assert [(i["code"], i["path"], i["message"]) for i in saved.issues] == [
        (
            "invalid_value",
            "/render/direction",
            "360 is more than 359, the most this takes.",
        )
    ]
    assert (await read_stored(db_session, style_id)).document["render"][
        "direction"
    ] == 300

    stored = await read_stored(db_session, style_id)
    document, issues = await check_style(stored, turned, "t")
    assert document["render"]["direction"] == 360
    assert [(i.code, i.path) for i in issues] == [
        ("invalid_value", "/render/direction")
    ]


class FileCheck:
    """processes' style-check of a raster layer without a file row: it reads the
    style as a raster file's (`DataContext(kind="raster")`)."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def __call__(self, **kwargs: Any) -> dict[str, Any]:
        from goatlib.style.context import DataContext
        from goatlib.style.validate import validate

        self.calls.append(kwargs)
        issues = validate(kwargs["document"], DataContext(kind="raster"))
        return {
            "document": kwargs["document"],
            "issues": [i.model_dump(mode="json", exclude_none=True) for i in issues],
        }


def wms_style(document: dict[str, Any]) -> style_service.StoredStyle:
    return style_service.StoredStyle(
        id=uuid4(),
        name="Aerial photo",
        position=0,
        revision=1,
        document=document,
        layer_project_id=None,
        dataset_id=uuid4(),
        layer_type="raster",
        geometry=None,
        data_snapshot=None,
        catalog_version=None,
        data_type="wms",
        url="https://wms.example/service",
    )


FIELD_POPUP = {"blocks": [{"type": "field_list", "attributes": [{"field": "value"}]}]}


@pytest.mark.asyncio
async def test_a_map_service_style_is_checked_by_goatlib_never_as_a_file(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    check = FileCheck()
    monkeypatch.setattr(style_service, "style_check", check)
    image = {"version": "1.0.0", "kind": "raster", "render": {"type": "image"}}
    stored = wms_style(image)
    ramp = {**RAMP, "popup": FIELD_POPUP}
    _, issues = await check_style(stored, ramp, "t")
    found = {(i.code, i.path) for i in issues}
    assert ("render_not_for_source", "/render/type") in found
    assert ("render_not_for_source", "/popup/blocks") in found
    grey = {**image, "render": {"type": "image", "service_style": "grey"}}
    _, issues = await check_style(stored, {**grey, "popup": FIELD_POPUP}, "t")
    found = {(i.code, i.path) for i in issues}
    assert ("render_not_for_source", "/render/service_style") not in found
    assert ("render_not_for_source", "/popup/blocks") in found
    assert check.calls == []


@pytest.mark.asyncio
async def test_opening_a_map_service_style_checks_it_by_goatlib(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    check = FileCheck()
    monkeypatch.setattr(style_service, "style_check", check)
    grey = {
        "version": "1.0.0",
        "kind": "raster",
        "render": {"type": "image", "service_style": "grey"},
    }
    result = await read_style(db_session, wms_style(grey), access_token="t", check=True)
    assert result.issues == [] and result.stale is False
    assert result.document == grey
    assert check.calls == []
