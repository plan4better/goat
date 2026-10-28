"""Saving a style (spec 13.1): merge onto the current document, check, one conditional write, at most three tries."""

import copy
from typing import Any
from uuid import UUID

import pytest
from core.core.config import settings
from core.db.models.layer_style import LayerStyle, LayerStyleRevision
from core.db.session import session_manager
from core.services import style as style_service
from core.services.processes import StyleCheckUnavailable
from core.services.style import StyleSaveError, save_style
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from tests.styles.conftest import StyleWorld

BASE = {"version": 1, "kind": "vector", "symbol": {"fill": {"color": "#111111"}}}
CLASSIFIED = {
    "version": 1,
    "kind": "vector",
    "symbol": {"fill": {"color": "#111111"}},
    "classify": [
        {"id": "density", "field": "density", "method": "quantile", "count": 4}
    ],
}


def with_fill(doc: dict[str, Any], color: str) -> dict[str, Any]:
    out = copy.deepcopy(doc)
    out["symbol"]["fill"]["color"] = color
    return out


async def named_style(
    db: AsyncSession, world: StyleWorld, document: dict[str, Any] = BASE
) -> UUID:
    style = LayerStyle(
        layer_project_id=world.layer_project_id, name="Style", document=document
    )
    db.add(style)
    await db.flush()
    db.add(LayerStyleRevision(style_id=style.id, revision=1, document=document))
    await db.commit()
    assert style.id is not None
    return style.id


async def stored(db: AsyncSession, style_id: UUID) -> tuple[int, dict[str, Any]]:
    row = (
        await db.execute(
            text(
                f"SELECT revision, document FROM {settings.SCHEMA}.layer_style WHERE id = :id"
            ),
            {"id": style_id},
        )
    ).one()
    return row.revision, row.document


class FakeCheck:
    """processes' style-check: echoes the document, optionally lets another writer in first."""

    def __init__(self, races: int = 0, fail: bool = False) -> None:
        self.calls = 0
        self.races = races
        self.fail = fail
        self.style_id: UUID | None = None

    async def __call__(self, *, document: dict[str, Any], **_: Any) -> dict[str, Any]:
        self.calls += 1
        if self.fail:
            raise StyleCheckUnavailable("down")
        if self.calls <= self.races and self.style_id is not None:
            async with session_manager.session() as other:
                await other.execute(
                    text(
                        f"UPDATE {settings.SCHEMA}.layer_style SET revision = revision + 1, "
                        "document = jsonb_set(document, '{symbol,outline}', '{\"width\": 5}') WHERE id = :id"
                    ),
                    {"id": self.style_id},
                )
                await other.commit()
        return {"document": document, "issues": [], "feature_count": 10, "fields": []}


@pytest.fixture
def fake(monkeypatch: pytest.MonkeyPatch) -> FakeCheck:
    check = FakeCheck()
    monkeypatch.setattr(style_service, "style_check", check)
    return check


async def save(
    db: AsyncSession, style_id: UUID, base_rev: int, document: dict[str, Any]
):
    return await save_style(
        db,
        style_id=style_id,
        base_rev=base_rev,
        document=document,
        actor_id=None,
        access_token="t",
    )


@pytest.mark.asyncio
async def test_a_save_on_the_current_revision_stores_the_document_and_bumps_the_revision(
    db_session: AsyncSession, style_world: StyleWorld, fake: FakeCheck
) -> None:
    style_id = await named_style(db_session, style_world)
    result = await save(db_session, style_id, 1, with_fill(BASE, "#222222"))
    assert result.revision == 2
    revision, document = await stored(db_session, style_id)
    assert (revision, document["symbol"]["fill"]["color"]) == (2, "#222222")
    assert fake.calls == 0


@pytest.mark.asyncio
async def test_an_equal_document_writes_nothing_and_answers_the_current_revision(
    db_session: AsyncSession, style_world: StyleWorld, fake: FakeCheck
) -> None:
    doc = copy.deepcopy(CLASSIFIED)
    doc["classify"][0]["computed"] = {
        "at": "2026-10-25T10:00:00Z",
        "data": "ducklake:3",
    }
    style_id = await named_style(db_session, style_world, doc)
    again = copy.deepcopy(doc)
    again["classify"][0]["computed"] = {
        "at": "2026-10-26T10:00:00Z",
        "data": "ducklake:3",
    }
    result = await save(db_session, style_id, 1, again)
    assert result.revision == 1
    assert (await stored(db_session, style_id))[0] == 1
    assert fake.calls == 0


