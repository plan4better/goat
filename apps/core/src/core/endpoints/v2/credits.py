import csv
import io
from collections.abc import AsyncIterator, Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import AfterValidator
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from core.core.config import settings as core_settings
from core.crud.crud_billing_terms import UNIT_BASIS, ai_terms
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


def _period_bounds(org: Organization, day: date) -> tuple[date, date | None]:
    """The credit period holding `day`: a trial is one period from its start;
    a subscription's periods end on its reset day, stepping back a month each
    (sub_month keeps month ends right); without a reset day, calendar months.
    The end is exclusive, None for the open period."""
    if org.on_trial:
        return org.created_at.date(), None
    if org.credits_reset_at:
        end = org.credits_reset_at
        start = sub_month(end)
        open_end = True
        while start.date() > day:
            end, start, open_end = start, sub_month(start), False
        return start.date(), None if open_end else end.date()
    first = day.replace(day=1)
    nxt = (
        first.replace(year=first.year + 1, month=1)
        if first.month == 12
        else first.replace(month=first.month + 1)
    )
    return first, nxt


def _like(q: str) -> str:
    """A case-insensitive substring pattern that takes q literally."""
    escaped = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _search(q: str | None) -> str | None:
    """The search text without the spaces around it; None when that leaves
    nothing, so a blank search filters nothing."""
    return (q or "").strip() or None


# The bounds of since and until on the ledger routes: a date outside them is
# a typing slip, and one near the ends of what datetime holds cannot be turned
# to UTC or stepped back a day without overflowing.
_EARLIEST = datetime(2000, 1, 1)
_LATEST = datetime(2100, 1, 1)


def _within_bounds(moment: datetime | None) -> datetime | None:
    """A since or until from 2000-01-01 up to 2100-01-01 (UTC), as given;
    any other answers 422."""
    if moment is None:
        return None
    # The year first: only a time within a year of the bounds is turned to UTC.
    if not (
        _EARLIEST.year - 1 <= moment.year <= _LATEST.year
        and _EARLIEST <= naive_utc(moment) <= _LATEST
    ):
        raise ValueError("must lie between 2000-01-01 and 2100-01-01")
    return moment


# since and until of /usage, /usage/export and /breakdown, each taken as
# Annotated[_Moment, Query(...)] = None: FastAPI skips the validator of a
# parameter whose default is its Query.
_Moment = Annotated[datetime | None, AfterValidator(_within_bounds)]


def _range(
    base: str,
    since: datetime | None,
    until: datetime | None,
    params: dict,
    column: str = "created_at",
) -> str:
    """The date window as SQL on `column` (credit_usage.created_at): since
    inclusive, until exclusive."""
    if since is not None:
        params["since"] = naive_utc(since)
        base += f" AND {column} >= :since"
    if until is not None:
        params["until"] = naive_utc(until)
        base += f" AND {column} < :until"
    return base


# A user's name (u), null when they have none.
_PERSON = "NULLIF(trim(concat(u.firstname, ' ', u.lastname)), '')"
# Rows per query of a CSV export.
_CSV_BATCH = 5000
# A cell starting with one of these is a formula to a spreadsheet.
_FORMULA_START = ("=", "+", "-", "@", "\t", "\r")


def _cell(value: object) -> object:
    """A text cell as a spreadsheet shows it: one that would start a formula
    gets a leading ' so it stays text. Numbers are written as they are."""
    if isinstance(value, str) and value.startswith(_FORMULA_START):
        return f"'{value}"
    return value


async def _csv_stream(
    db: AsyncSession,
    sql: str,
    params: dict,
    header: list[str],
    row_to_cells: Callable[[Mapping[str, Any]], list[object]],
) -> AsyncIterator[str]:
    """The header, then the rows of `sql` (which ends in its ORDER BY) as CSV
    text, one chunk per batch of _CSV_BATCH rows: a long export is read and
    sent a batch at a time, never held in memory at once.

    The batches page with OFFSET, which assumes the rows do not move while the
    export runs. That holds for the ledger, which is only appended to (a new
    row sorts after every earlier one). It does not quite hold for the storage
    export: a layer added, deleted, renamed or resized between two batches
    can shift the rows after it by one, so one may repeat or go missing."""
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(header)
    offset = 0
    while True:
        batch = (
            (
                await db.execute(
                    text(f"{sql} LIMIT :csv_limit OFFSET :csv_offset"),
                    {**params, "csv_limit": _CSV_BATCH, "csv_offset": offset},
                )
            )
            .mappings()
            .all()
        )
        writer.writerows([_cell(c) for c in row_to_cells(r)] for r in batch)
        yield buffer.getvalue()
        buffer.seek(0)
        buffer.truncate()
        if len(batch) < _CSV_BATCH:
            return
        offset += _CSV_BATCH


