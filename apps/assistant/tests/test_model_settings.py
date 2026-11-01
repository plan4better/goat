"""Model-layer settings (spec §4.1, §13) and stored credentials (§4.4)."""

from uuid import UUID

import pytest
from cryptography.fernet import Fernet
from pydantic import SecretStr

from assistant.config import AssistantSettings
from assistant.db import Database
from assistant.llm.types import PROVIDER_TYPES
from assistant.llm.vault import CredentialsUnreadable, SecretBox, rotate_all

ORG = UUID(int=100)

_MODEL_ENV = (
    "ASSISTANT_DEFAULT_PROVIDER",
    "ASSISTANT_DEFAULT_MODEL",
    "ASSISTANT_DEFAULT_BASE_URL",
    "ASSISTANT_DEFAULT_API_KEY",
    "ASSISTANT_DEFAULT_REGION",
    "ASSISTANT_DEFAULT_HOSTED_IN",
    "ASSISTANT_ALLOW_ORG_CONNECTIONS",
    "ASSISTANT_ALLOWED_PROVIDERS",
    "ASSISTANT_ALLOW_PRIVATE_ENDPOINTS",
    "ASSISTANT_SECRETS_KEY",
)


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> pytest.MonkeyPatch:
    """A clean environment for the settings class: the root .env may set any of these."""
    monkeypatch.setenv("AUTH", "false")
    for name in _MODEL_ENV:
        monkeypatch.delenv(name, raising=False)
    return monkeypatch


def test_model_defaults(env: pytest.MonkeyPatch) -> None:
    settings = AssistantSettings()
    assert settings.default_provider == "none"
    assert settings.default_model == ""
    assert settings.allow_org_connections is True
    assert settings.allowed_providers == list(PROVIDER_TYPES)
    assert settings.allow_private_endpoints is False
    assert settings.secrets_keys() == []
    assert settings.default_hosted_in == ""


def test_the_hosting_place_is_trimmed(env: pytest.MonkeyPatch) -> None:
    env.setenv("ASSISTANT_DEFAULT_HOSTED_IN", "  EU ")
    assert AssistantSettings().default_hosted_in == "EU"


def test_test_provider_selects_test_or_demo(env: pytest.MonkeyPatch) -> None:
    env.setenv("ASSISTANT_DEFAULT_PROVIDER", "test")
    assert AssistantSettings().default_model == "test"
    env.setenv("ASSISTANT_DEFAULT_MODEL", "demo")
    assert AssistantSettings().default_model == "demo"
    env.setenv("ASSISTANT_DEFAULT_MODEL", "gpt-4.1")
    with pytest.raises(ValueError, match="'test' or 'demo'"):
        AssistantSettings()


@pytest.mark.parametrize(
    ("provider", "missing"),
    [
        ("openai", "ASSISTANT_DEFAULT_API_KEY"),
        ("anthropic", "ASSISTANT_DEFAULT_API_KEY"),
        ("openai_compatible", "ASSISTANT_DEFAULT_BASE_URL"),
        ("azure_openai", "ASSISTANT_DEFAULT_BASE_URL"),
        ("bedrock", "ASSISTANT_DEFAULT_REGION"),
        ("vertex", "ASSISTANT_DEFAULT_REGION"),
    ],
)
def test_goat_ai_needs_the_fields_of_its_provider(
    env: pytest.MonkeyPatch, provider: str, missing: str
) -> None:
    env.setenv("ASSISTANT_DEFAULT_PROVIDER", provider)
    env.setenv("ASSISTANT_DEFAULT_MODEL", "claude-sonnet-4-5")
    with pytest.raises(ValueError, match=missing):
        AssistantSettings()


