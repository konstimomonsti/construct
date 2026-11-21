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