def _num(value: "Decimal | float | int | None") -> float:
    return float(value) if value is not None else 0.0


@router.get(
    "/balance", summary="Current organization's credit, AI credit + capacity usage"
)
async def get_balance(
    user_id: UUID = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Every member may read it: the organization's pools are everyone's."""
    org = await crud_organization.get_by_user(db, user_id)
    if org is None:
        raise HTTPException(status_code=404, detail="No organization for user")

    # The prices, so the Usage page can explain what a credit buys: only of the
    # categories core charges, whatever else the table holds.
    rates = (
        (
            await db.execute(
                text(
                    f"SELECT category, rate, unit_basis FROM {core_settings.SCHEMA}.credit_rate "
                    "WHERE category = ANY(:known) ORDER BY category"
                ),
                {"known": list(UNIT_BASIS)},
            )
        )
        .mappings()
        .all()
    )
    used_credits = _num(org.used_credits)
    total_credits = None if org.total_credits is None else float(org.total_credits)
    # The rule lives in the database, shared with processes and traffic_rollup.
    over_budget = bool(
        await db.scalar(
            text(f"SELECT {core_settings.SCHEMA}.credits_exhausted(:org)"),
            {"org": org.id},
        )
    )
    period_start = _period_start(org)
    ai = await ai_terms(db)
    # The seats set the AI credits only for a subscription without a special
    # deal: then the page can say "N per editor".
    seat_allowance = not org.on_trial and not org.ai_credits_override

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
        # The AI-credit pool, apart from the credits; it resets with them.
        "used_ai_credits": _num(org.used_ai_credits),
        "total_ai_credits": None
        if org.total_ai_credits is None
        else float(org.total_ai_credits),
        "ai_credits_per_editor": ai["per_editor"] if seat_allowance else None,
        # What an answer costs by its steps (the first tier whose max_steps is
        # null or at least the steps).
        "ai_credit_tiers": ai["tiers"],
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


@router.get("/usage", summary="Itemized credit and AI credit ledger")
async def get_usage(
    page: int = Query(1, ge=1),
    size: int = Query(50, ge=1, le=200),
    member: UUID | None = Query(None, description="Only this member's rows (admins)"),
    since: Annotated[
        _Moment, Query(description="Only rows from this time on (UTC, 2000 to 2100)")
    ] = None,
    until: Annotated[
        _Moment,
        Query(description="Only rows before this time (UTC, exclusive, 2000 to 2100)"),
    ] = None,
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
    where = _range(
        f"WHERE cu.organization_id = :o{member_filter}",
        since,
        until,
        params,
        "cu.created_at",
    )
    total = (
        await db.execute(
            text(f"SELECT count(*) FROM {schema}.credit_usage cu {where}"),
            params,
        )
    ).scalar_one()
    # No payload: an AI answer's payload names its conversation, which only
    # its author may see. Its steps (unit_type 'steps') and AI credits are all
    # the ledger shows of it.
    rows = (
        (
            await db.execute(
                text(f"""
            SELECT cu.created_at, cu.category, cu.action, cu.unit, cu.unit_type,
                   cu.rate, cu.cost, {_PERSON} AS member
            FROM {schema}.credit_usage cu
            LEFT JOIN {schema}."user" u ON u.id = cu.user_id
            {where}
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


def _utc_iso(moment: datetime) -> str:
    """A column's naive UTC time as ISO 8601 that says it is UTC."""
    return f"{moment.isoformat(timespec='seconds')}Z"


# The export's filter, header and cells per kind. As in /usage, an AI answer
# is its steps and AI credits, never its payload.
_EXPORTS: dict[str, tuple[str, list[str], Callable[[Mapping[str, Any]], list]]] = {
    "credits": (
        "cu.category <> 'ai'",
        ["date", "member", "category", "action", "unit", "unit_type", "credits"],
        lambda r: [
            _utc_iso(r["created_at"]),
            r["member"],
            r["category"],
            r["action"],
            r["unit"],
            r["unit_type"],
            r["cost"],
        ],
    ),
    "ai": (
        "cu.category = 'ai'",
        ["date", "member", "steps", "ai_credits"],
        lambda r: [_utc_iso(r["created_at"]), r["member"], r["unit"], r["cost"]],
    ),
}


@router.get("/usage/export", summary="The credit or AI credit ledger as CSV")
async def export_usage(
    kind: Literal["credits", "ai"] = Query(
        "credits", description="credits: compute and traffic; ai: the AI answers"
    ),
    since: Annotated[
        _Moment, Query(description="Only rows from this time on (UTC, 2000 to 2100)")
    ] = None,
    until: Annotated[
        _Moment,
        Query(
            description="Only rows before this time (UTC, exclusive, 2000 to 2100; "
            "after since)"
        ),
    ] = None,
    member: UUID | None = Query(None, description="Only this member's rows (admins)"),
    user_id: UUID = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    """The ledger rows of the window that the caller may see (the scope of
    /usage), oldest first."""
    # The file is named by its first and last day: a window that ends where
    # or before it starts has none.
    if since is not None and until is not None and naive_utc(until) <= naive_utc(since):
        raise HTTPException(status_code=422, detail="until must be after since")
    org = await crud_organization.get_by_user(db, user_id)
    if org is None:
        raise HTTPException(status_code=404, detail="No organization for user")
    schema = core_settings.SCHEMA
    scope = await _member_scope(db, user_id, member)
    category, header, cells = _EXPORTS[kind]
    params = {"o": str(org.id), **({"m": str(scope)} if scope else {})}
    where = _range(
        f"WHERE cu.organization_id = :o AND {category}"
        + (" AND cu.user_id = :m" if scope else ""),
        since,
        until,
        params,
        "cu.created_at",
    )
    sql = f"""
        SELECT cu.created_at, cu.category, cu.action, cu.unit, cu.unit_type,
               cu.cost, {_PERSON} AS member
        FROM {schema}.credit_usage cu
        LEFT JOIN {schema}."user" u ON u.id = cu.user_id
        {where}
        ORDER BY cu.created_at, cu.id"""
    # The name gives the first and the last day the file holds: without since
    # the ledger's start (the organization's), until is exclusive.
    first = naive_utc(since).date() if since else org.created_at.date()
    last = (
        (naive_utc(until) - timedelta(microseconds=1)).date()
        if until
        else datetime.now(UTC).date()
    )
    filename = f"goat-usage-{kind}-{first.isoformat()}-{last.isoformat()}.csv"
    return StreamingResponse(
        _csv_stream(db, sql, params, header, cells),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# The credits (compute, egress) and the AI credits (category 'ai') are separate
# pools: a credit sum never takes in an AI answer. The AI credits come as
# columns of their own (member, month, day, period) or as the assistant's row
# (tool).
_CREDITS = "category <> 'ai'"
_AI = "category = 'ai'"
_STD_BREAKDOWN = {
    "category": ("category", f"AND {_CREDITS}"),
    "service": ("action", "AND category = 'egress'"),
}
# What each group may be sorted by (sort=), as SQL over its row g; the other
# groups keep their order.
_SORTS = {
    "workflow": {
        "credits": "g.credits",
        "name": "g.name",
        "runs": "g.runs",
        "last_run": "g.last_run",
    },
    "layer": {"credits": "g.credits", "name": "g.name", "requests": "g.requests"},
    "member": {
        "credits": "g.credits",
        "name": "g.name",
        "compute": "g.compute",
        "traffic": "g.traffic",
        "ai_credits": "g.ai_credits",
        "ai_answers": "g.ai_answers",
    },
}
# The direction of a sort (dir=) as SQL. Every ORDER BY takes its SQL from
# these lookups, never the request's text.
_DIRECTIONS = {"asc": "ASC", "desc": "DESC"}
# The groups whose rows have a name to search (q=).
_SEARCHABLE = ("workflow", "layer", "member")


def _coerce(v: object) -> object:
    return float(v) if isinstance(v, Decimal) else v


def _breakdown_sql(group_by: str, base: str, schema: str) -> tuple[str, str]:
    """A group's SELECT over the window `base` and its default order, both
    for a query that wraps the SELECT as g."""
    if group_by in _STD_BREAKDOWN:
        key_expr, filt = _STD_BREAKDOWN[group_by]
        return (
            f"SELECT {key_expr} AS key, sum(cost) AS credits, sum(unit) AS units, "
            f"count(*) AS count {base} {filt} GROUP BY {key_expr}",
            "g.credits DESC, g.key",
        )
    if group_by == "tool":
        # The tools' compute credits and one row for the assistant
        # (key 'assistant'): its credits are AI credits, units its steps.
        return (
            f"SELECT CASE WHEN {_AI} THEN 'assistant' ELSE action END AS key, "
            f"category, sum(cost) AS credits, sum(unit) AS units, count(*) AS count "
            f"{base} AND category IN ('compute', 'ai') GROUP BY 1, 2",
            "g.credits DESC, g.key",
        )
    if group_by == "workflow":
        # Names by left join: a workflow deleted since it ran keeps its row,
        # with name and project null.
        return (
            f"SELECT b.key, w.name, p.id::text AS project_id, "
            f"p.name AS project_name, b.credits, b.units, b.count, b.runs, "
            f"b.last_run "
            f"FROM (SELECT payload->>'workflow_id' AS key, sum(cost) AS credits, "
            f"sum(unit) AS units, count(*) AS count, "
            f"count(DISTINCT payload->>'workflow_run_id') AS runs, "
            f"max(created_at) AS last_run "
            f"{base} AND {_CREDITS} AND payload->>'workflow_id' IS NOT NULL "
            f"GROUP BY payload->>'workflow_id') b "
            f"LEFT JOIN {schema}.workflow w ON w.id::text = b.key "
            f"LEFT JOIN {schema}.project p ON p.id = w.project_id",
            "g.credits DESC, g.key",
        )
    if group_by == "layer":
        # As the workflows: a layer deleted since it was read keeps its row,
        # with name and owner null. A row is one rollup's charge of many
        # requests (payload request_count); a row without the count is one.
        return (
            f"SELECT b.key, l.name, l.user_id::text AS owner_id, "
            f"{_PERSON} AS owner, b.credits, b.units, b.count, b.requests "
            f"FROM (SELECT payload->>'layer_id' AS key, sum(cost) AS credits, "
            f"sum(unit) AS units, count(*) AS count, "
            f"sum(COALESCE((payload->>'request_count')::bigint, 1))::bigint "
            f"AS requests "
            f"{base} AND category = 'egress' GROUP BY payload->>'layer_id') b "
            f"LEFT JOIN {schema}.layer l ON l.id::text = b.key "
            f'LEFT JOIN {schema}."user" u ON u.id = l.user_id',
            "g.credits DESC, g.key",
        )
    if group_by == "member":
        # Traffic of public pages has no user: it is the organization's own.
        return (
            f"SELECT b.key, b.compute, b.traffic, b.credits, b.ai_answers, "
            f"b.ai_credits, {_PERSON} AS name "
            f"FROM (SELECT user_id::text AS key, "
            f"sum(cost) FILTER (WHERE category='compute') AS compute, "
            f"sum(cost) FILTER (WHERE category='egress') AS traffic, "
            f"COALESCE(sum(cost) FILTER (WHERE {_CREDITS}), 0) AS credits, "
            f"count(*) FILTER (WHERE {_AI}) AS ai_answers, "
            f"COALESCE(sum(cost) FILTER (WHERE {_AI}), 0) AS ai_credits "
            f"{base} GROUP BY user_id) b "
            f'LEFT JOIN {schema}."user" u ON u.id::text = b.key',
            "g.credits DESC, g.ai_credits DESC, g.key",
        )
    if group_by == "month":
        return (
            f"SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS key, "
            f"COALESCE(sum(cost) FILTER (WHERE {_CREDITS}), 0) AS credits, "
            f"COALESCE(sum(unit) FILTER (WHERE {_CREDITS}), 0) AS units, "
            f"count(*) FILTER (WHERE {_CREDITS}) AS count, "
            f"count(*) FILTER (WHERE {_AI}) AS ai_answers, "
            f"COALESCE(sum(cost) FILTER (WHERE {_AI}), 0) AS ai_credits "
            f"{base} GROUP BY 1",
            "g.key DESC",
        )
    if group_by in ("day", "period"):
        # Days of UTC, as the column holds UTC; a period sums its days.
        return (
            f"SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS key, "
            f"COALESCE(sum(cost) FILTER (WHERE category='compute'), 0) AS compute, "
            f"COALESCE(sum(cost) FILTER (WHERE category='egress'), 0) AS traffic, "
            f"COALESCE(sum(cost) FILTER (WHERE {_CREDITS}), 0) AS credits, "
            f"count(*) FILTER (WHERE {_CREDITS}) AS count, "
            f"count(*) FILTER (WHERE {_AI}) AS ai_answers, "
            f"COALESCE(sum(cost) FILTER (WHERE {_AI}), 0) AS ai_credits "
            f"{base} GROUP BY 1",
            "g.key",
        )
    raise HTTPException(status_code=400, detail=f"unknown group_by '{group_by}'")


def _by_period(org: Organization, days: Sequence[Mapping[str, Any]]) -> list[dict]:
    """The day rows summed per credit period (_period_bounds), newest first;
    key is the period's first day, until its end (null for the open one)."""
    sums: dict[tuple[date, date | None], dict[str, Any]] = {}
    for day in days:
        bounds = _period_bounds(org, date.fromisoformat(day["key"]))
        total = sums.setdefault(
            bounds, dict.fromkeys(("credits", "count", "ai_answers", "ai_credits"), 0)
        )
        for field in total:
            total[field] += day[field]
    return [
        {"key": start.isoformat(), "until": end.isoformat() if end else None, **total}
        for (start, end), total in sorted(
            sums.items(), key=lambda item: item[0][0], reverse=True
        )
    ]


@router.get("/breakdown", summary="Aggregated usage by dimension")
async def get_breakdown(
    group_by: str = Query(
        "category",
        description="category, service, tool, workflow, layer, member, month, "
        "day or period",
    ),
    member: UUID | None = Query(None, description="Only this member's usage (admins)"),
    since: Annotated[
        _Moment,
        Query(
            description="Only usage from this time on (UTC, 2000 to 2100). Default: "
            "the start of the current credit period (see period_start of /balance); "
            "group_by=month and group_by=period default to the whole ledger."
        ),
    ] = None,
    until: Annotated[
        _Moment,
        Query(description="Only usage before this time (UTC, exclusive, 2000 to 2100)"),
    ] = None,
    q: str | None = Query(
        None,
        max_length=100,
        description="Only rows whose name holds this text, in any case "
        "(group_by workflow, layer and member)",
    ),
    sort: str | None = Query(
        None,
        description="workflow: credits, name, runs, last_run; layer: credits, "
        "name, requests; member: credits, name, compute, traffic, ai_credits, "
        "ai_answers. Default: the group's own order",
    ),
    direction: Literal["asc", "desc"] = Query(
        "desc", alias="dir", description="The direction of sort"
    ),
    limit: int | None = Query(
        None, ge=1, le=100, description="Rows per page. Default: every row"
    ),
    offset: int = Query(0, ge=0),
    user_id: UUID = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """The usage of the window summed per group; `total` counts the rows
    before limit and offset."""
    org = await crud_organization.get_by_user(db, user_id)
    if org is None:
        raise HTTPException(status_code=404, detail="No organization for user")
    schema = core_settings.SCHEMA
    scope = await _member_scope(db, user_id, member)
    if since is not None:
        since = naive_utc(since)
    elif group_by not in ("month", "period"):
        since = _period_start(org)
    if until is not None:
        until = naive_utc(until)
    params = {"o": str(org.id), **({"m": str(scope)} if scope else {})}
    base = _range(
        f"FROM {schema}.credit_usage WHERE organization_id = :o"
        + (" AND user_id = :m" if scope else ""),
        since,
        until,
        params,
    )
    sql, order = _breakdown_sql(group_by, base, schema)
    if sort is not None:
        columns = _SORTS.get(group_by, {})
        if sort not in columns:
            raise HTTPException(
                status_code=422,
                detail=f"unknown sort '{sort}' for group_by '{group_by}'",
            )
        order = f"{columns[sort]} {_DIRECTIONS[direction]} NULLS LAST, g.key"
    where = ""
    q = _search(q)
    if q and group_by in _SEARCHABLE:
        where = " WHERE g.name ILIKE :q ESCAPE '\\'"
        params["q"] = _like(q)

    if group_by == "period":
        days = (await db.execute(text(sql), params)).mappings().all()
        rows = _by_period(org, days)
        total = len(rows)
        if limit:
            rows = rows[offset : offset + limit]
    else:
        total = None
        page = ""
        if limit:
            total = (
                await db.execute(text(f"SELECT count(*) FROM ({sql}) g{where}"), params)
            ).scalar_one()
            page = " LIMIT :limit OFFSET :offset"
            params |= {"limit": limit, "offset": offset}
        rows = (
            (
                await db.execute(
                    text(f"SELECT * FROM ({sql}) g{where} ORDER BY {order}{page}"),
                    params,
                )
            )
            .mappings()
            .all()
        )
        if total is None:
            total = len(rows)
    return {
        "group_by": group_by,
        "since": since.isoformat() if since else None,
        "until": until.isoformat() if until else None,
        "total": total,
        "rows": [{k: _coerce(v) for k, v in dict(r).items()} for r in rows],
    }


# What the storage list may be sorted by (sort=), as SQL over the layer l and
# its project count pc.n. A layer without a size sorts as 0, as its size_mb
# reads.
_STORAGE_SORTS = {
    "size": "COALESCE(l.size, 0)",
    "updated": "l.updated_at",
    "projects": "COALESCE(pc.n, 0)",
    "name": "lower(l.name)",
}
# The type= values that are a feature layer's geometry; the others (table,
# raster) are layer types.
_GEOMETRIES = ("point", "line", "polygon")


def _org_spaces(schema: str) -> str:
    """The organization's (:o) spaces as a subquery of their ids: its own,
    its teams' and its members' personal spaces, the spaces crud_organization
    counts as the organization's."""
    return (
        f"SELECT s.id FROM {schema}.space s WHERE s.organization_id = :o "
        f"OR s.team_id IN (SELECT t.id FROM {schema}.team t "
        f"WHERE t.organization_id = :o) "
        f'OR s.user_id IN (SELECT m.id FROM {schema}."user" m '
        f"WHERE m.organization_id = :o)"
    )


def _of_org(row: str, schema: str) -> str:
    """Whether the layer or project `row` is the organization's (:o): its
    creator (u, left joined) is a member, or it lives in one of the
    organization's spaces. A removed creator leaves user_id null, and the
    space still places the row; as the trigger log_project_count does."""
    return f"(u.organization_id = :o OR {row}.space_id IN ({_org_spaces(schema)}))"


def _layer_projects(schema: str) -> str:
    """A join of each layer l to the number of live projects that use it
    (pc.n), null for a layer in none: a project in the trash keeps its
    layer_project rows but uses no layer. A project template's hidden copy
    does: the template uses the layer. One grouped scan of layer_project: it
    has no index on layer_id, so a subquery per layer would scan it once per
    layer."""
    return (
        f"LEFT JOIN (SELECT lp.layer_id, count(DISTINCT lp.project_id) AS n "
        f"FROM {schema}.layer_project lp "
        f"JOIN {schema}.project p ON p.id = lp.project_id "
        f"WHERE p.deleted_at IS NULL GROUP BY lp.layer_id) pc ON pc.layer_id = l.id"
    )


@dataclass(frozen=True)
class _StorageFilter:
    q: str | None
    owner: UUID | None
    layer_type: str | None
    unused: bool
    sort: str
    direction: str


def _storage_filter(
    q: str | None = Query(
        None,
        max_length=100,
        description="Only layers whose name holds this text, in any case",
    ),
    owner: UUID | None = Query(None, description="Only this member's layers"),
    layer_type: Literal["point", "line", "polygon", "table", "raster"] | None = Query(
        None,
        alias="type",
        description="point, line or polygon: feature layers of that geometry; "
        "table or raster: layers of that type",
    ),
    unused: bool = Query(False, description="Only layers in no project"),
    sort: Literal["size", "updated", "projects", "name"] = Query(
        "size", description="size, updated, projects (how many use it) or name"
    ),
    direction: Literal["asc", "desc"] = Query(
        "desc", alias="dir", description="The direction of sort"
    ),
) -> _StorageFilter:
    """The storage list's filters and order: the list and its export take the
    same."""
    return _StorageFilter(_search(q), owner, layer_type, unused, sort, direction)


def _storage_query(org: Organization, f: _StorageFilter) -> tuple[str, dict]:
    """The organization's live layers (_of_org) that match the filters as a
    SELECT that ends in its ORDER BY, and the values it binds: the list pages
    it, the export reads it whole. owner and owner_id are null for a layer
    whose creator was removed."""
    schema = core_settings.SCHEMA
    filters, params = [], {"o": str(org.id)}
    if f.q:
        filters.append("l.name ILIKE :q ESCAPE '\\'")
        params["q"] = _like(f.q)
    if f.owner:
        filters.append("l.user_id = :owner")
        params["owner"] = str(f.owner)
    if f.layer_type in _GEOMETRIES:
        filters.append("l.type = 'feature' AND l.feature_layer_geometry_type = :gt")
        params["gt"] = f.layer_type
    elif f.layer_type:
        filters.append("l.type = :lt")
        params["lt"] = f.layer_type
    if f.unused:
        filters.append("pc.n IS NULL")
    extra = "".join(f" AND {clause}" for clause in filters)
    order = f"{_STORAGE_SORTS[f.sort]} {_DIRECTIONS[f.direction]} NULLS LAST, l.id"
    return (
        f"""
        SELECT l.id::text AS layer_id, l.name,
               COALESCE(l.size, 0) / 1048576.0 AS size_mb,
               l.feature_layer_geometry_type AS geometry_type, l.type,
               l.user_id::text AS owner_id, {_PERSON} AS owner, l.updated_at,
               COALESCE(pc.n, 0) AS projects
        FROM {schema}.layer l
        LEFT JOIN {schema}."user" u ON u.id = l.user_id
        {_layer_projects(schema)}
        WHERE {_of_org("l", schema)} AND l.deleted_at IS NULL{extra}
        ORDER BY {order}""",
        params,
    )


def _iso(moment: datetime | None) -> str | None:
    return moment.isoformat() if moment else None


@router.get(
    "/storage-by-layer", summary="Storage occupancy per layer (capacity, not credits)"
)
async def get_storage_by_layer(
    limit: int = Query(10, ge=1, le=100),
    offset: int = Query(0, ge=0),
    f: _StorageFilter = Depends(_storage_filter),
    user_id: UUID = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """The organization's live layers that match the filters, largest first
    unless sorted otherwise, a page at a time (`total` counts the matches).
    Whatever the filters: `split`, the storage of all its layers in a
    project, in none and in the trash, and `trash`, the trashed layers' count
    and size: they still use storage until the trash is purged, but are not
    listed."""
    org = await crud_organization.get_by_user(db, user_id)
    if org is None:
        raise HTTPException(status_code=404, detail="No organization for user")
    # Names, owners and sizes of everyone's layers: not for every member.
    if not await _is_admin(db, user_id):
        raise HTTPException(
            status_code=403, detail="Only organization owners and admins"
        )
    schema = core_settings.SCHEMA
    sql, params = _storage_query(org, f)
    rows = (
        (
            await db.execute(
                text(f"{sql} LIMIT :limit OFFSET :offset"),
                {**params, "limit": limit, "offset": offset},
            )
        )
        .mappings()
        .all()
    )
    total = (
        await db.execute(text(f"SELECT count(*) FROM ({sql}) g"), params)
    ).scalar_one()
    counts = (
        (
            await db.execute(
                text(f"""
            SELECT count(*) FILTER (WHERE l.deleted_at IS NOT NULL) AS trash_count,
                   COALESCE(sum(l.size) FILTER (WHERE l.deleted_at IS NOT NULL), 0)
                       / 1048576.0 AS trash_size_mb,
                   COALESCE(sum(l.size) FILTER (
                       WHERE l.deleted_at IS NULL AND pc.n IS NOT NULL), 0)
                       / 1048576.0 AS in_projects_mb,
                   COALESCE(sum(l.size) FILTER (
                       WHERE l.deleted_at IS NULL AND pc.n IS NULL), 0)
                       / 1048576.0 AS unused_mb
            FROM {schema}.layer l
            LEFT JOIN {schema}."user" u ON u.id = l.user_id
            {_layer_projects(schema)}
            WHERE {_of_org("l", schema)}
        """),
                {"o": str(org.id)},
            )
        )
        .mappings()
        .one()
    )
    return {
        "rows": [
            dict(r)
            | {"size_mb": float(r["size_mb"]), "updated_at": _iso(r["updated_at"])}
            for r in rows
        ],
        "total": total,
        "trash": {
            "count": counts["trash_count"],
            "size_mb": float(counts["trash_size_mb"]),
        },
        "split": {
            "in_projects_mb": float(counts["in_projects_mb"]),
            "unused_mb": float(counts["unused_mb"]),
            "trash_mb": float(counts["trash_size_mb"]),
        },
    }


def _storage_cells(r: Mapping[str, Any]) -> list[object]:
    """A layer's CSV cells. Its type is the type filter's: a feature layer's
    geometry, else the layer type."""
    return [
        r["name"],
        r["geometry_type"] or r["type"],
        r["owner"],
        r["projects"],
        _utc_iso(naive_utc(r["updated_at"])) if r["updated_at"] else None,
        round(float(r["size_mb"]), 3),
    ]


@router.get("/storage-by-layer/export", summary="The storage per layer as CSV")
async def export_storage(
    f: _StorageFilter = Depends(_storage_filter),
    user_id: UUID = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    """Every layer /storage-by-layer lists with the same filters, in its
    order."""
    org = await crud_organization.get_by_user(db, user_id)
    if org is None:
        raise HTTPException(status_code=404, detail="No organization for user")
    if not await _is_admin(db, user_id):
        raise HTTPException(
            status_code=403, detail="Only organization owners and admins"
        )
    sql, params = _storage_query(org, f)
    return StreamingResponse(
        _csv_stream(
            db,
            sql,
            params,
            ["layer", "type", "owner", "projects", "updated", "size_mb"],
            _storage_cells,
        ),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="goat-storage.csv"'},
    )


# What the project list may be sorted by (sort=), as SQL over the project p
# and its output column layers.
_PROJECT_SORTS = {
    "updated": "p.updated_at",
    "name": "lower(p.name)",
    "layers": "layers",
}


@router.get("/projects", summary="The organization's projects")
async def get_org_projects(
    q: str | None = Query(
        None,
        max_length=100,
        description="Only projects whose name holds this text, in any case",
    ),
    owner: UUID | None = Query(None, description="Only this member's projects"),
    sort: Literal["updated", "name", "layers"] = Query(
        "updated", description="updated, name or layers (how many it holds)"
    ),
    direction: Literal["asc", "desc"] = Query(
        "desc", alias="dir", description="The direction of sort"
    ),
    limit: int = Query(10, ge=1, le=100),
    offset: int = Query(0, ge=0),
    user_id: UUID = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """The organization's projects (_of_org), not those in the trash nor the
    hidden copies of project templates (as every project listing), newest
    first unless sorted otherwise, a page at a time (`total` counts the
    matches). `layers` counts its project layers whose layer is not in the
    trash, as the project shows them; owner and owner_id are null for a
    project whose creator was removed. Whatever the filters: `trash`, the
    count of its projects in the trash, which still count against the plan's
    projects (used_projects) until the trash is purged."""
    org = await crud_organization.get_by_user(db, user_id)
    if org is None:
        raise HTTPException(status_code=404, detail="No organization for user")
    # Names and owners of everyone's projects: not for every member.
    if not await _is_admin(db, user_id):
        raise HTTPException(
            status_code=403, detail="Only organization owners and admins"
        )
    schema = core_settings.SCHEMA
    filters, params = [], {"o": str(org.id)}
    q = _search(q)
    if q:
        filters.append("p.name ILIKE :q ESCAPE '\\'")
        params["q"] = _like(q)
    if owner:
        filters.append("p.user_id = :owner")
        params["owner"] = str(owner)
    extra = "".join(f" AND {clause}" for clause in filters)
    projects = f"""
            FROM {schema}.project p
            LEFT JOIN {schema}."user" u ON u.id = p.user_id
            WHERE {_of_org("p", schema)} AND NOT p.is_template_source"""
    of_org = f"{projects} AND p.deleted_at IS NULL{extra}"
    total = (await db.execute(text(f"SELECT count(*) {of_org}"), params)).scalar_one()
    trash = (
        await db.execute(
            text(f"SELECT count(*) {projects} AND p.deleted_at IS NOT NULL"),
            {"o": params["o"]},
        )
    ).scalar_one()
    order = f"{_PROJECT_SORTS[sort]} {_DIRECTIONS[direction]} NULLS LAST, p.id"
    rows = (
        (
            await db.execute(
                text(f"""
            SELECT p.id::text AS project_id, p.name, p.user_id::text AS owner_id,
                   {_PERSON} AS owner,
                   (SELECT count(*) FROM {schema}.layer_project lp
                    JOIN {schema}.layer l
                      ON l.id = lp.layer_id AND l.deleted_at IS NULL
                    WHERE lp.project_id = p.id) AS layers,
                   p.updated_at
            {of_org}
            ORDER BY {order}
            LIMIT :limit OFFSET :offset
        """),
                {**params, "limit": limit, "offset": offset},
            )
        )
        .mappings()
        .all()
    )
    return {
        "rows": [dict(r) | {"updated_at": _iso(r["updated_at"])} for r in rows],
        "total": total,
        "trash": {"count": trash},
    }
