"""L3.TEXT.UNDERSPECIFIED: the item can't be priced from its text (no dimension, material, class, ...).

Only candidates are sent: lines whose long text is missing or shorter than 60 characters, or lines with a
layer 1 text signal (unclear dimension, missing spec attribute, placeholder, unresolved reference). The
model names one `missing_property` from a fixed list, quotes the words that need the value (checked
verbatim in code) and drafts the question. An explicit value on the same subject cancels the claim.
Confidence is capped at 0.6.
"""

from __future__ import annotations

import json
import re

from ...contracts import Line
from ...layer1.common import source_detail
from ...layer1.textvalues import EXPOSURE, grades, values
from ...registry import rule
from .. import prompts
from ..common import batches, current, line_label
from ..provider import LLMRequest
from ..schema import (
    MAX_UNDERSPECIFIED_CONFIDENCE, UNDERSPECIFIED_SCHEMA, UnderspecifiedItem, clamp_confidence, items, normalize, quote_in,
)

RULE_ID = "L3.TEXT.UNDERSPECIFIED"
SHORT_LONG_TEXT = 60
L1_SIGNALS = {"L1.TEXT.SPEC_ATTRIBUTE_MISSING", "L1.TEXT.UNCLEAR_DIMENSION", "L1.TEXT.SPEC_PLACEHOLDER",
              "L1.TEXT.REFERENCE_UNRESOLVED"}


# An explicit value for an accessory is not evidence about the item it accompanies.
SCOPE_BREAK = re.compile(
    r"\b(?:mit(?!\s+(?:Feuerwiderstand|Festigkeitsklasse|Expositionsklasse|Farbton))|"
    r"einschließlich|inkl\.?|für|je|zuzüglich|Zarge|Rahmen|Beschlag|Befestigung|Bettung|Unterbau|Fuge|Dichtung|"
    r"Fundament|Rückenstütze|Rückenkeil|Sauberkeitsschicht|Tragschicht|Türblatt)\b", re.I,
)
CONDITIONAL_VALUE = re.compile(
    r"\?|\b(?:kein[enrms]*|nicht|ohne|optional|oder|wahlweise|alternativ|gegebenenfalls|"
    r"mindestens|höchstens|nach\s+Wahl|noch\s+offen)\b", re.I,
)
CLAUSES = re.compile(r"[.;!?]\s+|[;\n]")
COLOUR = re.compile(r"\bRAL\s*[1-9]\d{3}\b", re.I)
MATERIAL = re.compile(
    r"\b(?:aus\s+|Material\s*[:=]\s*)(?:Edelstahl|Stahlbeton|Stahl|Aluminium|Kupfer|Titanzink|"
    r"PVC-U|PE-HD|PP|Beton|Holz|Mineralwolle)\b", re.I,
)
FIELD_LABELS = {
    "fire_rating": r"Feuerwiderstand(?:sklasse)?",
    "strength_class": r"(?:Betonfestigkeitsklasse|Festigkeitsklasse|Betongüte)",
    "exposure_class": r"Expositionsklass(?:e|en)",
    "colour": r"(?:Farbton|Farbe)",
    "material": "Material",
}


def _present(property_name, text):
    if property_name == "material":
        return bool(MATERIAL.search(text))
    if property_name == "colour":
        return bool(COLOUR.search(text))
    if property_name == "fire_rating":
        return bool(values(text)["fire"])
    if property_name == "strength_class":
        return bool(grades(text))
    return bool(EXPOSURE.search(text))


def _primary_clause(clause):
    clause = clause.lstrip()
    boundary = SCOPE_BREAK.search(clause, 1)
    return clause[:boundary.start()] if boundary else clause


def _starts_with_quote(clause, quote):
    return bool(re.match(rf"^{re.escape(quote)}(?!\w)", normalize(clause)))


