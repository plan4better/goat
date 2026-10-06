from decimal import Decimal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from core.core.config import settings as core_settings
from core.crud.crud_organization import organization as crud_organization
from core.deps.auth import auth_z
from core.endpoints.deps import get_db, get_user_id

# The routes read the caller's own organization only (get_user_id); auth_z
# verifies the token like every other route.
router = APIRouter(dependencies=[Depends(auth_z)])


def _num(value: "Decimal | float | int | None") -> float:
    return float(value) if value is not None else 0.0


@router.get("/balance", summary="Current organization's credit + capacity usage")
async def get_balance(
    user_id: UUID = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
) -> dict:
    org = await crud_organization.get_by_user(db, user_id)
    if org is None:
        raise HTTPException(status_code=404, detail="No organization for user")

    used_credits = _num(org.used_credits)
    total_credits = None if org.total_credits is None else float(org.total_credits)
    over_budget = total_credits is not None and used_credits >= total_credits

    return {
        "used_credits": used_credits,
        "total_credits": total_credits,
        "over_budget": over_budget,
        "plan_renewal_date": org.plan_renewal_date.isoformat()
        if org.plan_renewal_date
        else None,
        "used_storage": _num(org.used_storage),
        "total_storage": None
        if org.total_storage is None
        else float(org.total_storage),
        "used_projects": _num(org.used_projects),
        "total_projects": None
        if org.total_projects is None
        else float(org.total_projects),
        "used_editors": _num(org.used_editors),
        "total_editors": None
        if org.total_editors is None
        else float(org.total_editors),
        "used_viewers": _num(org.used_viewers),
        "total_viewers": None
        if org.total_viewers is None
        else float(org.total_viewers),
    }


@router.get("/usage", summary="Itemized credit ledger")
async def get_usage(
    page: int = Query(1, ge=1),
    size: int = Query(50, ge=1, le=200),
    user_id: UUID = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
) -> dict:
    org = await crud_organization.get_by_user(db, user_id)
    if org is None:
        raise HTTPException(status_code=404, detail="No organization for user")
    schema = core_settings.SCHEMA
    total = (
        await db.execute(
            text(
                f"SELECT count(*) FROM {schema}.credit_usage WHERE organization_id = :o"
            ),
            {"o": str(org.id)},
        )
    ).scalar_one()
    rows = (
        (
            await db.execute(
                text(f"""
            SELECT cu.created_at, cu.category, cu.action, cu.unit, cu.unit_type,
                   cu.rate, cu.cost,
                   NULLIF(trim(concat(u.firstname, ' ', u.lastname)), '') AS member
            FROM {schema}.credit_usage cu
            LEFT JOIN {schema}."user" u ON u.id = cu.user_id
            WHERE cu.organization_id = :o
            ORDER BY cu.created_at DESC
            LIMIT :lim OFFSET :off
        """),
                {"o": str(org.id), "lim": size, "off": (page - 1) * size},
            )
        )
        .mappings()
        .all()
    )
    return {"total": total, "items": [dict(r) for r in rows]}


_STD_BREAKDOWN = {
    "category": ("category", ""),
    "tool": ("action", "AND category = 'compute'"),
    "service": ("action", "AND category = 'egress'"),
    "layer": ("payload->>'layer_id'", "AND category = 'egress'"),
}


def _coerce(v: object) -> object:
    return float(v) if isinstance(v, Decimal) else v


@router.get("/breakdown", summary="Aggregated usage by dimension")
async def get_breakdown(
    group_by: str = Query("category"),
    user_id: UUID = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
) -> dict:
    org = await crud_organization.get_by_user(db, user_id)
    if org is None:
        raise HTTPException(status_code=404, detail="No organization for user")
    schema = core_settings.SCHEMA
    base = f"FROM {schema}.credit_usage WHERE organization_id = :o"
    params = {"o": str(org.id)}

    if group_by in _STD_BREAKDOWN:
        key_expr, filt = _STD_BREAKDOWN[group_by]
        sql = (
            f"SELECT {key_expr} AS key, sum(cost) AS credits, sum(unit) AS units, "
            f"count(*) AS count {base} {filt} GROUP BY {key_expr} ORDER BY credits DESC"
        )
    elif group_by == "workflow":
        sql = (
            f"SELECT payload->>'workflow_id' AS key, sum(cost) AS credits, "
            f"sum(unit) AS units, count(*) AS count, "
            f"count(DISTINCT payload->>'workflow_run_id') AS runs "
            f"{base} AND payload->>'workflow_id' IS NOT NULL "
            f"GROUP BY payload->>'workflow_id' ORDER BY credits DESC"
        )
    elif group_by == "member":
        sql = (
            f"SELECT user_id::text AS key, "
            f"sum(cost) FILTER (WHERE category='compute') AS compute, "
            f"sum(cost) FILTER (WHERE category='egress') AS traffic, "
            f"sum(cost) AS credits {base} GROUP BY user_id ORDER BY credits DESC"
        )
    elif group_by == "month":
        sql = (
            f"SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS key, "
            f"sum(cost) AS credits, sum(unit) AS units, count(*) AS count "
            f"{base} GROUP BY 1 ORDER BY 1 DESC"
        )
    else:
        raise HTTPException(status_code=400, detail=f"unknown group_by '{group_by}'")

    rows = (await db.execute(text(sql), params)).mappings().all()
    return {
        "group_by": group_by,
        "rows": [{k: _coerce(v) for k, v in dict(r).items()} for r in rows],
    }


@router.get(
    "/storage-by-layer", summary="Storage occupancy per layer (capacity, not credits)"
)
async def get_storage_by_layer(
    user_id: UUID = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
) -> dict:
    org = await crud_organization.get_by_user(db, user_id)
    if org is None:
        raise HTTPException(status_code=404, detail="No organization for user")
    schema = core_settings.SCHEMA
    rows = (
        (
            await db.execute(
                text(f"""
            SELECT l.id::text AS layer_id, l.name,
                   COALESCE(l.size, 0) / 1048576.0 AS size_mb,
                   l.feature_layer_geometry_type AS geometry_type,
                   NULLIF(trim(concat(u.firstname, ' ', u.lastname)), '') AS owner
            FROM {schema}.layer l
            JOIN {schema}."user" u ON u.id = l.user_id
            WHERE u.organization_id = :o
            ORDER BY l.size DESC NULLS LAST
        """),
                {"o": str(org.id)},
            )
        )
        .mappings()
        .all()
    )
    return {"rows": [dict(r) | {"size_mb": float(r["size_mb"])} for r in rows]}
