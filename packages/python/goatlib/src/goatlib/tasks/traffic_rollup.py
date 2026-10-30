"""traffic_rollup: charge egress bytes per org×layer×service from Redis
hashes; refresh over-budget flags. Post-hoc. See spec §5/§7/§12.

Claiming is by RENAME (atomic): a live ``meter:egress:*`` hash becomes an
in-flight ``meter:egress_inflight:{run_id}:*`` hash that geoapi no longer
writes to. It is charged from there with the in-flight key as an idempotency
marker in the payload, then deleted; on a failed charge its counts are merged
back into the live key. In-flight keys of a crashed run are recovered by the
next run (charged already? delete, else merge back)."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel, Field

from goatlib.tasks._db import core_dsn, customer_schema

if TYPE_CHECKING:
    import redis

logger = logging.getLogger(__name__)

_PREFIX = "meter:egress:"
_INFLIGHT_PREFIX = "meter:egress_inflight:"
_FLAG_PREFIX = "meter:over_budget:"
# A run that was last seen this long ago is dead: its in-flight keys are
# recovered. Long enough that a slow run is never mistaken for a crashed one.
_RECOVER_AFTER_SECONDS = 15 * 60


class TrafficRollupParams(BaseModel):
    dry_run: bool = Field(default=False)


def parse_meter_key(key: str) -> tuple[str, str, str]:
    """meter:egress:{org}:{layer}:{service} -> (org, layer, service)."""
    parts = key.split(":")
    # ['meter','egress',org,layer,service]
    return parts[2], parts[3], parts[4]


def decide_over_budget(used: float, total: float | None) -> bool:
    return total is not None and used >= total


def _dec(v: bytes | str) -> str:
    return v.decode() if isinstance(v, bytes) else v


def _is_missing_key(exc: Exception) -> bool:
    return "no such key" in str(exc).lower()


def _parse_hash(h: dict) -> dict | None:
    """A meter hash as a row dict, or None when it is junk (no bytes)."""
    h = {_dec(k): _dec(v) for k, v in h.items()}
    try:
        n_bytes = int(h.get("bytes", 0))
        count = int(h.get("count", 0) or 0)
        anon_count = int(h.get("anon_count", 0) or 0)
    except (TypeError, ValueError):
        return None
    if n_bytes <= 0:
        return None
    return {
        "bytes": n_bytes,
        "owner": h.get("owner"),
        "count": count,
        "anon_count": anon_count,
    }


def claim_egress(
    redis_client: "redis.Redis", run_id: str, dry_run: bool = False
) -> list[dict]:
    """Claim every live egress hash for this run.

    Each live key is RENAMEd to ``meter:egress_inflight:{run_id}:{org}:{layer}:
    {service}`` (atomic: a concurrent write lands in a new live key or in the
    hash before the rename, never lost). Returns one dict per dimension with
    bytes>0; ``key`` is the in-flight key, ``live_key`` the original. Junk is
    deleted — from the in-flight copy, which nothing else writes to.

    ``dry_run`` only reads: nothing is renamed or deleted.
    """
    rows: list[dict] = []
    for raw_key in list(redis_client.scan_iter(match=f"{_PREFIX}*")):
        live_key = _dec(raw_key)
        # Malformed keys are junk — delete so they don't re-appear on every scan.
        if len(live_key.split(":")) != 5:
            logger.debug("traffic_rollup: deleting malformed meter key %r", live_key)
            if not dry_run:
                redis_client.delete(live_key)
            continue
        org, layer, service = parse_meter_key(live_key)
        key = live_key
        if not dry_run:
            key = f"{_INFLIGHT_PREFIX}{run_id}:{org}:{layer}:{service}"
            try:
                redis_client.rename(live_key, key)
            except Exception as exc:
                if _is_missing_key(exc):
                    continue  # vanished since the scan
                raise
        parsed = _parse_hash(redis_client.hgetall(key))
        if parsed is None:
            if not dry_run:
                redis_client.delete(key)
            continue
        rows.append(
            {
                "key": key,
                "live_key": live_key,
                "org": org,
                "layer": layer,
                "service": service,
                **parsed,
            }
        )
    return rows


def _merge_back(redis_client: "redis.Redis", inflight_key: str, live_key: str) -> None:
    """Put an in-flight hash's counts back on the live key and drop it."""
    h = redis_client.hgetall(inflight_key)
    parsed = _parse_hash(h) if h else None
    pipe = redis_client.pipeline()
    if parsed is not None:
        pipe.hincrby(live_key, "bytes", parsed["bytes"])
        pipe.hincrby(live_key, "count", parsed["count"])
        pipe.hincrby(live_key, "anon_count", parsed["anon_count"])
        if parsed["owner"]:
            pipe.hsetnx(live_key, "owner", parsed["owner"])
    pipe.delete(inflight_key)
    pipe.execute()


async def _claim_charged(
    core: Any, schema: str, org_id: str, inflight_key: str
) -> bool:
    """Is this in-flight key already in the ledger (charge committed)?"""
    row = await core.fetchrow(
        f"""SELECT 1 FROM {schema}.credit_usage
            WHERE organization_id = $1::uuid AND category = 'egress'
              AND payload->>'claim' = $2 LIMIT 1""",
        org_id,
        inflight_key,
    )
    return row is not None


async def _settle_inflight(
    redis_client: "redis.Redis",
    core: Any,
    schema: str,
    inflight_key: str,
    live_key: str,
    org_id: str,
) -> str:
    """Resolve an in-flight key whose charge is unknown or failed.

    Returns "charged" (committed after all: dropped), "restored" (merged back
    for the next run) or "kept" (could not tell; left for the next recovery).
    """
    try:
        if await _claim_charged(core, schema, org_id, inflight_key):
            redis_client.delete(inflight_key)
            return "charged"
    except Exception as exc:
        logger.warning(
            "traffic_rollup: cannot tell if %s was charged, keeping it: %s",
            inflight_key,
            exc,
        )
        return "kept"
    _merge_back(redis_client, inflight_key, live_key)
    return "restored"


