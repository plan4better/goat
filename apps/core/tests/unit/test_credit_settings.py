from core.core.config import settings


def test_credit_operational_settings():
    # Conversion rates are NOT settings (they live in customer.credit_rate);
    # only operational knobs are here.
    assert not hasattr(settings, "CREDIT_RATE_COMPUTE_PER_MINUTE")
    assert settings.MAX_TOOL_RUNTIME_SECONDS == 1800
    # None == unlimited for self-hosted
    assert settings.DEFAULT_QUOTA_CREDITS is None