def _already_stated(property_name, quote, heading, detail):
    label = FIELD_LABELS.get(property_name)
    if not label:
        return False
    needle = normalize(quote).strip(" .,;:\"'„“”")
    if not needle:
        return False
    heading_subject = _starts_with_quote(_primary_clause(heading or ""), needle)
    labelled_property = re.compile(rf"^\s*(?:{label})\s*[:=]", re.I)
    details = CLAUSES.split(detail or "")
    if heading_subject and any(labelled_property.match(clause) and CONDITIONAL_VALUE.search(clause) for clause in details):
        return False
    for clauses in (CLAUSES.split(heading or ""), details):
        for clause in clauses:
            primary = _primary_clause(clause)
            if (not CONDITIONAL_VALUE.search(clause) and _starts_with_quote(primary, needle)
                    and _present(property_name, primary)):
                return True
    # A label opening the detail can continue the named subject in the heading.
    first = details[0]
    return (not CONDITIONAL_VALUE.search(heading or "")
            and heading_subject and labelled_property.match(first) is not None
            and not CONDITIONAL_VALUE.search(first) and _present(property_name, _primary_clause(first)))


def candidates(lines: list[Line], prior_findings, source_format=None) -> list[Line]:
    signalled = {f.target.line_id for f in prior_findings if f.layer == 1 and f.rule_id in L1_SIGNALS}
    return [line for line in sorted(lines, key=lambda l: l.sort_order)
            if (line.short_text or line.long_text)
            and (len((source_detail(line, source_format) or "").strip()) < SHORT_LONG_TEXT or line.id in signalled)]


@rule(RULE_ID, layer=3, category="text", severity="warning", title="Item text underspecified",
      description="The item can't be priced from its text: a price-driving property (dimension, thickness, "
                  "material, class, ...) is missing. Only short or layer-1-flagged items are checked; quotes "
                  "are verified, confidence <= 0.6.")
def underspecified(ctx):
    session = current()
    source_format = ctx.input.project.source_document.format
    sized = [(line, len(json.dumps({"ref": "#25", "code": line.code, "short_text": line.short_text,
                                    "long_text": source_detail(line, source_format), "quantity": _plain(line.quantity),
                                    "unit": line.unit_raw or line.unit}, ensure_ascii=False, indent=1)) + 4)
             for line in candidates(ctx.input.lines, ctx.prior_findings, source_format)]
    chunks = list(batches(sized, max(1, session.max_batch_chars - 100), 25))
    requests = []
    for chunk in chunks:
        payload = [{"ref": f"#{index}", "code": line.code, "short_text": line.short_text,
                    "long_text": source_detail(line, source_format), "quantity": _plain(line.quantity), "unit": line.unit_raw or line.unit}
                   for index, line in enumerate(chunk, start=1)]
        requests.append(LLMRequest(system=prompts.UNDERSPECIFIED_SYSTEM, prompt=prompts.underspecified_prompt(payload),
                                   schema=UNDERSPECIFIED_SCHEMA, prompt_version=prompts.UNDERSPECIFIED_VERSION))
    for chunk, answer in zip(chunks, session.ask_many(RULE_ID, requests)):
        if answer is None:
            continue
        answers, dropped = items(answer, "findings", UnderspecifiedItem)
        session.dropped[RULE_ID] += dropped
        refs = {f"#{index}": line for index, line in enumerate(chunk, start=1)}
        seen: set[tuple[str, str]] = set()
        for item in answers:
            line = refs.get(item.line_ref.strip())
            detail = source_detail(line, source_format) if line else None
            if line is None or not quote_in(item.quote, line.short_text, detail) \
                    or (line.id, item.missing_property) in seen \
                    or _already_stated(item.missing_property, item.quote, line.short_text, detail):
                session.dropped[RULE_ID] += 1
                continue
            seen.add((line.id, item.missing_property))
            question = item.question_de.strip()
            if not question.startswith("Zu Pos."):
                question = f"Zu Pos. {line.code}: {question}"
            property_name = item.missing_property.replace("_", " ")
            yield ctx.finding(
                line=line, field="long_text", discriminator=item.missing_property, origin="llm",
                model=session.model_id,
                message=f"{line_label(line)}: confirm the {property_name} needed to price "
                        f"\"{item.quote.strip()}\".",
                evidence={"missing_property": item.missing_property, "quote": item.quote.strip(),
                          "bieterfrage_de": question,
                          "confidence": min(clamp_confidence(item.confidence), MAX_UNDERSPECIFIED_CONFIDENCE),
                          "prompt_version": prompts.UNDERSPECIFIED_VERSION},
            )


def _plain(value) -> str | None:
    return None if value is None else format(value, "f")
