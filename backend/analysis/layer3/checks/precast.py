"""Precast extraction (spec Step 2) and the checks that run on the extracted fields.

`extracted(ctx)` sends every line of each precast section (section title or a short text names a precast
element: Fertigteil, Sandwich, FT-...) to the extraction model in batches, validates each answer item, and keeps the result in the
session memo so the scope audit (`scope.py`) reuses it. The checks on top are deterministic Python:

- L3.PRECAST.MISSING_SPEC (spec DEP_001 / DEP_002): a sandwich element without height, length, concrete
  grade or total thickness, or through-coloured concrete without a RAL colour / pigment.
- L3.OPT.BUNDLED_FORMWORK (spec LLM_OPT_01, info): several elements share one cross-section, so formwork
  and pigment costs can be spread over the bundled length.

Anti-hallucination: a value the model "extracts" must be backed by the text. Grade, colour and element mark
must be written there. Supported dimension values are read from the labelled measurement and normalized
to the target unit. "Through-coloured" needs the word.
"""

from __future__ import annotations

from decimal import Decimal
import re
from typing import Any

from ...contracts import Line
from ...layer1.precast import LAYERS
from ...layer1.textvalues import DIMENSIONS, MEASURE, centimetres
from ...registry import rule
from .. import prompts
from ..common import batches, clip, current
from ..provider import LLMRequest
from ..schema import PRECAST_SCHEMA, PrecastItem, items, value_in

MISSING_SPEC = "L3.PRECAST.MISSING_SPEC"
BUNDLED = "L3.OPT.BUNDLED_FORMWORK"
EXTRACTION = "L3.PRECAST.EXTRACTION"  # budget/error label for the extraction calls (not a rule)
MEMO_KEY = "precast_items"

PRECAST_ELEMENT = re.compile(r"fertigteil|\bft-|sandwich", re.IGNORECASE)
_HEIGHT = (
    re.compile(rf"\b(?:h\s*=|H(?:ö|oe)he\s*[:=]?)\s*(?:ca\.?\s*)?{MEASURE}", re.I),
    re.compile(rf"{MEASURE}\s+hoch\b", re.I),
)
_LENGTH = (DIMENSIONS["length"], re.compile(rf"{MEASURE}\s+lang\b", re.I))
_THICKNESS = (
    LAYERS["total_thickness_cm"],
    re.compile(rf"\bGesamtdicke\s*[:=]?\s*(?:ca\.?\s*)?{MEASURE}", re.I),
)
_COLOURED = re.compile(r"durchgef(ä|ae)rbt|eingef(ä|ae)rbt|farbbeton", re.IGNORECASE)

# DEP_001 required fields, in question order, with the German wording for the Bieterfrage.
REQUIRED_FIELDS: dict[str, str] = {
    "height_m": "die Elementhöhe",
    "length_m": "die Elementlänge",
    "concrete_grade": "die Betonfestigkeitsklasse",
    "layers.total_thickness_cm": "die Gesamtdicke des Elements",
}
COLOUR_FIELD = "color_pigment_ral"
COLOUR_TEXT = "den RAL-Farbton bzw. das Pigment für den durchgefärbten Beton"
FIELD_LABELS = {"height_m": "height", "length_m": "length", "concrete_grade": "concrete grade",
                "layers.total_thickness_cm": "total thickness", COLOUR_FIELD: "RAL colour / pigment"}


def precast_groups(lines: list[Line], section_titles: dict[str | None, str]) -> list[list[Line]]:
    """Lines of each section that contains a precast element, in document order."""
    by_section: dict[str | None, list[Line]] = {}
    for line in sorted(lines, key=lambda l: l.sort_order):
        by_section.setdefault(line.section_id, []).append(line)
    groups = []
    for section_id, section_lines in by_section.items():
        title = section_titles.get(section_id) or ""
        if PRECAST_ELEMENT.search(title) or any(PRECAST_ELEMENT.search(line.short_text or "")
                                                for line in section_lines):
            groups.append(section_lines)
    return groups


