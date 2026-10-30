from datetime import datetime
from decimal import Decimal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from core.core.config import settings as core_settings
from core.crud.crud_organization import organization as crud_organization
from core.crud.crud_organization import sub_month
from core.crud.crud_user import user as crud_user
from core.db.models.organization import Organization, OrganizationRolesEnum
from core.deps.auth import auth_z
from core.deps.billing import require_billing_enabled
from core.endpoints.deps import get_db, get_user_id
from core.schemas.entitlement import naive_utc

# The routes read the caller's own organization only (get_user_id); auth_z
# verifies the token like every other route. They exist only with billing on.
router = APIRouter(dependencies=[Depends(require_billing_enabled), Depends(auth_z)])


async def _is_admin(db: AsyncSession, user_id: UUID) -> bool:
    """Whether the caller is an owner or admin of their organization."""
    user = await crud_user.get_user_with_roles(db_session=db, user_id=str(user_id))
    roles = {link.role.name for link in user.role_links} if user else set()
    return bool(roles & {OrganizationRolesEnum.owner, OrganizationRolesEnum.admin})


async def _member_scope(
    db: AsyncSession, user_id: UUID, member: UUID | None
) -> UUID | None:
    """Whose ledger rows the caller sees. The organization's owners and admins
    see everyone's and may narrow it to one member; everyone else sees only
    their own, whatever they ask for."""
    return member if await _is_admin(db, user_id) else user_id


def _period_start(org: Organization) -> datetime | None:
    """Where the current credit period began: a trial's credits last the whole
    trial, a subscription's run a month up to credits_reset_at. None: the
    whole ledger (no monthly period known)."""
    if org.on_trial:
        return org.created_at
    if org.credits_reset_at:
        return sub_month(org.credits_reset_at)
    return None


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

    # The prices, so the Usage page can explain what a credit buys.
    rates = (
        (
            await db.execute(
                text(
                    f"SELECT category, rate, unit_basis FROM {core_settings.SCHEMA}.credit_rate "
                    "ORDER BY category"
                )
            )
        )
        .mappings()
        .all()
    )
    used_credits = _num(org.used_credits)
    total_credits = None if org.total_credits is None else float(org.total_credits)
    over_budget = total_credits is not None and used_credits >= total_credits
    period_start = _period_start(org)

    return {
        "rates": [
            {
                "category": r["category"],
                "rate": float(r["rate"]),
                "unit_basis": r["unit_basis"],
            }
            for r in rates
        ],
        "used_credits": used_credits,
        "total_credits": total_credits,
        # What the usage figures count from by default (see /breakdown).
        "period_start": period_start.isoformat() if period_start else None,
        "over_budget": over_budget,
        "plan_renewal_date": org.plan_renewal_date.isoformat()
        if org.plan_renewal_date
        else None,
        # A trial's credits last until the trial ends (plan_renewal_date); a
        # subscription's are reset monthly, next at credits_reset_at.
        "on_trial": bool(org.on_trial),
        "credits_reset_at": org.credits_reset_at.isoformat()
        if org.credits_reset_at
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
    member: UUID | None = Query(None, description="Only this member's rows (admins)"),
    user_id: UUID = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
) -> dict:
    org = await crud_organization.get_by_user(db, user_id)
    if org is None:
        raise HTTPException(status_code=404, detail="No organization for user")
    schema = core_settings.SCHEMA
    scope = await _member_scope(db, user_id, member)
    member_filter = " AND cu.user_id = :m" if scope else ""
    params = {"o": str(org.id), **({"m": str(scope)} if scope else {})}
    total = (
        await db.execute(
            text(
                f"SELECT count(*) FROM {schema}.credit_usage cu "
                f"WHERE cu.organization_id = :o{member_filter}"
            ),
            params,
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
            WHERE cu.organization_id = :o{member_filter}
            ORDER BY cu.created_at DESC
            LIMIT :lim OFFSET :off
        """),
                {**params, "lim": size, "off": (page - 1) * size},
            )
        )
        .mappings()
        .all()
    )
    return {
        "total": total,
        "items": [{k: _coerce(v) for k, v in dict(r).items()} for r in rows],
    }


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
    member: UUID | None = Query(None, description="Only this member's usage (admins)"),
    since: datetime | None = Query(
        None,
        description="Only usage from this time on (UTC). Default: the start of the "
        "current credit period (see period_start of /balance); group_by=month "
        "defaults to the whole ledger.",
    ),
    user_id: UUID = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
) -> dict:
    org = await crud_organization.get_by_user(db, user_id)
    if org is None:
        raise HTTPException(status_code=404, detail="No organization for user")
    schema = core_settings.SCHEMA
    scope = await _member_scope(db, user_id, member)
    if since is not None:
        since = naive_utc(since)
    elif group_by != "month":
        since = _period_start(org)
    base = (
        f"FROM {schema}.credit_usage WHERE organization_id = :o"
        + (" AND user_id = :m" if scope else "")
        + (" AND created_at >= :since" if since else "")
    )
    params = {
        "o": str(org.id),
        **({"m": str(scope)} if scope else {}),
        **({"since": since} if since else {}),
    }

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
        # Traffic of public pages has no user: it is the organization's own.
        sql = (
            f"SELECT b.key, b.compute, b.traffic, b.credits, "
            f"NULLIF(trim(concat(u.firstname, ' ', u.lastname)), '') AS name "
            f"FROM (SELECT user_id::text AS key, "
            f"sum(cost) FILTER (WHERE category='compute') AS compute, "
            f"sum(cost) FILTER (WHERE category='egress') AS traffic, "
            f"sum(cost) AS credits {base} GROUP BY user_id) b "
            f'LEFT JOIN {schema}."user" u ON u.id::text = b.key '
            f"ORDER BY b.credits DESC"
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
        "since": since.isoformat() if since else None,
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
    # Names, owners and sizes of everyone's layers: not for every member.
    if not await _is_admin(db, user_id):
        raise HTTPException(
            status_code=403, detail="Only organization owners and admins"
        )
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
