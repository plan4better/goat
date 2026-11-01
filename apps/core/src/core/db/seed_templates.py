"""Idempotent seed for the GOAT catalog's five layout starters (T11b).

Ports the layout configs `apps/web/components/modals/ReportTemplatePicker.tsx`
builds client-side into frozen dicts (English strings resolved, no
`layer_project_id` bindings) and publishes them as `Template` rows owned by
the space of `GOAT_TEMPLATES_ORGANIZATION_ID`. Without a configured
organization they go to the default user's personal space when AUTH is off,
and to the space of the system organization (`GOAT_SYSTEM_ORGANIZATION_ID`)
when AUTH is on.
"""

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from core.core.config import GOAT_SYSTEM_ORGANIZATION_ID, WEB_ARTWORK_PATH, settings
from core.crud.crud_organization import SELF_HOSTED_QUOTAS
from core.crud.crud_space import space as crud_space
from core.db.models.organization import Organization
from core.db.models.template import Template, TemplateCatalogStatus, TemplatePayloadKind
from core.db.session import session_manager
from core.templates.snapshot import strip_layout_bindings

logger = logging.getLogger(__name__)

_VIEW_STATE = {
    "latitude": 48.13,
    "longitude": 11.57,
    "zoom": 10,
    "bearing": 0,
    "pitch": 0,
}

_PAGE_A4_PORTRAIT = {
    "size": "A4",
    "orientation": "portrait",
    "margins": {"top": 10, "right": 10, "bottom": 10, "left": 10},
    "snapToGuides": True,
    "showRulers": False,
}
_PAGE_A4_LANDSCAPE = {
    "size": "A4",
    "orientation": "landscape",
    "margins": {"top": 10, "right": 10, "bottom": 10, "left": 10},
    "snapToGuides": True,
    "showRulers": False,
}
_PAGE_A3_PORTRAIT = {
    "size": "A3",
    "orientation": "portrait",
    "margins": {"top": 10, "right": 10, "bottom": 10, "left": 10},
    "snapToGuides": True,
    "showRulers": False,
}
_PAGE_A3_LANDSCAPE = {
    "size": "A3",
    "orientation": "landscape",
    "margins": {"top": 10, "right": 10, "bottom": 10, "left": 10},
    "snapToGuides": True,
    "showRulers": False,
}
_GRID_LAYOUT = {"type": "grid", "columns": 12, "rows": 12, "gap": 5}
# The GOAT logo the web app ships, stored root-relative so the layout shows it
# on any host (and the print worker, which loads the web app, renders it too).
_LOGO_URL = f"{WEB_ARTWORK_PATH}/svg/goat-logo.svg"


def _blank_config() -> dict[str, Any]:
    return {
        "page": _PAGE_A4_PORTRAIT,
        "layout": _GRID_LAYOUT,
        "elements": [],
    }


def _single_map_portrait_config() -> dict[str, Any]:
    return {
        "page": _PAGE_A4_PORTRAIT,
        "layout": _GRID_LAYOUT,
        "elements": [
            {
                "id": "text-title",
                "type": "text",
                "position": {
                    "x": 10,
                    "y": 10,
                    "width": 190,
                    "height": 15,
                    "z_index": 2,
                },
                "config": {
                    "type": "text",
                    "setup": {
                        "text": '<p style="text-align: center"><strong><span style="font-size: 24pt">TITLE</span></strong></p>'
                    },
                },
                "style": {"padding": 0, "opacity": 1},
            },
            {
                "id": "map-1",
                "type": "map",
                "position": {
                    "x": 10,
                    "y": 28,
                    "width": 190,
                    "height": 210,
                    "z_index": 1,
                },
                "config": {"viewState": _VIEW_STATE},
                "style": {
                    "padding": 0,
                    "opacity": 1,
                    "border": {"enabled": True, "color": "#cccccc", "width": 0.5},
                },
            },
            {
                "id": "text-desc",
                "type": "text",
                "position": {
                    "x": 10,
                    "y": 242,
                    "width": 50,
                    "height": 45,
                    "z_index": 3,
                },
                "config": {
                    "type": "text",
                    "setup": {
                        "text": '<p><span style="font-size: 12pt">Description</span></p>'
                    },
                },
                "style": {"padding": 0, "opacity": 1},
            },
            {
                "id": "legend-1",
                "type": "legend",
                "position": {
                    "x": 65,
                    "y": 242,
                    "width": 80,
                    "height": 45,
                    "z_index": 4,
                },
                "config": {"title": {"text": "Legend"}, "mapElementId": "map-1"},
                "style": {
                    "padding": 0,
                    "opacity": 1,
                    "background": {"enabled": True, "color": "#ffffff", "opacity": 0.9},
                },
            },
            {
                "id": "image-logo",
                "type": "image",
                "position": {
                    "x": 150,
                    "y": 242,
                    "width": 50,
                    "height": 45,
                    "z_index": 5,
                },
                "config": {"url": _LOGO_URL},
                "style": {"padding": 0, "opacity": 1},
            },
        ],
    }


