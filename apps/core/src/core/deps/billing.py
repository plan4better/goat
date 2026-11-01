from core.core.config import settings
from fastapi import HTTPException, status


def require_billing_enabled() -> None:
    """404 while billing is off (self-hosted, or not configured): credits,
    usage and the billing webhooks do not exist there."""
    if not settings.billing_enabled:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not Found")
