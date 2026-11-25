"""Store the extent of raster layers added from a COG before core stored one.

core stores a COG layer's extent when it creates the layer, from geoapi's
`bounds` route. Layers created earlier have none; this one-off command reads
each file's bounds the way that route does (`raster_service.bounds`, the
header only) and writes them where the row still has no extent. It is run by
an operator once per environment, from geoapi's image, which has the raster
reader core lacks; geoapi's routes themselves never write the layer row.

    python -m geoapi.scripts.backfill_raster_extents [--dry-run] [--limit N]

Idempotent: only rows without an extent are read and written, and
`updated_at` is left alone, so tile caches keyed by it stay valid. A file that
cannot be read is logged and counted; the others still run.
"""

import argparse
import asyncio
import logging
from dataclasses import dataclass
from uuid import UUID

from geoapi.config import settings
from geoapi.services.layer_service import layer_service
from geoapi.services.raster_service import raster_service, valid_bounds

logger = logging.getLogger("geoapi.backfill_raster_extents")

CANDIDATES = (
    "SELECT id, url FROM customer.layer "
    "WHERE type = 'raster' AND data_type = 'cog' AND url IS NOT NULL "
    "AND extent IS NULL ORDER BY created_at LIMIT $1"
)
STORE = (
    "UPDATE customer.layer "
    "SET extent = ST_Multi(ST_MakeEnvelope($2, $3, $4, $5, 4326)) "
    "WHERE id = $1 AND extent IS NULL"
)


@dataclass
class Counts:
    #: COG layers without an extent.
    candidates: int = 0
    #: Extents stored (in a dry run: that would be stored).
    written: int = 0
    #: Files whose bounds are no box on earth.
    skipped: int = 0
    #: Files that could not be read.
    failed: int = 0


async def backfill(*, dry_run: bool = False, limit: int | None = None) -> Counts:
    """One pass over the COG layers without an extent; the pool must be open."""
    rows = await layer_service._execute_with_retry(CANDIDATES, limit) or []
    counts = Counts(candidates=len(rows))
    for row in rows:
        layer_id: UUID = row["id"]
        try:
            layer = await raster_service.layer(layer_id.hex)
            if layer is None:
                continue
            bounds = await asyncio.to_thread(raster_service.bounds, layer)
        except Exception as error:
            logger.warning("layer %s: file not read: %s", layer_id, error)
            counts.failed += 1
            continue
        if not valid_bounds(bounds):
            logger.warning("layer %s: bounds %s are no box on earth", layer_id, bounds)
            counts.skipped += 1
            continue
        if not dry_run:
            await layer_service._execute_with_retry(STORE, layer_id, *bounds)
        logger.info("layer %s: extent %s", layer_id, list(bounds))
        counts.written += 1
    return counts


async def main(dry_run: bool, limit: int | None) -> Counts:
    logger.info(
        "Raster extents in database %s on %s%s",
        settings.POSTGRES_DB,
        settings.POSTGRES_SERVER,
        " (dry run)" if dry_run else "",
    )
    await layer_service.init()
    try:
        counts = await backfill(dry_run=dry_run, limit=limit)
    finally:
        await layer_service.close()
    logger.info(
        "%d COG layer(s) without an extent: %d %s, %d skipped, %d failed",
        counts.candidates,
        counts.written,
        "would be stored" if dry_run else "stored",
        counts.skipped,
        counts.failed,
    )
    return counts


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true", help="read, write nothing")
    parser.add_argument("--limit", type=int, help="at most this many layers")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    asyncio.run(main(args.dry_run, args.limit))
