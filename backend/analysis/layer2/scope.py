"""Coverage checks for explicit requirements in the bill."""

import re

from ..contracts import Fix
from ..graph import validate_graph
from ..layer1.common import label
from ..layer1.text_defects import REFERENCE, code_key
from ..registry import rule
from .engine import _active

_DRAINAGE = re.compile(r"\babwasser[ -]?rohr\b", re.I)
_TEST = re.compile(r"^\s*Dichtheitsprüfung\b", re.I)
_REQUIRED = re.compile(
    r"\bDichtheitsprüfung\s+(?:ist|muss)\s+(?:separat|gesondert)\s+"
    r"(?:auszuführen|durchzuführen|ausgeführt werden|durchgeführt werden)\b",
    re.I,
)
_TEST_FOLLOWUP = re.compile(r"^\s*(?:die\s+)?(?:dichtheitsprüfung|prüfung)\b", re.I)
_EXCEPTION = re.compile(r"\b(?:bauseits|nicht erforderlich|nicht auszuführen|im Einheitspreis enthalten|anderes Gewerk)\b", re.I)


@rule("L2.DRAINAGE.EXPLICIT_LEAK_TEST", layer=2, category="dependency", severity="warning",
      title="Separate leak test needs coverage",
      description="The reviewed position explicitly requires a separate leak test.")
def explicit_leak_test(ctx):
    invalid = validate_graph(ctx.input).invalid_line_ids
    active = [line for line in ctx.input.lines if _active(line) and line.id not in invalid]
    covered = set()
    unassigned = []
    for line in active:
        short = line.short_text or ""
        text = f"{short}\n{line.long_text or ''}"
        if not _TEST.search(short) or _EXCEPTION.search(text):
            continue
        references = {code_key(match[1]) for match in REFERENCE.finditer(text)}
        if references:
            covered.update(references)
        else:
            unassigned.append(line.id)

    for line in active:
        if not line.code or code_key(line.code) in covered or not _DRAINAGE.search(line.short_text or ""):
            continue
        text = line.long_text or ""
        requirement = _REQUIRED.search(text)
        if not requirement:
            continue
        start = max(text.rfind(".", 0, requirement.start()), text.rfind(";", 0, requirement.start())) + 1
        clause, _, following = text[start:].partition(".")
        followup = following.split(".", 1)[0]
        if _EXCEPTION.search(clause) or (_TEST_FOLLOWUP.search(followup) and _EXCEPTION.search(followup)):
            continue
        if unassigned:
            detail = "A leak test is listed without an explicit position assignment."
            action = "Confirm whether the listed leak test covers this position."
        else:
            detail = "The reviewed bill contains no separate test assigned to this position."
            action = "Confirm which position or package includes the required separate leak test."
        yield ctx.finding(
            line=line, field="long_text", severity="info" if unassigned else "warning",
            message=f"{label(line)} explicitly requires a separate leak test. {detail}",
            evidence={"quote": requirement[0], "trigger_line_ids": [line.id],
                      "reason": "assignment_unclear" if unassigned else "missing",
                      "bieterfrage_de": f"Zu Pos. {line.code}: Bitte bestätigen Sie, in welcher Position "
                                       "oder welchem Gewerk die gesonderte Dichtheitsprüfung enthalten ist."},
            related_line_ids=unassigned,
            suggested_fix=Fix(operations=[], confidence=0.5, rationale=action),
        )
