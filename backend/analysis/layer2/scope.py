"""Recognize explicit scope attached directly to a dependency name."""

import re

from ..layer1.common import source_detail

_REFERENCE = re.compile(
    r"""^\s*(?:ist\s+|sind\s+|wird\s+|werden\s+)?
    (?:in|unter)\s+(?:der\s+)?Pos(?:ition)?\.?\s*(?P<reference>\d+(?:\.\d+)+)
    \s+(?:enthalten|ausgeschrieben|vergütet|geregelt)\b""", re.I | re.X,
)
# A parallel noun can share the predicate, as in "Schalung und Bewehrung in gesonderter Position".
_SUBJECT_TAIL = r"(?:\s+und\s+(?-i:[A-ZÄÖÜ])\w{2,30})?\s*[:,]?\s*(?:(?:ist|sind|wird|werden)\s+)?"
_AFTER = (
    ("external", re.compile(_SUBJECT_TAIL + r"(?:bauseits|vom\s+Auftraggeber|durch\s+den\s+Auftraggeber)\s+"
                            r"(?:bereitgestellt|beigestellt|gestellt|geliefert|ausgeführt|erbracht|vorhanden)\b", re.I)),
    ("excluded", re.compile(_SUBJECT_TAIL + r"(?:nicht\s+(?:(?:im\s+Leistungsumfang\s+)?enthalten|Bestandteil)|entfällt)\b", re.I)),
    ("separate", re.compile(_SUBJECT_TAIL + r"(?:in\s+(?:einer\s+)?gesonderter\s+Position|"
                            r"(?:gesondert|separat)\s+(?:ausgeschrieben|vergütet))\b", re.I)),
    ("included", re.compile(_SUBJECT_TAIL + r"(?:im\s+(?:Einheitspreis|Leistungsumfang)\s+enthalten|mit\s+einzukalkulieren)\b", re.I)),
)
_BEFORE = (
    ("external", re.compile(r"\b(?:bauseits|vom\s+Auftraggeber)\s+"
                            r"(?:bereits\s+)?(?:vorhanden\s*:\s*|(?:geliefert|gestellt|beigestellt)\w*\s+)$", re.I)),
    ("excluded", re.compile(r"\bohne\s*$", re.I)),
    ("included", re.compile(r"\b(?:einschließlich|einschliesslich|einschl\.|inklusive|inkl\.)\s*$", re.I)),
)
_NEGATED = re.compile(r"\b(?:nicht|kein\w*)\s*$", re.I)
_QUALIFIED = re.compile(r"\b(?:teilweise|wahlweise|gegebenenfalls|ggf\.|soweit)\s*$", re.I)
_CONDITIONAL = re.compile(r"^\s*(?:(?:,\s*)?(?:soweit|sofern|wenn|falls|je nach|teilweise)\b)", re.I)


def statements(line, pattern, source_format):
    brief, detail = line.short_text or "", source_detail(line, source_format) or ""
    result = []
    for field, text in (("short_text", brief), ("long_text", detail)):
        for term in pattern.finditer(text):
            left, right = text[max(0, term.start() - 80):term.start()], text[term.end():term.end() + 110]
            for role, expression in _BEFORE:
                if match := expression.search(left):
                    before = left[:match.start()]
                    qualifier = _QUALIFIED.search(before)
                    condition = _CONDITIONAL.match(right)
                    if not _NEGATED.search(before):
                        result.append(_evidence(
                            line, field, "conditional" if qualifier or condition else role,
                            (qualifier[0] if qualifier else "") + match[0] + term[0]
                            + (condition[0] if condition else ""),
                        ))
                    break
            if reference := _REFERENCE.match(right):
                condition = _CONDITIONAL.match(right[reference.end():])
                result.append(_evidence(line, field, "conditional" if condition else "reference",
                                        term[0] + reference[0] + (condition[0] if condition else ""),
                                        reference=reference["reference"]))
                continue
            for role, expression in _AFTER:
                if match := expression.match(right):
                    condition = _CONDITIONAL.match(right[match.end():])
                    result.append(_evidence(line, field, "conditional" if condition else role,
                                            term[0] + match[0] + (condition[0] if condition else "")))
                    break
    return result


def _evidence(line, field, role, quote, **extra):
    return {"line_id": line.id, "line_code": line.code, "field": field, "role": role,
            "quote": quote, "source_locator": line.source_locator, **extra}
