"""What the model may answer, and the checks in code that every answer item must pass.

The JSON schemas are sent to the model (structured output). Each answer item is then validated on its
own with Pydantic, so one bad item doesn't discard the whole batch. Anti-hallucination rules:

- references (`line_ref`, `finding_ref`) must be ones we sent in that batch;
- quotes must appear verbatim (whitespace and case aside) in the text of the line they cite;
- confidence is clamped to [0, MAX_CONFIDENCE]: a model is never certain.
"""

from __future__ import annotations

import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

MAX_CONFIDENCE = 0.7


class _Answer(BaseModel):
    model_config = ConfigDict(extra="ignore")


# --------------------------------------------------------------------------- short/long contradiction


CONTRADICTION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["findings"],
    "properties": {
        "findings": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["line_ref", "property", "short_quote", "long_quote", "message", "confidence"],
                "properties": {
                    "line_ref": {"type": "string", "description": "ref of the item, e.g. \"#3\""},
                    "property": {"type": "string", "description": "what differs, e.g. nominal diameter"},
                    "short_quote": {"type": "string", "description": "exact words from the short text"},
                    "long_quote": {"type": "string", "description": "exact words from the long text"},
                    "message": {"type": "string", "description": "one English sentence"},
                    "confidence": {"type": "number", "description": "0 to 1"},
                },
            },
        },
    },
}


class ContradictionItem(_Answer):
    line_ref: str
    property: str = Field(min_length=1)
    short_quote: str = Field(min_length=1)
    long_quote: str = Field(min_length=1)
    message: str = Field(min_length=1)
    confidence: float


# --------------------------------------------------------------------------- layer 2 confirmation


VERDICTS = ("missing", "included", "excluded", "unclear")

L2_CONFIRM_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["reviews"],
    "properties": {
        "reviews": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["finding_ref", "verdict", "line_ref", "quote", "reason", "confidence"],
                "properties": {
                    "finding_ref": {"type": "string", "description": "ref of the finding, e.g. \"F1\""},
                    "verdict": {"type": "string", "enum": list(VERDICTS)},
                    "line_ref": {"type": "string",
                                 "description": "item that shows included/excluded, else empty"},
                    "quote": {"type": "string",
                              "description": "exact words from that item's text, else empty"},
                    "reason": {"type": "string", "description": "one English sentence"},
                    "confidence": {"type": "number", "description": "0 to 1"},
                },
            },
        },
    },
}


class L2Review(_Answer):
    finding_ref: str
    verdict: Literal["missing", "included", "excluded", "unclear"]
    line_ref: str = ""
    quote: str = ""
    reason: str = Field(min_length=1)
    confidence: float


# --------------------------------------------------------------------------- precast extraction (spec Step 2)


ITEM_TYPES = ("sandwich_plinth", "precast_element", "shop_drawings", "rebar", "opening_surcharge",
              "embedded_part", "other")
REBAR_PURPOSES = ("factory_reinforcement", "site_connection", "both", "unspecified", "not_applicable")


def _nullable(kind: str, description: str) -> dict[str, Any]:
    return {"type": [kind, "null"], "description": description}


_LAYERS_SCHEMA: dict[str, Any] = {
    "type": ["object", "null"],
    "additionalProperties": False,
    "required": ["facing_shell_cm", "insulation_cm", "insulation_material", "structural_shell_cm",
                 "total_thickness_cm"],
    "properties": {
        "facing_shell_cm": _nullable("number", "Dicke Vorsatzschale in cm"),
        "insulation_cm": _nullable("number", "Dicke Dämmschicht in cm"),
        "insulation_material": _nullable("string", "e.g. \"XPS, WLG 035\""),
        "structural_shell_cm": _nullable("number", "Dicke Tragschale in cm"),
        "total_thickness_cm": _nullable("number", "Gesamtdicke d in cm"),
    },
}

