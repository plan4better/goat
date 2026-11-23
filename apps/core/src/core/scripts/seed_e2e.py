"""Datasets the end-to-end suite expects the default user to own.

The Playwright specs pick, share and add datasets (`apps/web/playwright/`),
and a fresh stack has none: creating one through the app needs the Windmill
import job, which the nightly e2e run does not start. This inserts two small
dataset records straight into the default user's home folder: a point feature
layer and a table. Records only, with no DuckLake data behind them: the specs
list, pick, share and add them, which reads metadata, and never assert on
features or tiles.

With AUTH=False the datasets go to the built-in default user. With auth on
they go to the user named by `--user-id` (the e2e suite's owner, created by
`scripts/e2e/provision.py`), which must then be given: there is no default
account to fall back to. Idempotent: a dataset already present by name is
left as it is.

    uv run python -m core.scripts.seed_e2e                   # AUTH=False
    uv run python -m core.scripts.seed_e2e --user-id <uuid>  # auth on
"""

import argparse
import asyncio
import logging
from uuid import UUID, uuid4

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.core.config import settings
from core.db.models.folder import Folder
from core.db.models.layer import Layer
from core.db.session import session_manager
from core.services.style import insert_dataset_default

logger = logging.getLogger(__name__)

# A small box in Munich, where the starter templates open.
_EXTENT = (
    "MULTIPOLYGON(((11.50 48.10, 11.50 48.17, 11.62 48.17, 11.62 48.10, 11.50 48.10)))"
)

DATASETS: tuple[dict[str, object], ...] = (
    {
        "name": "E2E Points",
        "type": "feature",
        "feature_layer_type": "standard",
        "feature_layer_geometry_type": "point",
        "extent": _EXTENT,
    },
    {"name": "E2E Table", "type": "table"},
)


async def seed_e2e(session: AsyncSession, user_id: UUID) -> None:
    home = (
        await session.execute(
            select(Folder).where(Folder.user_id == user_id, Folder.name == "home")
        )
    ).scalar_one_or_none()
    if home is None:
        raise RuntimeError(
            "The user has no home folder: run initial_data (AUTH=False) or "
            "scripts/e2e/provision.py (auth on) first"
        )
    for dataset in DATASETS:
        exists = (
            await session.execute(
                select(Layer.id).where(
                    Layer.user_id == user_id,
                    Layer.name == dataset["name"],
                    Layer.deleted_at.is_(None),
                )
            )
        ).scalar_one_or_none()
        if exists is not None:
            continue
        layer_id = uuid4()
        session.add(
            Layer(
                id=layer_id,
                user_id=user_id,
                folder_id=home.id,
                space_id=home.space_id,
                **dataset,
            )
        )
        await session.commit()
        if dataset["type"] == "feature":
            await insert_dataset_default(session, layer_id)
        logger.info("Seeded dataset %s", dataset["name"])
    await session.commit()


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--user-id", type=UUID, help="owner of the datasets (auth on)")
    args = parser.parse_args()
    if args.user_id is None and settings.AUTH is not False:
        raise SystemExit("seed_e2e with auth on needs --user-id")
    user_id = args.user_id or UUID(str(settings.DEFAULT_USER_ID))
    session_manager.init(settings.ASYNC_SQLALCHEMY_DATABASE_URI)
    try:
        async with session_manager.session() as session:
            await seed_e2e(session, user_id)
    finally:
        await session_manager.close()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(main())
