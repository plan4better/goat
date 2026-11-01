import contextlib
import contextvars
import datetime
import gettext
from collections.abc import Iterator
from pathlib import Path

from babel.support import Translations
from jinja2 import Environment, FileSystemLoader

_BASE_DIR = Path(__file__).resolve().parent
LOCALES_DIR = str(_BASE_DIR / "locales")
TEMPLATES_DIR = str(_BASE_DIR / "templates")

# Per task (request), so concurrent requests never see each other's language.
_lang: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "goat_language", default=None
)
DEFAULT_LANGUAGE = "en"
SUPPORTED_LANGUAGES = ["de", "en"]
GERMAN_LANGUAGE_MAP = {
    "de-at": "de",
    "de-ch": "de",
    "de-de": "de",
    "de-li": "de",
    "de-lu": "de",
}


def active_translation(lang: str) -> None:
    """
    Set active translation
    :param lang:
    :return:
    """
    lang = lang.lower() if lang else DEFAULT_LANGUAGE
    if "," in lang:
        lang = lang.split(",")[0]
    if lang in GERMAN_LANGUAGE_MAP:
        lang = GERMAN_LANGUAGE_MAP[lang]
    _lang.set(DEFAULT_LANGUAGE if lang not in SUPPORTED_LANGUAGES else lang)


def current_locale() -> str:
    """
    Get current locale
    :return str:
    """
    return _lang.get() or DEFAULT_LANGUAGE


def trans(message: str) -> str:
    """
    Translate message to the specified language
    :param message:
    :param lang:
    :return str:
    """
    return gettext.translation(
        "messages", localedir=LOCALES_DIR, languages=[current_locale()]
    ).gettext(message)


@contextlib.contextmanager
def language(lang: str | None) -> Iterator[None]:
    """Translate in `lang` (a GOAT language, e.g. the recipient's) inside the block:
    `trans` and the email templates. The language lives in a context variable, so
    it stays with this request even across an await."""
    token = _lang.set(_lang.get())
    active_translation(lang or DEFAULT_LANGUAGE)
    try:
        yield
    finally:
        _lang.reset(token)


template_loader = FileSystemLoader(searchpath=TEMPLATES_DIR)


def _environment(lang: str) -> Environment:
    # Autoescape: titles and messages carry user input such as organization names.
    env = Environment(
        loader=template_loader, extensions=["jinja2.ext.i18n"], autoescape=True
    )
    env.install_gettext_translations(Translations.load(LOCALES_DIR, [lang]))
    env.globals.update(now=datetime.datetime.utcnow, current_locale=current_locale)
    return env


# One environment per language: a template is rendered in the active one.
jinja_envs = {lang: _environment(lang) for lang in SUPPORTED_LANGUAGES}
jinja_env = jinja_envs[DEFAULT_LANGUAGE]


def active_jinja_env() -> Environment:
    return jinja_envs[current_locale()]
