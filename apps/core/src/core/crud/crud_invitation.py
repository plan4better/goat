import json
from datetime import datetime

from sqlalchemy import and_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from core.core.config import settings
from core.crud.base import CRUDBase
from core.db.models.invitation import (
    Invitation,
    InvitationStatusEnum,
    InvitationType,
)
from core.schemas.entitlement import naive_utc
from core.schemas.invitations import (
    InvitationCreate,
    InvitationUpdate,
)


class CRUDInvitation(CRUDBase[Invitation, InvitationCreate, InvitationUpdate]):
    async def query_by_payload_attribute(
        self, db: AsyncSession, *, type: InvitationType, key: str, value: str
    ) -> list[Invitation]:
        query = select(self.model).where(
            and_(self.model.type == type, self.model.payload[key].astext == value)
        )
        result = await db.execute(query)
        result = result.scalars().all()
        return result

    async def claim_send(
        self, db: AsyncSession, *, invitation: Invitation, sent_at: datetime
    ) -> bool:
        """Stamp `last_sent_at` on a pending invitation, provided the stored
        stamp is still the one `invitation` was read with (none read, none
        stored). True when this call took the slot.

        One statement, a compare-and-set: of two sends that read the same
        stamp only one wins, also across pods. Only that key is merged into
        the payload, so a change to the rest made meanwhile (a new role) stays.
        The stamps are compared as JSON values, so any stored value compares
        exactly as read.
        """
        payload = invitation.payload or {}
        seen = (
            json.dumps(payload["last_sent_at"]) if "last_sent_at" in payload else None
        )
        claimed = await db.execute(
            text(
                f"UPDATE {settings.SCHEMA}.invitation "
                "SET payload = payload "
                "|| jsonb_build_object('last_sent_at', CAST(:sent_at AS text)) "
                "WHERE id = :id AND status = :pending "
                "AND payload -> 'last_sent_at' IS NOT DISTINCT FROM CAST(:seen AS jsonb) "
                "RETURNING id"
            ),
            {
                "id": invitation.id,
                "pending": InvitationStatusEnum.pending.value,
                "sent_at": sent_at.isoformat(),
                "seen": seen,
            },
        )
        taken = claimed.first() is not None
        await db.commit()
        return taken


def last_sent_at(invitation: Invitation) -> datetime | None:
    """When the invitation's mail last went out, naive UTC: the payload's
    `last_sent_at` (written by the invite and by every resend), else the
    invitation's `created_at` (invitations made before resending existed)."""
    value = (invitation.payload or {}).get("last_sent_at")
    if isinstance(value, str):
        try:
            return naive_utc(datetime.fromisoformat(value))
        except ValueError:
            pass
    return invitation.created_at


invitation = CRUDInvitation(Invitation)