async def recover_inflight(
    redis_client: "redis.Redis", core: Any, schema: str, now: float | None = None
) -> int:
    """Settle in-flight keys left by earlier runs that died mid-way."""
    now = time.time() if now is None else now
    recovered = 0
    for raw_key in list(redis_client.scan_iter(match=f"{_INFLIGHT_PREFIX}*")):
        key = _dec(raw_key)
        parts = key.split(":")
        # ['meter','egress_inflight',run_id,org,layer,service]
        if len(parts) != 6:
            redis_client.delete(key)
            continue
        try:
            started = int(parts[2].split("-", 1)[0])
        except ValueError:
            started = 0
        if started > now - _RECOVER_AFTER_SECONDS:
            continue  # may still be running
        live_key = f"meter:egress:{parts[3]}:{parts[4]}:{parts[5]}"
        outcome = await _settle_inflight(
            redis_client, core, schema, key, live_key, parts[3]
        )
        if outcome != "kept":
            recovered += 1
    return recovered


def _redis() -> "redis.Redis":
    import redis as redis_mod

    return redis_mod.Redis.from_url(os.environ.get("REDIS_URL", "redis://redis:6379/0"))


def _valid_uuid(value: str) -> bool:
    try:
        uuid.UUID(value)
    except ValueError:
        return False
    return True


async def refresh_over_budget_flags(
    redis_client: "redis.Redis", core: Any, schema: str
) -> dict[str, int]:
    """Recompute meter:over_budget:{org} for every org that has a flag or is
    over budget: set it for the over-budget ones, delete it for the rest.

    Not just orgs with new egress: a top-up (the billing system raises total_credits or
    resets usage) must lift the flag, and an org over budget through compute
    alone must get one. Core has no Redis, so this task is the only place."""
    flagged: set[str] = set()
    for raw_key in redis_client.scan_iter(match=f"{_FLAG_PREFIX}*"):
        org_id = _dec(raw_key)[len(_FLAG_PREFIX) :]
        if _valid_uuid(org_id):
            flagged.add(org_id)
        else:
            redis_client.delete(_dec(raw_key))
    rows = await core.fetch(
        f"""SELECT id::text AS id, used_credits, total_credits
            FROM {schema}.organization
            WHERE id = ANY($1::uuid[])
               OR (total_credits IS NOT NULL
                   AND COALESCE(used_credits, 0) >= total_credits)""",
        sorted(flagged),
    )
    over_orgs: set[str] = set()
    for row in rows:
        if decide_over_budget(
            float(row["used_credits"] or 0),
            None if row["total_credits"] is None else float(row["total_credits"]),
        ):
            over_orgs.add(row["id"])
    for org_id in over_orgs:
        redis_client.set(f"{_FLAG_PREFIX}{org_id}", "1")
    # Flagged but no longer over budget (or the org is gone): lift the flag.
    cleared = flagged - over_orgs
    for org_id in cleared:
        redis_client.delete(f"{_FLAG_PREFIX}{org_id}")
    return {"flags_set": len(over_orgs), "flags_cleared": len(cleared)}


def main(params: TrafficRollupParams = TrafficRollupParams()) -> dict:
    """Windmill entry point: charge egress per dimension; refresh over-budget flags."""
    # Synchronous: Windmill calls main() without awaiting it.
    return asyncio.run(_run(params))


async def _run(params: TrafficRollupParams) -> dict:
    from goatlib.tasks._db import SKIPPED, billing_enabled

    if not billing_enabled():
        return SKIPPED
    import asyncpg

    schema = customer_schema()
    redis_client = _redis()
    # Time-stamped so recovery can tell a dead run's keys from a live one's.
    run_id = f"{int(time.time())}-{uuid.uuid4().hex[:8]}"

    core = await asyncpg.connect(dsn=core_dsn(), timeout=10)
    charged = 0
    failed = 0
    recovered = 0
    summary: dict = {}
    try:
        if not params.dry_run:
            recovered = await recover_inflight(redis_client, core, schema)
        rows = claim_egress(redis_client, run_id, dry_run=params.dry_run)
        for r in rows:
            if params.dry_run:
                continue
            payload = {
                "layer_id": r["layer"],
                "request_count": r["count"],
                "anon_count": r["anon_count"],
                # Idempotency marker: lets a later run see the charge landed.
                "run_id": run_id,
                "claim": r["key"],
            }
            try:
                await core.execute(
                    f"SELECT {schema}.charge_credits($1, $2, $3, 'egress', $4, $5::jsonb)",
                    r["org"],
                    r["owner"],
                    r["service"],
                    r["bytes"],
                    json.dumps(payload),
                )
            except Exception as exc:
                logger.warning(
                    "traffic_rollup: charge_credits failed for %s/%s: %s",
                    r["org"],
                    r["key"],
                    exc,
                )
                outcome = await _settle_inflight(
                    redis_client, core, schema, r["key"], r["live_key"], r["org"]
                )
                if outcome == "charged":
                    charged += 1
                else:
                    failed += 1
                continue
            redis_client.delete(r["key"])
            charged += 1
        # dry_run must have no side effects — skip the flag refresh entirely.
        if not params.dry_run:
            summary = await refresh_over_budget_flags(redis_client, core, schema)
    finally:
        await core.close()
    summary = {
        "rows": len(rows),
        "charged": charged,
        "failed": failed,
        "recovered": recovered,
        **summary,
    }
    logger.info("traffic_rollup: %s", summary)
    return summary
