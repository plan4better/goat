"""SQL for organization members, AI settings and connections (spec §4.1, §5).

Every connection query is scoped by organization, so another organization's
connection ID behaves like an unknown one. The admin check reads core's role
tables directly, like geoapi reads core's tables (spec §5).
"""

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, cast
from uuid import UUID

import asyncpg

from assistant.db import Database
from assistant.llm.providers import ConnectionFields
from assistant.llm.types import DataPolicy

#: Columns an update may set; everything else is fixed or bookkeeping.
_UPDATABLE = frozenset(
    {
        "name",
        "provider",
        "base_url",
        "region",
        "model",
        "provider_order",
        "allow_fallbacks",
        "credentials_encrypted",
        "capabilities",
    }
)


class NameTaken(Exception):  # noqa: N818
    """The organization already has a connection with this name."""


class ConnectionInUse(Exception):  # noqa: N818
    """The connection is the organization's active one."""


class UnknownConnection(Exception):  # noqa: N818
    """The settings name a connection that does not exist."""


class ConnectionNotTested(Exception):  # noqa: N818
    """Activation refused: the connection has no passed test (any more)."""


@dataclass(frozen=True)
class Member:
    user_id: UUID
    organization_id: UUID
    is_admin: bool


@dataclass(frozen=True)
class OrgSettings:
    organization_id: UUID
    enabled: bool = True
    active_connection_id: UUID | None = None
    #: Restricted until an admin chooses Standard: nothing but metadata leaves
    #: GOAT for an organization that never looked at its AI settings.
    data_policy: DataPolicy = "restricted"
    allow_default_fallback: bool = False


def _settings(record: asyncpg.Record) -> OrgSettings:
    return OrgSettings(
        organization_id=record["organization_id"],
        enabled=record["enabled"],
        active_connection_id=record["active_connection_id"],
        data_policy=cast(DataPolicy, record["data_policy"]),
        allow_default_fallback=record["allow_default_fallback"],
    )


def _row(record: asyncpg.Record | None) -> dict[str, Any] | None:
    return dict(record) if record is not None else None