@pytest.mark.asyncio
async def test_a_save_on_an_older_revision_merges(
    db_session: AsyncSession, style_world: StyleWorld, fake: FakeCheck
) -> None:
    style_id = await named_style(db_session, style_world)
    await save(db_session, style_id, 1, with_fill(BASE, "#222222"))
    await save(db_session, style_id, 2, with_fill(BASE, "#333333"))
    await save(db_session, style_id, 3, with_fill(BASE, "#444444"))
    other = with_fill(BASE, "#333333")
    other["symbol"]["outline"] = {"width": 2}
    result = await save(db_session, style_id, 3, other)
    assert result.revision == 5
    document = (await stored(db_session, style_id))[1]
    assert document["symbol"]["fill"]["color"] == "#444444"
    assert document["symbol"]["outline"] == {"width": 2}


@pytest.mark.asyncio
async def test_the_oldest_kept_revision_merges_and_an_older_one_is_base_too_old(
    db_session: AsyncSession, style_world: StyleWorld, fake: FakeCheck
) -> None:
    style_id = await named_style(db_session, style_world)
    for n in range(1, 22):
        await save(db_session, style_id, n, with_fill(BASE, f"#{n:06x}"))
    assert (await stored(db_session, style_id))[0] == 22
    kept = (
        await db_session.execute(
            select(func.count())
            .select_from(LayerStyleRevision)
            .where(LayerStyleRevision.style_id == style_id)
        )
    ).scalar_one()
    assert kept == 20
    with pytest.raises(StyleSaveError) as too_old:
        await save(db_session, style_id, 2, with_fill(BASE, "#abcdef"))
    assert (too_old.value.status, too_old.value.code) == (409, "base_too_old")
    merged = await save(
        db_session,
        style_id,
        3,
        {**BASE, "symbol": {**BASE["symbol"], "outline": {"width": 1}}},
    )
    assert merged.revision == 23


@pytest.mark.asyncio
async def test_a_race_is_retried_and_three_lost_races_answer_save_conflict(
    db_session: AsyncSession, style_world: StyleWorld, monkeypatch: pytest.MonkeyPatch
) -> None:
    style_id = await named_style(db_session, style_world, CLASSIFIED)
    once = FakeCheck(races=1)
    once.style_id = style_id
    monkeypatch.setattr(style_service, "style_check", once)
    result = await save(db_session, style_id, 1, with_fill(CLASSIFIED, "#222222"))
    document = (await stored(db_session, style_id))[1]
    assert result.revision == 3
    assert document["symbol"]["fill"]["color"] == "#222222"
    assert document["symbol"]["outline"] == {"width": 5}

    always = FakeCheck(races=99)
    always.style_id = style_id
    monkeypatch.setattr(style_service, "style_check", always)
    with pytest.raises(StyleSaveError) as conflict:
        await save(db_session, style_id, 3, with_fill(CLASSIFIED, "#333333"))
    assert (conflict.value.status, conflict.value.code) == (503, "save_conflict")
    assert (await stored(db_session, style_id))[1]["symbol"]["fill"][
        "color"
    ] == "#222222"


@pytest.mark.asyncio
async def test_processes_down_answers_check_unavailable_and_stores_nothing(
    db_session: AsyncSession, style_world: StyleWorld, monkeypatch: pytest.MonkeyPatch
) -> None:
    style_id = await named_style(db_session, style_world, CLASSIFIED)
    monkeypatch.setattr(style_service, "style_check", FakeCheck(fail=True))
    with pytest.raises(StyleSaveError) as down:
        await save(db_session, style_id, 1, with_fill(CLASSIFIED, "#222222"))
    assert (down.value.status, down.value.code) == (503, "check_unavailable")
    assert (await stored(db_session, style_id))[0] == 1


@pytest.mark.asyncio
async def test_a_merge_with_an_error_keeps_the_current_value_on_that_path(
    db_session: AsyncSession, style_world: StyleWorld, fake: FakeCheck
) -> None:
    style_id = await named_style(db_session, style_world)
    await save(db_session, style_id, 1, with_fill(BASE, "#222222"))
    broken = copy.deepcopy(BASE)
    broken["symbol"]["fill"]["opacity"] = 5
    broken["symbol"]["outline"] = {"width": 2}
    result = await save(db_session, style_id, 1, broken)
    document = (await stored(db_session, style_id))[1]
    assert "opacity" not in document["symbol"]["fill"]
    assert document["symbol"]["outline"] == {"width": 2}
    assert document["symbol"]["fill"]["color"] == "#222222"
    assert any(i["path"].startswith("/symbol/fill/opacity") for i in result.issues)