def extracted(ctx) -> list[tuple[Line, dict[str, Any]]]:
    """(line, extracted fields) for every precast-section line the model answered for. Memoized per run."""
    session = current()
    if MEMO_KEY in session.memo:
        return session.memo[MEMO_KEY]
    titles = {section.id: section.title or "" for section in ctx.input.sections}
    chunks: list[list[Line]] = []
    for group in precast_groups(ctx.input.lines, titles):
        sized = [(line, len(line.short_text or "") + min(len(line.long_text or ""), 3_000) + 80) for line in group]
        chunks.extend(batches(sized, session.max_batch_chars, session.max_batch_lines))
    requests = []
    for chunk in chunks:
        payload = [{"ref": f"#{index}", "code": line.code, "short_text": line.short_text,
                    "long_text": clip(line.long_text), "quantity": _plain(line.quantity),
                    "unit": line.unit_raw or line.unit}
                   for index, line in enumerate(chunk, start=1)]
        requests.append(LLMRequest(system=prompts.PRECAST_SYSTEM, prompt=prompts.precast_prompt(payload),
                                   schema=PRECAST_SCHEMA, prompt_version=prompts.PRECAST_VERSION))
    result: list[tuple[Line, dict[str, Any]]] = []
    for chunk, answer in zip(chunks, session.ask_many(EXTRACTION, requests)):
        if answer is None:
            continue
        answers, dropped = items(answer, "items", PrecastItem)
        session.dropped[EXTRACTION] += dropped
        refs = {f"#{index}": line for index, line in enumerate(chunk, start=1)}
        seen: set[str] = set()
        for item in answers:
            line = refs.get(item.line_ref.strip())
            if line is None or line.id in seen:
                session.dropped[EXTRACTION] += 1
                continue
            seen.add(line.id)
            result.append((line, verified(line, item)))
        unchecked = [line.code or line.id for line in chunk if line.id not in seen]
        if unchecked:
            session.errors.append(f"{EXTRACTION}: no valid extraction for {', '.join(unchecked)}")
    session.memo[MEMO_KEY] = result
    return result


def verified(line: Line, item: PrecastItem) -> dict[str, Any]:
    """The extracted fields as a plain dict, with values the text does not back set to None/False."""
    text = _text(line)
    data = item.model_dump(exclude={"line_ref"})
    data["oz"] = line.code
    data["quantity"] = _plain(line.quantity)
    data["unit"] = line.unit_raw or line.unit
    if data["concrete_grade"]:
        data["concrete_grade"] = re.sub(r"\s+", "", data["concrete_grade"]).upper()
    for key in ("concrete_grade", "color_pigment_ral", "element_code"):
        if data[key] and not value_in(data[key], line.short_text, line.long_text):
            data[key] = None
    if data["item_type"] in {"sandwich_plinth", "precast_element"}:
        data["height_m"] = _measurement(text, _HEIGHT, scale=100)
        data["length_m"] = _measurement(text, _LENGTH, scale=100)
        total = _measurement(text, _THICKNESS)
        if data["layers"] is not None or total is not None:
            data["layers"] = {**(data["layers"] or {}), "total_thickness_cm": total}
    if data["is_through_colored"] and not _COLOURED.search(text):
        data["is_through_colored"] = False
    return data


def _measurement(text: str, patterns: tuple[re.Pattern, ...], *, scale: int = 1) -> float | None:
    values = {centimetres(match[1], match[2]) for pattern in patterns for match in pattern.finditer(text)}
    return float(values.pop() / scale) if len(values) == 1 else None


def missing_fields(data: dict[str, Any]) -> list[str]:
    """Spec DEP_001 (sandwich elements) and DEP_002 (through-coloured concrete needs a colour)."""
    missing = []
    if data["item_type"] == "sandwich_plinth":
        missing = [name for name in REQUIRED_FIELDS if _get(data, name) is None]
    if data["item_type"] in ("sandwich_plinth", "precast_element") and data["is_through_colored"] \
            and not data[COLOUR_FIELD]:
        missing.append(COLOUR_FIELD)
    return missing


@rule(MISSING_SPEC, layer=3, category="completeness", severity="warning", title="Precast element spec incomplete",
      description="A sandwich element without height, length, concrete grade or total thickness, or "
                  "through-coloured concrete without RAL colour/pigment (spec DEP_001/DEP_002). Fields are "
                  "extracted by the model and checked against the text; the rule itself is deterministic.")