_PRECAST_ITEM_PROPERTIES: dict[str, Any] = {
    "line_ref": {"type": "string", "description": "ref of the item, e.g. \"#3\""},
    "item_type": {"type": "string", "enum": list(ITEM_TYPES)},
    "element_code": _nullable("string", "element mark as written, e.g. \"FS 01\""),
    "length_m": _nullable("number", "length in m, only if written"),
    "height_m": _nullable("number", "height in m, only if written"),
    "layers": _LAYERS_SCHEMA,
    "concrete_grade": _nullable("string", "e.g. \"C35/45\""),
    "exposure_classes": {"type": "array", "items": {"type": "string"}, "description": "e.g. [\"XC2\", \"XF2\"]"},
    "surface_inside": _nullable("string", "e.g. \"SB2\""),
    "surface_outside": _nullable("string", "e.g. \"SB2\""),
    "is_through_colored": {"type": "boolean"},
    "color_pigment_ral": _nullable("string", "exact RAL colour or pigment, only if written"),
    "includes_transport_and_mounting": {"type": "boolean"},
    "includes_anchor_engineering": {"type": "boolean"},
    "axis_location": _nullable("string", "Einbauort, e.g. \"Achse D/1\""),
    "has_redacted_or_unclear_text": {"type": "boolean"},
    "unclear_text_evidence": _nullable("string", "exact snippet with the placeholder or question mark"),
    "rebar_purpose": {"type": "string", "enum": list(REBAR_PURPOSES)},
    "assigned_element_codes": {"type": "array", "items": {"type": "string"},
                               "description": "element marks this item is explicitly assigned to"},
}

PRECAST_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["items"],
    "properties": {
        "items": {
            "type": "array",
            "items": {"type": "object", "additionalProperties": False,
                      "required": list(_PRECAST_ITEM_PROPERTIES), "properties": _PRECAST_ITEM_PROPERTIES},
        },
    },
}


class LayerSpec(_Answer):
    facing_shell_cm: float | None = None
    insulation_cm: float | None = None
    insulation_material: str | None = None
    structural_shell_cm: float | None = None
    total_thickness_cm: float | None = None


class PrecastItem(_Answer):
    """Spec §3 `PrecastElementItem` minus the fields taken from the line itself (oz, quantity, unit)."""
    line_ref: str
    item_type: Literal["sandwich_plinth", "precast_element", "shop_drawings", "rebar", "opening_surcharge",
                       "embedded_part", "other"]
    element_code: str | None = None
    length_m: float | None = None
    height_m: float | None = None
    layers: LayerSpec | None = None
    concrete_grade: str | None = None
    exposure_classes: list[str] = Field(default_factory=list)
    surface_inside: str | None = None
    surface_outside: str | None = None
    is_through_colored: bool = False
    color_pigment_ral: str | None = None
    includes_transport_and_mounting: bool = False
    includes_anchor_engineering: bool = False
    axis_location: str | None = None
    has_redacted_or_unclear_text: bool = False
    unclear_text_evidence: str | None = None
    rebar_purpose: Literal["factory_reinforcement", "site_connection", "both", "unspecified",
                           "not_applicable"] = "not_applicable"
    assigned_element_codes: list[str] = Field(default_factory=list)


# --------------------------------------------------------------------------- cross-item scope audit (spec Step 4)


SCOPE_CHECKS = ("REBAR_AMBIGUOUS", "SHOP_DRAWINGS_OVERLAP", "EMBEDDED_UNALLOCATED")

SCOPE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["findings"],
    "properties": {
        "findings": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["check", "line_code", "related_codes", "message", "bieterfrage_de", "confidence"],
                "properties": {
                    "check": {"type": "string", "enum": list(SCOPE_CHECKS)},
                    "line_code": {"type": "string", "description": "OZ of the item the finding is about"},
                    "related_codes": {"type": "array", "items": {"type": "string"},
                                      "description": "OZ of the other items involved"},
                    "message": {"type": "string", "description": "one or two English sentences"},
                    "bieterfrage_de": {"type": "string",
                                       "description": "formal German question, starting \"Zu Pos. <OZ>: \""},
                    "confidence": {"type": "number", "description": "0 to 1"},
                },
            },
        },
    },
}


class ScopeItem(_Answer):
    check: Literal["REBAR_AMBIGUOUS", "SHOP_DRAWINGS_OVERLAP", "EMBEDDED_UNALLOCATED"]
    line_code: str
    related_codes: list[str] = Field(default_factory=list)
    message: str = Field(min_length=1)
    bieterfrage_de: str = Field(min_length=1)
    confidence: float