MANUAL = {
    "version": 1,
    "kind": "vector",
    "symbol": {"fill": {"color": "#111111"}},
    "classify": [
        {
            "id": "density",
            "field": "density",
            "method": "manual",
            "classes": [
                {"id": "low", "to": 10, "fill": {"color": "#eeeeee"}},
                {"id": "high", "from": 10, "fill": {"color": "#333333"}},
            ],
        }
    ],
}


@pytest.mark.asyncio
async def test_a_merge_that_makes_a_classification_invalid_keeps_the_current_value_there(
    db_session: AsyncSession, style_world: StyleWorld, monkeypatch: pytest.MonkeyPatch
) -> None:
    """One writer switches the field, the other (based on the old revision) edits a
    class: the check's error on the classification takes the class edit back."""
    style_id = await named_style(db_session, style_world, MANUAL)
    error = {
        "level": "error",
        "code": "classes_invalid",
        "path": "/classify/density",
        "message": "The classes do not fit the field.",
    }

    async def check(*, document: dict[str, Any], **_: Any) -> dict[str, Any]:
        classification = document["classify"][0]
        bad = (
            classification["field"] == "population"
            and classification["classes"][0]["fill"]["color"] == "#ff0000"
        )
        return {"document": document, "issues": [error] if bad else []}

    monkeypatch.setattr(style_service, "style_check", check)
    switched = copy.deepcopy(MANUAL)
    switched["classify"][0]["field"] = "population"
    await save(db_session, style_id, 1, switched)
    edited = copy.deepcopy(MANUAL)
    edited["classify"][0]["classes"][0]["fill"]["color"] = "#ff0000"
    edited["symbol"]["fill"]["color"] = "#222222"
    result = await save(db_session, style_id, 1, edited)
    document = (await stored(db_session, style_id))[1]
    assert document["classify"][0]["field"] == "population"
    assert document["classify"][0]["classes"][0]["fill"]["color"] == "#eeeeee"
    assert document["symbol"]["fill"]["color"] == "#222222"
    assert [i["code"] for i in result.issues] == ["classes_invalid"]


@pytest.mark.asyncio
async def test_a_dataset_default_is_replaced_whole(
    db_session: AsyncSession, style_world: StyleWorld, fake: FakeCheck
) -> None:
    style = LayerStyle(layer_id=style_world.layer_id, name="Default", document=BASE)
    db_session.add(style)
    await db_session.commit()
    assert style.id is not None
    result = await save(db_session, style.id, 99, with_fill(BASE, "#999999"))
    assert result.revision == 2
    assert (await stored(db_session, style.id))[1] == with_fill(BASE, "#999999")
    rows = (
        await db_session.execute(
            select(func.count())
            .select_from(LayerStyleRevision)
            .where(LayerStyleRevision.style_id == style.id)
        )
    ).scalar_one()
    assert rows == 0


@pytest.mark.asyncio
async def test_a_dataset_default_keeps_the_stored_value_where_a_change_has_an_error(
    db_session: AsyncSession, style_world: StyleWorld, fake: FakeCheck
) -> None:
    """The default is copied into every new project layer: it never stores errors."""
    style = LayerStyle(layer_id=style_world.layer_id, name="Default", document=BASE)
    db_session.add(style)
    await db_session.commit()
    assert style.id is not None
    bad = copy.deepcopy(BASE)
    bad["bogus"] = 1
    bad["symbol"]["fill"] = {"color": "#222222", "opacity": 5}
    result = await save(db_session, style.id, 1, bad)
    document = (await stored(db_session, style.id))[1]
    assert "bogus" not in document
    assert document["symbol"]["fill"] == {"color": "#222222"}
    assert {i["code"] for i in result.issues} >= {"unknown_key", "invalid_value"}


@pytest.mark.asyncio
async def test_a_check_processes_refuses_answers_check_failed_and_stores_nothing(
    db_session: AsyncSession, style_world: StyleWorld, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A refusal (the layer's data gone, a bad request) will not pass on a retry:
    the browser must not retry it forever."""
    from core.services.processes import StyleCheckRefused

    style_id = await named_style(db_session, style_world, CLASSIFIED)

    async def refused(**_: Any) -> dict[str, Any]:
        raise StyleCheckRefused(404, "style-check answered 404")

    monkeypatch.setattr(style_service, "style_check", refused)
    with pytest.raises(StyleSaveError) as error:
        await save(db_session, style_id, 1, with_fill(CLASSIFIED, "#222222"))
    assert (error.value.status, error.value.code) == (422, "check_failed")
    assert (await stored(db_session, style_id))[0] == 1