def missing_spec(ctx):
    session = current()
    for line, data in extracted(ctx):
        missing = missing_fields(data)
        if not missing:
            continue
        wanted = [REQUIRED_FIELDS.get(name, COLOUR_TEXT) for name in missing]
        element = f" ({data['element_code']})" if data.get("element_code") else ""
        question = (f"Zu Pos. {line.code}{element}: Bitte teilen Sie uns {_join_de(wanted)} mit. "
                    "Die Angabe ist in der Leistungsbeschreibung nicht eindeutig belegt.")
        labels = ", ".join(FIELD_LABELS[name] for name in missing)
        yield ctx.finding(
            line=line, discriminator=",".join(missing), origin="llm", model=session.model_id,
            message=f"{line.code}: the precast element description does not establish the {labels}.",
            evidence={"missing_fields": missing, "spec_checks": _checks(missing), "extracted": data,
                      "bieterfrage_de": question, "prompt_version": prompts.PRECAST_VERSION},
        )


@rule(BUNDLED, layer=3, category="optimization", severity="info", title="Identical precast cross-sections",
      description="Several precast elements share thickness, concrete grade and surfaces (spec LLM_OPT_01): "
                  "formwork and pigment can be calculated over the bundled length. Computed from the "
                  "extracted fields.")
def bundled_formwork(ctx):
    session = current()
    sections = ctx.input.section_by_id()
    groups: dict[tuple, list[tuple[Line, dict[str, Any]]]] = {}
    for line, data in extracted(ctx):
        if data["item_type"] not in ("sandwich_plinth", "precast_element"):
            continue
        thickness = _get(data, "layers.total_thickness_cm")
        if thickness is None or not data["concrete_grade"]:
            continue
        key = (line.section_id, data["item_type"], thickness, data["concrete_grade"],
               data["surface_inside"], data["surface_outside"], data["is_through_colored"])
        groups.setdefault(key, []).append((line, data))
    for key, members in groups.items():
        if len(members) < 2:
            continue
        lengths = [_bundled_length(line, data) for line, data in members]
        total = sum(lengths) if all(length is not None for length in lengths) else None
        codes = [line.code for line, _ in members]
        section_id, item_type, thickness, grade, inside, outside, coloured = key
        cross_section = {"total_thickness_cm": thickness, "concrete_grade": grade, "surface_inside": inside,
                         "surface_outside": outside, "is_through_colored": coloured}
        length_text = f", {total} m in total" if total is not None else ""
        yield ctx.finding(
            section=sections.get(section_id) if section_id else None,
            related_line_ids=[line.id for line, _ in members], origin="llm", model=session.model_id,
            discriminator="|".join(str(part) for part in key[1:]),
            message=f"{len(members)} elements ({codes[0]} – {codes[-1]}) share the cross-section d = {thickness:g} cm, "
                    f"{grade}{length_text}: formwork{' and pigment' if coloured else ''} can be calculated "
                    f"over the bundled length.",
            evidence={"line_codes": codes, "cross_section": cross_section,
                      "total_bundled_precast_length_m": str(total) if total is not None else None,
                      "prompt_version": prompts.PRECAST_VERSION},
        )


def _bundled_length(line: Line, data: dict[str, Any]) -> Decimal | None:
    if data["length_m"] is None:
        return None
    count = line.quantity if line.unit == "ea" and line.quantity else Decimal(1)
    return (Decimal(str(round(data["length_m"], 3))) * count).normalize()


def _checks(missing: list[str]) -> list[str]:
    checks = ["DEP_001"] if any(name in REQUIRED_FIELDS for name in missing) else []
    return checks + (["DEP_002"] if COLOUR_FIELD in missing else [])


def _get(data: dict[str, Any], path: str) -> Any:
    value: Any = data
    for part in path.split("."):
        value = value.get(part) if isinstance(value, dict) else None
    return value


def _join_de(parts: list[str]) -> str:
    return parts[0] if len(parts) == 1 else ", ".join(parts[:-1]) + " und " + parts[-1]


def _text(line: Line) -> str:
    return f"{line.short_text or ''}\n{line.long_text or ''}"


def _plain(value) -> str | None:
    return None if value is None else format(value, "f")