@pytest.mark.parametrize(
    ("provider", "base_url", "message"),
    [
        ("bedrock", "https://bedrock.example.org", "not used"),
        ("vertex", "https://vertex.example.org", "not used"),
        ("azure_openai", "https://res.openai.azure.com", "v1 endpoint"),
    ],
)
def test_goat_ai_base_url_rules(
    env: pytest.MonkeyPatch, provider: str, base_url: str, message: str
) -> None:
    env.setenv("ASSISTANT_DEFAULT_PROVIDER", provider)
    env.setenv("ASSISTANT_DEFAULT_MODEL", "claude-sonnet-4-5")
    env.setenv("ASSISTANT_DEFAULT_REGION", "eu-central-1")
    env.setenv("ASSISTANT_DEFAULT_API_KEY", "key")
    env.setenv("ASSISTANT_DEFAULT_BASE_URL", base_url)
    with pytest.raises(ValueError, match=message):
        AssistantSettings()
    if provider == "azure_openai":
        env.setenv(
            "ASSISTANT_DEFAULT_BASE_URL", "https://res.openai.azure.com/openai/v1/"
        )
        assert AssistantSettings().default_base_url.endswith("/openai/v1/")


def test_goat_ai_needs_a_model(env: pytest.MonkeyPatch) -> None:
    env.setenv("ASSISTANT_DEFAULT_PROVIDER", "anthropic")
    env.setenv("ASSISTANT_DEFAULT_API_KEY", "sk-ant-test")
    with pytest.raises(ValueError, match="ASSISTANT_DEFAULT_MODEL"):
        AssistantSettings()


def test_bedrock_goat_ai_uses_the_aws_credential_chain(
    env: pytest.MonkeyPatch,
) -> None:
    env.setenv("ASSISTANT_DEFAULT_PROVIDER", "bedrock")
    env.setenv(
        "ASSISTANT_DEFAULT_MODEL", "eu.anthropic.claude-sonnet-4-5-20250929-v1:0"
    )
    env.setenv("ASSISTANT_DEFAULT_REGION", "eu-central-1")
    settings = AssistantSettings()  # no key needed
    assert settings.default_api_key.get_secret_value() == ""


def test_allowed_providers_from_a_comma_separated_list(
    env: pytest.MonkeyPatch,
) -> None:
    env.setenv("ASSISTANT_ALLOWED_PROVIDERS", "openai, openai_compatible")
    assert AssistantSettings().allowed_providers == ["openai", "openai_compatible"]
    env.setenv("ASSISTANT_ALLOWED_PROVIDERS", "openai,gemini")
    with pytest.raises(ValueError):
        AssistantSettings()


def test_secrets_key_must_be_fernet_keys(env: pytest.MonkeyPatch) -> None:
    env.setenv("ASSISTANT_SECRETS_KEY", "not-a-key")
    with pytest.raises(ValueError, match="ASSISTANT_SECRETS_KEY"):
        AssistantSettings()
    new, old = Fernet.generate_key().decode(), Fernet.generate_key().decode()
    env.setenv("ASSISTANT_SECRETS_KEY", f"{new}, {old}")
    assert AssistantSettings().secrets_keys() == [new, old]


def test_secret_box_round_trip_and_a_wrong_key() -> None:
    box = SecretBox([Fernet.generate_key().decode()])
    token = box.encrypt({"api_key": "sk-plain-1234"})
    assert "sk-plain" not in token
    assert box.decrypt(token) == {"api_key": "sk-plain-1234"}
    with pytest.raises(CredentialsUnreadable):
        SecretBox([Fernet.generate_key().decode()]).decrypt(token)
    with pytest.raises(CredentialsUnreadable):
        box.decrypt("garbage")


def test_secret_box_from_settings(settings: AssistantSettings) -> None:
    assert SecretBox.from_settings(settings) is not None
    assert (
        SecretBox.from_settings(
            settings.model_copy(update={"secrets_key": SecretStr("")})
        )
        is None
    )