def _single_map_landscape_config() -> dict[str, Any]:
    return {
        "page": _PAGE_A4_LANDSCAPE,
        "layout": _GRID_LAYOUT,
        "elements": [
            {
                "id": "text-title",
                "type": "text",
                "position": {
                    "x": 10,
                    "y": 10,
                    "width": 277,
                    "height": 15,
                    "z_index": 2,
                },
                "config": {
                    "type": "text",
                    "setup": {
                        "text": '<p style="text-align: center"><strong><span style="font-size: 24pt">TITLE</span></strong></p>'
                    },
                },
                "style": {"padding": 0, "opacity": 1},
            },
            {
                "id": "map-1",
                "type": "map",
                "position": {
                    "x": 10,
                    "y": 28,
                    "width": 220,
                    "height": 162,
                    "z_index": 1,
                },
                "config": {"viewState": _VIEW_STATE},
                "style": {
                    "padding": 0,
                    "opacity": 1,
                    "border": {"enabled": True, "color": "#cccccc", "width": 0.5},
                },
            },
            {
                "id": "text-desc",
                "type": "text",
                "position": {
                    "x": 235,
                    "y": 28,
                    "width": 52,
                    "height": 40,
                    "z_index": 3,
                },
                "config": {
                    "type": "text",
                    "setup": {
                        "text": '<p><span style="font-size: 12pt">Description</span></p>'
                    },
                },
                "style": {"padding": 0, "opacity": 1},
            },
            {
                "id": "legend-1",
                "type": "legend",
                "position": {
                    "x": 235,
                    "y": 73,
                    "width": 52,
                    "height": 80,
                    "z_index": 4,
                },
                "config": {"title": {"text": "Legend"}, "mapElementId": "map-1"},
                "style": {
                    "padding": 0,
                    "opacity": 1,
                    "background": {"enabled": True, "color": "#ffffff", "opacity": 0.9},
                },
            },
            {
                "id": "image-logo",
                "type": "image",
                "position": {
                    "x": 235,
                    "y": 158,
                    "width": 52,
                    "height": 32,
                    "z_index": 5,
                },
                "config": {"url": _LOGO_URL},
                "style": {"padding": 0, "opacity": 1},
            },
        ],
    }


def _poster_portrait_config() -> dict[str, Any]:
    return {
        "page": _PAGE_A3_PORTRAIT,
        "layout": _GRID_LAYOUT,
        "elements": [
            {
                "id": "text-title",
                "type": "text",
                "position": {
                    "x": 10,
                    "y": 10,
                    "width": 200,
                    "height": 20,
                    "z_index": 2,
                },
                "config": {
                    "type": "text",
                    "setup": {
                        "text": '<p style="text-align: left"><strong><span style="font-size: 28pt">Poster Title</span></strong></p>'
                    },
                },
                "style": {"padding": 0, "opacity": 1},
            },
            {
                "id": "text-subtitle",
                "type": "text",
                "position": {
                    "x": 10,
                    "y": 33,
                    "width": 200,
                    "height": 25,
                    "z_index": 3,
                },
                "config": {
                    "type": "text",
                    "setup": {
                        "text": '<p><span style="font-size: 14pt">Subtitle or description</span></p>'
                    },
                },
                "style": {"padding": 0, "opacity": 1},
            },
            {
                "id": "image-logo",
                "type": "image",
                "position": {
                    "x": 227,
                    "y": 10,
                    "width": 60,
                    "height": 48,
                    "z_index": 7,
                },
                "config": {"url": _LOGO_URL},
                "style": {"padding": 0, "opacity": 1},
            },
            {
                "id": "map-1",
                "type": "map",
                "position": {
                    "x": 10,
                    "y": 63,
                    "width": 277,
                    "height": 337,
                    "z_index": 1,
                },
                "config": {"viewState": _VIEW_STATE},
                "style": {
                    "padding": 0,
                    "opacity": 1,
                    "border": {"enabled": True, "color": "#cccccc", "width": 0.5},
                },
            },
            {
                "id": "north-1",
                "type": "north_arrow",
                "position": {
                    "x": 15,
                    "y": 375,
                    "width": 20,
                    "height": 20,
                    "z_index": 5,
                },
                "config": {"style": "circle", "mapElementId": "map-1"},
                "style": {"padding": 0, "opacity": 1},
            },
            {
                "id": "legend-1",
                "type": "legend",
                "position": {
                    "x": 242,
                    "y": 315,
                    "width": 40,
                    "height": 80,
                    "z_index": 8,
                },
                "config": {"title": {"text": "Legend"}, "mapElementId": "map-1"},
                "style": {
                    "padding": 0,
                    "opacity": 1,
                    "background": {"enabled": True, "color": "#ffffff", "opacity": 0.9},
                },
            },
        ],
    }