# --------------------------------------------------------------------------- underspecified text


MISSING_PROPERTIES = ("dimension", "thickness", "material", "strength_class", "exposure_class", "surface_finish",
                      "colour", "fire_rating", "product_type", "installation_location", "scope_of_work")
MAX_UNDERSPECIFIED_CONFIDENCE = 0.6

UNDERSPECIFIED_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["findings"],
    "properties": {
        "findings": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["line_ref", "missing_property", "quote", "question_de", "confidence"],
                "properties": {
                    "line_ref": {"type": "string", "description": "ref of the item, e.g. \"#3\""},
                    "missing_property": {"type": "string", "enum": list(MISSING_PROPERTIES)},
                    "quote": {"type": "string", "description": "exact words from the item that need the value"},
                    "question_de": {"type": "string", "description": "formal German question to the client"},
                    "confidence": {"type": "number", "description": "0 to 1"},
                },
            },
        },
    },
}


class UnderspecifiedItem(_Answer):
    line_ref: str
    missing_property: Literal["dimension", "thickness", "material", "strength_class", "exposure_class",
                              "surface_finish", "colour", "fire_rating", "product_type",
                              "installation_location", "scope_of_work"]
    quote: str = Field(min_length=1)
    question_de: str = Field(min_length=1)
    confidence: float


# --------------------------------------------------------------------------- implausible quantity


QUANTITY_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["findings"],
    "properties": {
        "findings": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["line_ref", "reason", "expected", "confidence"],
                "properties": {
                    "line_ref": {"type": "string", "description": "ref of the item, e.g. \"#3\""},
                    "reason": {"type": "string", "description": "one English sentence"},
                    "expected": {"type": "string", "description": "plausible order of magnitude, e.g. \"~1 psch\""},
                    "confidence": {"type": "number", "description": "0 to 1"},
                },
            },
        },
    },
}


class QuantityItem(_Answer):
    line_ref: str
    reason: str = Field(min_length=1)
    expected: str = ""
    confidence: float


# --------------------------------------------------------------------------- helpers


def items(answer: dict[str, Any], key: str, model: type[_Answer]) -> tuple[list[Any], int]:
    """Validate each item of answer[key]. Returns (valid items, number dropped)."""
    raw = answer.get(key)
    if not isinstance(raw, list):
        return [], 1 if raw is not None else 0
    valid, dropped = [], 0
    for entry in raw:
        try:
            valid.append(model.model_validate(entry))
        except ValidationError:
            dropped += 1
    return valid, dropped


def clamp_confidence(value: float) -> float:
    if value != value:  # NaN
        return 0.0
    return round(max(0.0, min(MAX_CONFIDENCE, float(value))), 2)


_SPACE = re.compile(r"\s+")
# Line-break hyphenation in GAEB long texts: "erforder- lich" -> "erforderlich".
_SOFT_HYPHEN = re.compile(r"(?<=[a-zäöüß])- (?=[a-zäöüß])")


def normalize(text: str | None) -> str:
    text = _SPACE.sub(" ", (text or "").replace("­", "")).strip().casefold()
    return _SOFT_HYPHEN.sub("", text)


def quote_in(quote: str, *texts: str | None) -> bool:
    """True when the quote appears verbatim in one of the texts (whitespace, case, line hyphens aside).

    The quote must carry at least one letter or digit, so "..." or "-" can't pass.
    """
    needle = normalize(quote).strip(" .,;:\"'„“”")
    if not needle or not re.search(r"\w", needle):
        return False
    return any(needle in normalize(text) for text in texts if text)


def value_in(value: str | None, *texts: str | None) -> bool:
    """True when a short value ("C35/45", "RAL 7016", "FS 01") is written in one of the texts, ignoring
    all whitespace and case (so "C 35/45" matches "C35/45")."""
    needle = re.sub(r"\s+", "", normalize(value))
    return bool(needle) and any(needle in re.sub(r"\s+", "", normalize(text)) for text in texts if text)
