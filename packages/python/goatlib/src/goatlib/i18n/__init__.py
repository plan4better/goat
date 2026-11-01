"""Translation system for tool schemas.

This module provides translation resolution for tool metadata,
enabling internationalization of field labels, descriptions,
and section names in the OGC Processes API responses.

Example usage:
    from goatlib.i18n import get_translator, resolve_schema_translations

    # Get translator for a language
    translator = get_translator("de")
    label = translator.get_field_label("routing_mode")  # "Verkehrsmittel"

    # Resolve translations in a JSON schema
    schema = MyParams.model_json_schema()
    resolved = resolve_schema_translations(schema, language="de")
"""

import json
import logging
from functools import lru_cache
from pathlib import Path
from typing import Any, Self

logger = logging.getLogger(__name__)

# Directory containing translation files
TRANSLATIONS_DIR = Path(__file__).parent / "translations"

# Supported languages (ISO 639-1 codes)
SUPPORTED_LANGUAGES = ("en", "de")
DEFAULT_LANGUAGE = "en"
# The translation file of each supported language: the file read is the one
# looked up here, never a name built from the requested language.
_TRANSLATION_FILES = {language: f"{language}.json" for language in SUPPORTED_LANGUAGES}


class Translator:
    """Translation resolver for tool schemas.

    Loads translations from JSON files and provides methods to resolve
    labels and descriptions for fields, sections, and enums.
    """

    def __init__(self: Self, language: str = DEFAULT_LANGUAGE) -> None:
        """Initialize translator with specified language.

        Args:
            language: ISO 639-1 language code (e.g., "en", "de")
        """
        self.language = (
            language if language in SUPPORTED_LANGUAGES else DEFAULT_LANGUAGE
        )
        self._translations = self._load_translations()

    def _load_translations(self: Self) -> dict[str, Any]:
        """Load translations from JSON file."""
        file_path = TRANSLATIONS_DIR / _TRANSLATION_FILES[self.language]

        if not file_path.exists():
            logger.warning(
                f"Translation file not found: {file_path}, falling back to {DEFAULT_LANGUAGE}"
            )
            file_path = TRANSLATIONS_DIR / _TRANSLATION_FILES[DEFAULT_LANGUAGE]

        try:
            with open(file_path, encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            logger.error(f"Failed to load translations from {file_path}: {e}")
            return {}

    def get_section(self: Self, section_id: str) -> dict[str, str]:
        """Get section translation.

        Args:
            section_id: Section identifier (e.g., "routing")

        Returns:
            Dict with 'label' key, or empty dict if not found
        """
        return self._translations.get("sections", {}).get(section_id, {})

    def get_section_label(self: Self, section_id: str) -> str | None:
        """Get translated section label.

        Args:
            section_id: Section identifier

        Returns:
            Translated label or None if not found
        """
        return self.get_section(section_id).get("label")

    def get_field(self: Self, field_name: str) -> dict[str, str]:
        """Get field translation.

        Args:
            field_name: Field name (e.g., "routing_mode")

        Returns:
            Dict with 'label' and 'description' keys
        """
        return self._translations.get("fields", {}).get(field_name, {})

    def get_field_label(self: Self, field_name: str) -> str | None:
        """Get translated field label.

        Args:
            field_name: Field name

        Returns:
            Translated label or None if not found
        """
        return self.get_field(field_name).get("label")

    def get_field_description(self: Self, field_name: str) -> str | None:
        """Get translated field description.

        Args:
            field_name: Field name

        Returns:
            Translated description or None if not found
        """
        return self.get_field(field_name).get("description")

    def get_enum_value(self: Self, enum_name: str, value: str) -> str | None:
        """Get translated enum value label.

        Args:
            enum_name: Enum type name (e.g., "routing_mode")
            value: Enum value (e.g., "walking")

        Returns:
            Translated enum value label or None if not found
        """
        return self._translations.get("enums", {}).get(enum_name, {}).get(value)

    def get_tool(self: Self, tool_name: str) -> dict[str, str]:
        """Get tool translation.

        Args:
            tool_name: Tool identifier (e.g., "buffer")

        Returns:
            Dict with 'title' and 'description' keys
        """
        return self._translations.get("tools", {}).get(tool_name, {})

    def get_tool_title(self: Self, tool_name: str) -> str | None:
        """Get translated tool title.

        Args:
            tool_name: Tool identifier

        Returns:
            Translated title or None if not found
        """
        return self.get_tool(tool_name).get("title")

    def get_tool_description(self: Self, tool_name: str) -> str | None:
        """Get translated tool description.

        Args:
            tool_name: Tool identifier

        Returns:
            Translated description or None if not found
        """
        return self.get_tool(tool_name).get("description")

    def get_default_layer_name(self: Self, layer_key: str) -> str | None:
        """Get translated default layer name.

        Args:
            layer_key: Layer name key (e.g., "buffer", "catchment_area")

        Returns:
            Translated default layer name or None if not found
        """
        return self._translations.get("default_layer_names", {}).get(layer_key)

    def resolve_key(self: Self, key: str) -> str | None:
        """Resolve a dot-separated translation key path.

        Navigates the translation dictionary using dot notation.
        E.g., "routing_modes.walking" -> translations["routing_modes"]["walking"]

        Args:
            key: Dot-separated key path

        Returns:
            Translated string or None if not found
        """
        parts = key.split(".")
        current: Any = self._translations

        for part in parts:
            if not isinstance(current, dict):
                return None
            current = current.get(part)
            if current is None:
                return None

        return current if isinstance(current, str) else None


@lru_cache(maxsize=8)
def get_translator(language: str = DEFAULT_LANGUAGE) -> Translator:
    """Get cached translator for a language.

    Args:
        language: ISO 639-1 language code

    Returns:
        Translator instance (cached)
    """
    return Translator(language)


def resolve_schema_translations(
    schema: dict[str, Any],
    language: str = DEFAULT_LANGUAGE,
    translator: Translator | None = None,
) -> dict[str, Any]:
    """Resolve translation keys in a JSON schema.

    This function walks through a JSON schema and replaces `label_key`
    and `description_key` in `x-ui` metadata with actual translated strings.
    It also resolves section labels and can translate enum values.

    Args:
        schema: JSON schema dict (from model_json_schema())
        language: Target language code
        translator: Optional pre-loaded translator instance

    Returns:
        Schema with translations resolved (new dict, original unchanged)
    """
    if translator is None:
        translator = get_translator(language)

    result = _deep_copy_dict(schema)

    # Resolve x-ui-sections at top level
    if "x-ui-sections" in result:
        result["x-ui-sections"] = [
            _resolve_section(section, translator) for section in result["x-ui-sections"]
        ]

    # Resolve properties
    if "properties" in result:
        result["properties"] = {
            name: _resolve_property(name, prop, translator)
            for name, prop in result["properties"].items()
        }

    # Resolve $defs (nested models)
    if "$defs" in result:
        result["$defs"] = {
            name: resolve_schema_translations(defn, language, translator)
            for name, defn in result["$defs"].items()
        }

    return result


def _deep_copy_dict(d: dict[str, Any]) -> dict[str, Any]:
    """Create a deep copy of a dict (simple implementation)."""
    result = {}
    for key, value in d.items():
        if isinstance(value, dict):
            result[key] = _deep_copy_dict(value)
        elif isinstance(value, list):
            result[key] = [
                _deep_copy_dict(item) if isinstance(item, dict) else item
                for item in value
            ]
        else:
            result[key] = value
    return result


def _resolve_section(section: dict[str, Any], translator: Translator) -> dict[str, Any]:
    """Resolve translations for a section definition."""
    result = dict(section)
    section_id = section.get("id", "")

    # Resolve label_key to label
    if "label_key" in result:
        label = translator.get_section_label(result["label_key"])
        if label:
            result["label"] = label
        del result["label_key"]
    elif "label" not in result:
        # Try to get label from section id
        label = translator.get_section_label(section_id)
        if label:
            result["label"] = label

    return result


def _resolve_property(
    field_name: str,
    prop: dict[str, Any],
    translator: Translator,
) -> dict[str, Any]:
    """Resolve translations for a property definition."""
    result = _deep_copy_dict(prop)

    # Get field translations
    field_trans = translator.get_field(field_name)

    # Track label_key for potential description lookup
    label_key = None

    # Resolve x-ui metadata
    if "x-ui" in result:
        x_ui = result["x-ui"]

        # Resolve label_key
        if "label_key" in x_ui:
            label_key = x_ui["label_key"]
            label = translator.get_field_label(label_key)
            if label:
                x_ui["label"] = label
            del x_ui["label_key"]
        elif field_trans.get("label"):
            # Apply translation if available
            x_ui["label"] = field_trans["label"]

        # Resolve description_key (or fallback to label_key for description)
        if "description_key" in x_ui:
            desc = translator.get_field_description(x_ui["description_key"])
            if desc:
                x_ui["description"] = desc
            del x_ui["description_key"]
        elif field_trans.get("description"):
            # Apply translation if available
            x_ui["description"] = field_trans["description"]
        elif label_key:
            # Fallback: use label_key to also get description
            desc = translator.get_field_description(label_key)
            if desc:
                x_ui["description"] = desc

        # Resolve enum_labels: translate keys like "routing_modes.walking" to actual text
        if "enum_labels" in x_ui:
            enum_labels = x_ui["enum_labels"]
            resolved_labels: dict[str, str] = {}
            for enum_value, label_key_path in enum_labels.items():
                translated = translator.resolve_key(label_key_path)
                if translated:
                    resolved_labels[enum_value] = translated
                else:
                    # Fallback: use the key path as-is if translation not found
                    resolved_labels[enum_value] = label_key_path
            x_ui["enum_labels"] = resolved_labels

        # Resolve group_label if it's a dot-separated translation key path
        if "group_label" in x_ui:
            translated = translator.resolve_key(x_ui["group_label"])
            if translated:
                x_ui["group_label"] = translated

        # Resolve default value based on language if widget_options contains default_XX
        if "widget_options" in x_ui:
            lang_key = f"default_{translator.language}"
            if lang_key in x_ui["widget_options"]:
                # Set the schema default to the language-specific value
                result["default"] = x_ui["widget_options"][lang_key]
                # Clean up the language-specific defaults from widget_options
                x_ui["widget_options"].pop("default_en", None)
                x_ui["widget_options"].pop("default_de", None)

    # Apply translations to top-level title/description (override defaults)
    # First check if label_key was provided and resolved in x-ui
    if "x-ui" in result and result["x-ui"].get("label"):
        result["title"] = result["x-ui"]["label"]
    elif field_trans.get("label"):
        result["title"] = field_trans["label"]

    if field_trans.get("description"):
        result["description"] = field_trans["description"]

    # Handle nested items (for arrays)
    if "items" in result and isinstance(result["items"], dict):
        if "$ref" not in result["items"]:
            # Inline item schema - recursively resolve
            result["items"] = _resolve_property("", result["items"], translator)

    return result


def get_supported_languages() -> tuple[str, ...]:
    """Get tuple of supported language codes."""
    return SUPPORTED_LANGUAGES


def is_language_supported(language: str) -> bool:
    """Check if a language is supported."""
    return language in SUPPORTED_LANGUAGES