def _poster_landscape_config() -> dict[str, Any]:
    return {
        "page": _PAGE_A3_LANDSCAPE,
        "layout": _GRID_LAYOUT,
        "elements": [
            {
                "id": "text-title",
                "type": "text",
                "position": {"x": 10, "y": 10, "width": 90, "height": 20, "z_index": 2},
                "config": {
                    "type": "text",
                    "setup": {
                        "text": '<p style="text-align: left"><strong><span style="font-size: 28pt">Poster Title</span></strong></p>'
                    },
                },
                "style": {"padding": 0, "opacity": 1},
            },
            {
                "id": "text-subtitle",
                "type": "text",
                "position": {"x": 10, "y": 33, "width": 90, "height": 90, "z_index": 3},
                "config": {
                    "type": "text",
                    "setup": {
                        "text": '<p><span style="font-size: 14pt">Subtitle or description</span></p>'
                    },
                },
                "style": {"padding": 0, "opacity": 1},
            },
            {
                "id": "image-logo",
                "type": "image",
                "position": {
                    "x": 10,
                    "y": 128,
                    "width": 90,
                    "height": 60,
                    "z_index": 7,
                },
                "config": {"url": _LOGO_URL},
                "style": {"padding": 0, "opacity": 1},
            },
            {
                "id": "text-desc",
                "type": "text",
                "position": {
                    "x": 10,
                    "y": 193,
                    "width": 90,
                    "height": 84,
                    "z_index": 6,
                },
                "config": {
                    "type": "text",
                    "setup": {
                        "text": '<p><span style="font-size: 12pt">Graph description</span></p>'
                    },
                },
                "style": {"padding": 0, "opacity": 1},
            },
            {
                "id": "map-1",
                "type": "map",
                "position": {
                    "x": 105,
                    "y": 10,
                    "width": 305,
                    "height": 267,
                    "z_index": 1,
                },
                "config": {"viewState": _VIEW_STATE},
                "style": {
                    "padding": 0,
                    "opacity": 1,
                    "border": {"enabled": True, "color": "#cccccc", "width": 0.5},
                },
            },
            {
                "id": "north-1",
                "type": "north_arrow",
                "position": {
                    "x": 110,
                    "y": 252,
                    "width": 20,
                    "height": 20,
                    "z_index": 5,
                },
                "config": {"style": "circle", "mapElementId": "map-1"},
                "style": {"padding": 0, "opacity": 1},
            },
            {
                "id": "legend-1",
                "type": "legend",
                "position": {
                    "x": 365,
                    "y": 192,
                    "width": 40,
                    "height": 80,
                    "z_index": 8,
                },
                "config": {"title": {"text": "Legend"}, "mapElementId": "map-1"},
                "style": {
                    "padding": 0,
                    "opacity": 1,
                    "background": {"enabled": True, "color": "#ffffff", "opacity": 0.9},
                },
            },
        ],
    }


STARTERS: list[dict[str, Any]] = [
    {
        "seed_id": "single_map_portrait",
        "name": "Single map - Portrait",
        "description": "Vertical page orientation",
        "config": _single_map_portrait_config(),
    },
    {
        "seed_id": "single_map_landscape",
        "name": "Single map - Landscape",
        "description": "Horizontal page orientation",
        "config": _single_map_landscape_config(),
    },
    {
        "seed_id": "poster_portrait",
        "name": "Poster - Portrait",
        "description": "Vertical page orientation",
        "config": _poster_portrait_config(),
    },
    {
        "seed_id": "poster_landscape",
        "name": "Poster - Landscape",
        "description": "Horizontal page orientation",
        "config": _poster_landscape_config(),
    },
    {
        "seed_id": "blank",
        "name": "Blank",
        "description": "create your own layout",
        "config": _blank_config(),
    },
]


async def ensure_system_organization(db: AsyncSession) -> UUID:
    """Create the system organization if it does not exist yet.

    It has no members, no teams and no domains, so nobody can sign in to it,
    be invited by one of its admins or find it in the member-facing views
    (those only ever show the caller's own organization). Only superusers see
    it, in the list of all organizations. An existing row is left as it is.
    `contact_user_id` is required but has no foreign key; the nil UUID
    matches no user.
    """
    await db.execute(
        pg_insert(Organization)
        .values(
            id=GOAT_SYSTEM_ORGANIZATION_ID,
            name="GOAT",
            avatar=settings.ORGANIZATION_DEFAULT_AVATAR,
            on_trial=False,
            total_credits=SELF_HOSTED_QUOTAS["credits"],
            total_storage=SELF_HOSTED_QUOTAS["storage"],
            total_projects=SELF_HOSTED_QUOTAS["projects"],
            total_editors=SELF_HOSTED_QUOTAS["editors"],
            total_viewers=SELF_HOSTED_QUOTAS["viewers"],
            used_editors=0,
            type="other",
            region="EU",
            contact_user_id=UUID(int=0),
            suspended=False,
        )
        .on_conflict_do_nothing(index_elements=["id"])
    )
    return GOAT_SYSTEM_ORGANIZATION_ID