class OrgSettingsRepository:
    def __init__(self, db: Database) -> None:
        self.db = db

    # -- members -------------------------------------------------------------

    async def member(self, user_id: UUID) -> Member | None:
        """The user's organization and whether they administer it: the
        organization-owner or organization-admin role, the same predicate
        core's ``customer.space_rank`` uses for organization spaces."""
        record = await self.db.pool.fetchrow(
            f"SELECT u.organization_id, EXISTS ("
            f"  SELECT 1 FROM {self.db.customer('user_role')} ur "
            f"  JOIN {self.db.customer('role')} r ON r.id = ur.role_id "
            "   WHERE ur.user_id = u.id "
            "   AND r.name IN ('organization-owner', 'organization-admin')"
            f") AS is_admin FROM {self.db.customer('user')} u WHERE u.id = $1",
            user_id,
        )
        if record is None or record["organization_id"] is None:
            return None
        return Member(
            user_id=user_id,
            organization_id=record["organization_id"],
            is_admin=bool(record["is_admin"]),
        )

    # -- settings ------------------------------------------------------------

    async def get_settings(self, organization_id: UUID) -> OrgSettings:
        record = await self.db.pool.fetchrow(
            f"SELECT * FROM {self.db.t('organization_settings')} WHERE organization_id = $1",
            organization_id,
        )
        return (
            OrgSettings(organization_id=organization_id)
            if record is None
            else _settings(record)
        )

    async def save_settings(
        self,
        organization_id: UUID,
        *,
        enabled: bool,
        active_connection_id: UUID | None,
        data_policy: DataPolicy,
        allow_default_fallback: bool,
        updated_by: UUID | None,
        require_tested: bool = False,
    ) -> OrgSettings:
        """Upsert the settings. With ``require_tested``, the active connection
        must have a passed test, checked in the same statement, so an edit that
        resets the test concurrently cannot slip in between (raises
        ``ConnectionNotTested``)."""
        try:
            record = await self.db.pool.fetchrow(
                f"INSERT INTO {self.db.t('organization_settings')} "
                "(organization_id, enabled, active_connection_id, data_policy, "
                "allow_default_fallback, updated_by) "
                "SELECT $1::uuid, $2::boolean, $3::uuid, $4::text, $5::boolean, $6::uuid "
                f"WHERE $3::uuid IS NULL OR EXISTS (SELECT 1 FROM {self.db.t('connection')} c "
                "WHERE c.id = $3::uuid AND c.organization_id = $1::uuid "
                "AND (NOT $7::boolean OR c.last_test_ok)) "
                "ON CONFLICT (organization_id) DO UPDATE SET "
                "enabled = EXCLUDED.enabled, "
                "active_connection_id = EXCLUDED.active_connection_id, "
                "data_policy = EXCLUDED.data_policy, "
                "allow_default_fallback = EXCLUDED.allow_default_fallback, "
                "updated_by = EXCLUDED.updated_by, updated_at = now() "
                "RETURNING *",
                organization_id,
                enabled,
                active_connection_id,
                data_policy,
                allow_default_fallback,
                updated_by,
                require_tested,
            )
        except asyncpg.ForeignKeyViolationError as exc:
            raise UnknownConnection() from exc
        if record is None:
            # The guard matched nothing: the connection is not this organization's
            # (or does not exist), or, with ``require_tested``, has no passed test.
            if require_tested:
                raise ConnectionNotTested()
            raise UnknownConnection()
        return _settings(record)

    # -- connections ---------------------------------------------------------

    async def list_connections(self, organization_id: UUID) -> list[dict[str, Any]]:
        records = await self.db.pool.fetch(
            f"SELECT * FROM {self.db.t('connection')} WHERE organization_id = $1 "
            "ORDER BY lower(name)",
            organization_id,
        )
        return [dict(r) for r in records]

    async def get_connection(
        self, organization_id: UUID, connection_id: UUID
    ) -> dict[str, Any] | None:
        return _row(
            await self.db.pool.fetchrow(
                f"SELECT * FROM {self.db.t('connection')} "
                "WHERE organization_id = $1 AND id = $2",
                organization_id,
                connection_id,
            )
        )

    async def create_connection(
        self,
        organization_id: UUID,
        *,
        name: str,
        fields: ConnectionFields,
        credentials_encrypted: str,
        capabilities: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        try:
            record = await self.db.pool.fetchrow(
                f"INSERT INTO {self.db.t('connection')} "
                "(organization_id, name, provider, base_url, region, model, "
                "provider_order, allow_fallbacks, credentials_encrypted, capabilities) "
                "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *",
                organization_id,
                name,
                fields.provider,
                fields.base_url,
                fields.region,
                fields.model,
                list(fields.provider_order),
                fields.allow_fallbacks,
                credentials_encrypted,
                capabilities or {},
            )
        except asyncpg.UniqueViolationError as exc:
            raise NameTaken() from exc
        if record is None:
            raise RuntimeError("INSERT ... RETURNING produced no row")
        return dict(record)

    async def update_connection(
        self,
        organization_id: UUID,
        connection_id: UUID,
        changes: Mapping[str, Any],
        *,
        reset_test: bool,
        passed_capabilities: dict[str, Any] | None = None,
        only_if_inactive: bool = False,
    ) -> dict[str, Any] | None:
        """Update a connection and return the row; None when no row matched.

        ``reset_test`` clears the test result (the change needs a new test).
        ``passed_capabilities`` stores a passed test result with the change, in
        the same statement: the new configuration never sits next to an old
        result. ``only_if_inactive`` leaves the row alone when it is the
        organization's active connection, so a concurrent activation of a
        connection whose test this change resets cannot be undone silently."""
        if reset_test and passed_capabilities is not None:
            raise ValueError("A change cannot both reset and record a test")
        if passed_capabilities is not None and "capabilities" in changes:
            raise ValueError("A change cannot set capabilities twice")
        unknown = set(changes) - _UPDATABLE
        if unknown:
            raise ValueError(f"Not updatable: {', '.join(sorted(unknown))}")
        columns = list(changes)
        assignments = [
            f"{column} = ${index}" for index, column in enumerate(columns, start=3)
        ]
        values = [changes[column] for column in columns]
        if passed_capabilities is not None:
            values.append(passed_capabilities)
            assignments += [
                "last_test_at = now()",
                "last_test_ok = true",
                "last_test_error = NULL",
                f"capabilities = ${len(values) + 2}::jsonb",
            ]
        if reset_test:
            assignments += [
                "last_test_at = NULL",
                "last_test_ok = NULL",
                "last_test_error = NULL",
            ]
            if "capabilities" not in changes:
                assignments.append("capabilities = '{}'::jsonb")
        assignments.append("updated_at = now()")
        guard = (
            f" AND NOT EXISTS (SELECT 1 FROM {self.db.t('organization_settings')} s "
            "WHERE s.organization_id = $1 AND s.active_connection_id = $2)"
            if only_if_inactive
            else ""
        )
        try:
            record = await self.db.pool.fetchrow(
                f"UPDATE {self.db.t('connection')} SET {', '.join(assignments)} "
                f"WHERE organization_id = $1 AND id = $2{guard} RETURNING *",
                organization_id,
                connection_id,
                *values,
            )
        except asyncpg.UniqueViolationError as exc:
            raise NameTaken() from exc
        return _row(record)

    async def record_test(
        self,
        organization_id: UUID,
        connection_id: UUID,
        *,
        ok: bool,
        error: str | None,
        capabilities: dict[str, Any] | None,
    ) -> dict[str, Any] | None:
        """Store a Test connection result. A failed test keeps the last
        capability profile (``capabilities=None``)."""
        return _row(
            await self.db.pool.fetchrow(
                f"UPDATE {self.db.t('connection')} SET last_test_at = now(), "
                "last_test_ok = $3, last_test_error = $4, "
                "capabilities = COALESCE($5::jsonb, capabilities) "
                "WHERE organization_id = $1 AND id = $2 RETURNING *",
                organization_id,
                connection_id,
                ok,
                error,
                capabilities,
            )
        )

    async def mark_connection_failed(
        self, organization_id: UUID, connection_id: UUID, error: str
    ) -> None:
        """A run found the credentials rejected: the admin page shows it (§4.6)."""
        await self.db.pool.execute(
            f"UPDATE {self.db.t('connection')} SET last_test_at = now(), "
            "last_test_ok = false, last_test_error = $3 "
            "WHERE organization_id = $1 AND id = $2",
            organization_id,
            connection_id,
            error,
        )

    async def delete_connection(
        self, organization_id: UUID, connection_id: UUID
    ) -> bool:
        try:
            status = await self.db.pool.execute(
                f"DELETE FROM {self.db.t('connection')} WHERE organization_id = $1 AND id = $2",
                organization_id,
                connection_id,
            )
        except (
            asyncpg.RestrictViolationError,
            asyncpg.ForeignKeyViolationError,
        ) as exc:
            # ON DELETE RESTRICT raises 23001, a plain foreign key violation 23503.
            raise ConnectionInUse() from exc
        return bool(status == "DELETE 1")
