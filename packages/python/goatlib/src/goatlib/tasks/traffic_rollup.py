"""traffic_rollup: charge egress bytes per org×layer×service from Redis
hashes; refresh over-budget flags. Post-hoc. See spec §5/§7/§12."""

from __future__ import annotations

import json
import logging
import os
from typing import TYPE_CHECKING

from pydantic import BaseModel, Field

from goatlib.tasks._db import core_dsn, customer_schema

if TYPE_CHECKING:
    import redis

logger = logging.getLogger(__name__)

_PREFIX = "meter:egress:"


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


def drain_egress(redis_client: "redis.Redis") -> list[dict]:
    """Read every egress hash; drop zero-byte/garbage keys immediately.

    Returns one dict per dimension (bytes>0). Each dict includes the redis `key`
    so the caller can decrement it after a successful charge (avoiding data loss on
    DB failures).
    """
    raw_keys = list(redis_client.scan_iter(match=f"{_PREFIX}*"))
    if not raw_keys:
        return []

    keys = [_dec(k) for k in raw_keys]
    pipe = redis_client.pipeline()
    for key in keys:
        pipe.hgetall(key)
    hashes = pipe.execute()

    out: list[dict] = []
    for key, h in zip(keys, hashes):
        if not h:
            redis_client.delete(key)
            continue
        # FIX C: malformed keys are junk — delete before any other check so they
        # don't re-appear on every scan, even if they happen to have bytes > 0.
        if len(key.split(":")) != 5:
            logger.debug("traffic_rollup: deleting malformed meter key %r", key)
            redis_client.delete(key)
            continue
        h = {_dec(k): _dec(v) for k, v in h.items()}
        try:
            n_bytes = int(h.get("bytes", 0))
        except (TypeError, ValueError):
            redis_client.delete(key)
            continue
        if n_bytes <= 0:
            redis_client.delete(key)
            continue
        org, layer, service = parse_meter_key(key)
        out.append(
            {
                "key": key,
                "org": org,
                "owner": h.get("owner"),
                "layer": layer,
                "service": service,
                "bytes": n_bytes,
                "count": int(h.get("count", 0) or 0),
                "anon_count": int(h.get("anon_count", 0) or 0),
            }
        )
    return out


def _redis() -> "redis.Redis":
    import redis as redis_mod

    return redis_mod.Redis.from_url(os.environ.get("REDIS_URL", "redis://redis:6379/0"))


async def main(params: TrafficRollupParams = TrafficRollupParams()) -> dict:
    """Windmill entry point: charge egress per dimension; refresh over-budget flags."""
    import asyncpg

    schema = customer_schema()
    redis_client = _redis()
    rows = drain_egress(redis_client)
    if not rows:
        return {"rows": 0, "charged": 0}

    core = await asyncpg.connect(dsn=core_dsn(), timeout=10)
    charged = 0
    try:
        # FIX A: Claim (decrement) before charging so a DB failure can't
        # double-charge; restore on failure.  Worst case is a rare under-count
        # on a double failure, which is preferred over overbilling.
        for r in rows:
            if not params.dry_run:
                payload = {
                    "layer_id": r["layer"],
                    "request_count": r["count"],
                    "anon_count": r["anon_count"],
                }
                # Step 1: claim — decrement counters first.
                claim_pipe = redis_client.pipeline()
                claim_pipe.hincrby(r["key"], "bytes", -r["bytes"])
                claim_pipe.hincrby(r["key"], "count", -r["count"])
                claim_pipe.hincrby(r["key"], "anon_count", -r["anon_count"])
                claim_pipe.execute()
                # Step 2: charge.
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
                    # Step 3: compensate — restore the claimed bytes so the next
                    # run can retry.
                    comp_pipe = redis_client.pipeline()
                    comp_pipe.hincrby(r["key"], "bytes", r["bytes"])
                    comp_pipe.hincrby(r["key"], "count", r["count"])
                    comp_pipe.hincrby(r["key"], "anon_count", r["anon_count"])
                    comp_pipe.execute()
                    logger.warning(
                        "traffic_rollup: charge_credits failed for %s/%s, restored counters: %s",
                        r["org"],
                        r["key"],
                        exc,
                    )
                    continue
                charged += 1
        # FIX B: dry_run must have no side effects — skip the flag refresh entirely.
        if not params.dry_run:
            for org_id in {r["org"] for r in rows}:
                bal = await core.fetchrow(
                    f"SELECT used_credits, total_credits FROM {schema}.organization WHERE id = $1",
                    org_id,
                )
                if bal is None:
                    continue
                over = decide_over_budget(
                    float(bal["used_credits"] or 0),
                    None
                    if bal["total_credits"] is None
                    else float(bal["total_credits"]),
                )
                flag = f"meter:over_budget:{org_id}"
                redis_client.set(flag, "1") if over else redis_client.delete(flag)
    finally:
        await core.close()
    summary = {"rows": len(rows), "charged": charged}
    logger.info("traffic_rollup: %s", summary)
    return summary