async def _target_space_and_folder(db: AsyncSession) -> tuple[UUID, UUID]:
    """The space the seeded starters live in: the configured organization's
    space; without one, the default user's personal space (AUTH off) or the
    system organization's space (AUTH on)."""
    if settings.GOAT_TEMPLATES_ORGANIZATION_ID is not None:
        target_space = await crud_space.ensure_organization(
            db, settings.GOAT_TEMPLATES_ORGANIZATION_ID
        )
    elif settings.AUTH is False:
        target_space = await crud_space.ensure_personal(
            db, UUID(settings.DEFAULT_USER_ID)
        )
    else:
        target_space = await crud_space.ensure_organization(
            db, await ensure_system_organization(db)
        )
    assert target_space.id is not None
    folder_id = await crud_space.ensure_root_folder(db, target_space.id)
    return target_space.id, folder_id


async def seed_templates(db: AsyncSession) -> None:
    """Publish the five GOAT layout starters as `Template` rows.

    Idempotent by `source_ref->>'seed_id'` — re-running updates
    `name`/`description`/`config` on the existing row instead of creating a
    duplicate, so a fix to a starter ships on the next deploy. A re-run also
    resets `catalog_status` back to `published` and `deleted_at` to `NULL`
    (a starter soft-deleted or unpublished by hand comes back on the next
    deploy) and moves the row to the currently configured destination space/
    folder (`GOAT_TEMPLATES_ORGANIZATION_ID` and AUTH, which pick it, may
    change between runs).

    Matching is tolerant of a stray duplicate `seed_id` (two rows should
    never exist, but nothing in the schema prevents it): the first match
    (by `created_at`) is updated and the rest are logged, not touched.
    """
    space_id, folder_id = await _target_space_and_folder(db)
    now = datetime.now(timezone.utc)
    for starter in STARTERS:
        seed_id = starter["seed_id"]
        frozen_config = strip_layout_bindings(starter["config"])
        # The two values a starter's card is labelled with, read straight off
        # the page the starter declares.
        page = starter["config"].get("page") or {}
        page_size = page.get("size")
        page_orientation = page.get("orientation")
        # Raw SQL, not the ORM query builder: this codebase's SQLModel
        # column attributes (e.g. `Template.created_at`, inherited from the
        # created_at/updated_at mixin) aren't typed for `order_by`/the
        # comparison operators — see `crud_template.list_grants`'s
        # docstring for the same trade-off.
        match_ids = [
            r[0]
            for r in (
                await db.execute(
                    text(
                        f"SELECT id FROM {settings.SCHEMA}.template "
                        "WHERE source_ref->>'seed_id' = :seed_id "
                        "ORDER BY created_at ASC"
                    ),
                    {"seed_id": seed_id},
                )
            ).all()
        ]
        if len(match_ids) > 1:
            logger.warning(
                "seed_templates: %d rows share seed_id %r; updating the first "
                "(created_at earliest), leaving the rest alone",
                len(match_ids),
                seed_id,
            )
        existing = await db.get(Template, match_ids[0]) if match_ids else None
        if existing is None:
            db.add(
                Template(
                    name=starter["name"],
                    description=starter["description"],
                    categories=["Reporting"],
                    space_id=space_id,
                    folder_id=folder_id,
                    user_id=None,
                    payload_kind=TemplatePayloadKind.layout,
                    config=frozen_config,
                    page_size=page_size,
                    page_orientation=page_orientation,
                    catalog_status=TemplateCatalogStatus.published,
                    catalog_published_at=now,
                    source_ref={"kind": "seed", "seed_id": seed_id},
                )
            )
        else:
            existing.name = starter["name"]
            existing.description = starter["description"]
            existing.config = frozen_config
            existing.page_size = page_size
            existing.page_orientation = page_orientation
            existing.space_id = space_id
            existing.folder_id = folder_id
            existing.catalog_status = TemplateCatalogStatus.published
            if existing.catalog_published_at is None:
                existing.catalog_published_at = now
            existing.deleted_at = None
    await db.commit()


async def main() -> None:
    session_manager.init(settings.ASYNC_SQLALCHEMY_DATABASE_URI)
    try:
        async with session_manager.session() as session:
            await seed_templates(session)
    finally:
        await session_manager.close()


if __name__ == "__main__":
    asyncio.run(main())