async def test_rotation_re_encrypts_with_the_newest_key(db: Database) -> None:
    old, new = Fernet.generate_key().decode(), Fernet.generate_key().decode()
    token = SecretBox([old]).encrypt({"api_key": "sk-rotate-1234"})
    insert = (
        f"INSERT INTO {db.t('connection')} "
        "(organization_id, name, provider, model, credentials_encrypted) "
        "VALUES ($1, $2, 'openai', 'gpt-test', $3)"
    )
    await db.pool.execute(insert, ORG, "Readable", token)
    await db.pool.execute(insert, ORG, "Unreadable", "garbage")

    assert await rotate_all(db, SecretBox([new, old])) == (1, 1)

    stored = await db.pool.fetchval(
        f"SELECT credentials_encrypted FROM {db.t('connection')} WHERE name = 'Readable'"
    )
    assert SecretBox([new]).decrypt(stored) == {"api_key": "sk-rotate-1234"}


def _assert_hidden(error: ValueError, marker: str) -> None:
    text = str(error)
    assert marker not in text
    assert marker[-8:] not in text


def test_a_malformed_secrets_key_does_not_leak_into_the_error(
    env: pytest.MonkeyPatch,
) -> None:
    marker = "SECRETKEYMARKER-0123456789abcdef"
    env.setenv("ASSISTANT_SECRETS_KEY", marker)
    with pytest.raises(ValueError, match="ASSISTANT_SECRETS_KEY") as exc:
        AssistantSettings()
    _assert_hidden(exc.value, marker)


def test_a_bad_base_url_does_not_leak_the_api_key_into_the_error(
    env: pytest.MonkeyPatch,
) -> None:
    marker = "APIKEYMARKER-0123456789abcdef"
    env.setenv("ASSISTANT_DEFAULT_PROVIDER", "azure_openai")
    env.setenv("ASSISTANT_DEFAULT_MODEL", "gpt-4.1")
    env.setenv("ASSISTANT_DEFAULT_BASE_URL", "https://res.openai.azure.com")
    env.setenv("ASSISTANT_DEFAULT_API_KEY", marker)
    with pytest.raises(ValueError, match="v1 endpoint") as exc:
        AssistantSettings()
    _assert_hidden(exc.value, marker)


def test_valid_settings_do_not_print_their_secrets(env: pytest.MonkeyPatch) -> None:
    api_key = "APIKEYMARKER-0123456789abcdef"
    fernet_key = Fernet.generate_key().decode()
    env.setenv("ASSISTANT_DEFAULT_PROVIDER", "anthropic")
    env.setenv("ASSISTANT_DEFAULT_MODEL", "claude-sonnet-4-5")
    env.setenv("ASSISTANT_DEFAULT_API_KEY", api_key)
    env.setenv("ASSISTANT_SECRETS_KEY", fernet_key)
    settings = AssistantSettings()
    for text in (
        repr(settings),
        str(settings.model_dump()),
        settings.model_dump_json(),
    ):
        for secret in (api_key, fernet_key):
            assert secret not in text
            assert secret[-8:] not in text


@pytest.mark.parametrize("value", [",", " ", " , ,"])
def test_a_secrets_key_without_any_key_is_malformed(
    env: pytest.MonkeyPatch, value: str
) -> None:
    env.setenv("ASSISTANT_SECRETS_KEY", value)
    with pytest.raises(ValueError, match="ASSISTANT_SECRETS_KEY"):
        AssistantSettings()


def test_an_empty_secrets_key_means_not_set(env: pytest.MonkeyPatch) -> None:
    env.setenv("ASSISTANT_SECRETS_KEY", "")
    assert AssistantSettings().secrets_keys() == []


def test_decrypted_payload_must_be_a_json_object() -> None:
    key = Fernet.generate_key().decode()
    box = SecretBox([key])
    fernet = Fernet(key.encode())
    for payload in (b"[1, 2]", b'"text"', b"42", b"not json"):
        with pytest.raises(CredentialsUnreadable):
            box.decrypt(fernet.encrypt(payload).decode())
