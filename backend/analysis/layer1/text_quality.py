"""Typos and inconsistent spelling or notation in the item texts, found without an LLM.

All three rules are info: a typo rarely changes the price, but it makes the tender look careless and can
hide a search match (a bidder looking for "Auftragnehmer" will not find "Auftragnehemer").
"""

from __future__ import annotations

from collections import Counter, defaultdict
import re

from ..contracts import Fix, Line, SetField
from ..registry import rule
from . import spelling
from .common import label, text_of

FIELDS = ("short_text", "long_text")
MAX_LISTED = 20
# German vs English function words: the typo checks only run on German texts.
GERMAN = re.compile(r"\b(?:und|der|die|das|mit|für|von|nach|gemäß|sowie|einschl|inkl|oder|werden|ist)\b", re.I)
ENGLISH = re.compile(r"\b(?:the|and|with|for|of|to|including|according|shall|is|are)\b", re.I)


def is_german(lines: list[Line]) -> bool:
    text = "\n".join(text_of(line) for line in lines)
    return len(GERMAN.findall(text)) >= len(ENGLISH.findall(text))


def occurrences(lines: list[Line], whole_tokens: bool,
                glued: dict[str, list[tuple[str, str]]] | None = None) -> dict[str, list[tuple[Line, str]]]:
    """Word as written -> (line, field) per occurrence. Hyphenated words are split unless `whole_tokens`.

    `glued`, when given, receives per occurrence the word joined to its neighbour across a single space
    ("st" + "atischen", "Bodenb" + "elag"), to recognise words split in two by the export."""
    found: dict[str, list[tuple[Line, str]]] = defaultdict(list)
    for line in lines:
        for field in FIELDS:
            text = getattr(line, field)
            for token in spelling.tokens(text or ""):
                if whole_tokens:
                    pieces = spelling.parts(token.text)
                    if (len("".join(pieces)) >= spelling.MIN_WORD_LENGTH
                            and all(not p.isupper() and not any(c.isupper() for c in p[1:]) for p in pieces)):
                        found[token.text].append((line, field))
                    continue
                pieces = spelling.parts(token.text)
                for i, word in enumerate(pieces):
                    if spelling.checkable(word):
                        found[word].append((line, field))
                        if glued is not None:
                            left = token.before + word if i == 0 and token.before else ""
                            right = word + token.after if i == len(pieces) - 1 and token.after else ""
                            glued[word].append((left, right))
    return found


def replacement_fix(places: list[tuple[Line, str]], forms: dict[str, str], confidence: float, rationale: str) -> Fix:
    """One SetField per (line, field), replacing every whole-word occurrence of a form by its correction."""
    pattern = re.compile(rf"(?<!\w)(?:{'|'.join(map(re.escape, sorted(forms, key=len, reverse=True)))})(?!\w)")
    operations, seen = [], set()
    for line, field in places:
        if (line.id, field) in seen:
            continue
        seen.add((line.id, field))
        old = getattr(line, field)
        new = pattern.sub(lambda m: forms[m.group(0)], old)
        if new != old:
            operations.append(SetField(line_id=line.id, field=field, old_value=old, new_value=new))
    return Fix(operations=operations, confidence=confidence, rationale=rationale)


def where(places: list[tuple[Line, str]]) -> tuple[list[Line], str]:
    lines = list({line.id: line for line, _ in places}.values())
    codes = ", ".join(line.code or "(no code)" for line in lines[:5]) + (", ..." if len(lines) > 5 else "")
    return lines, codes


@rule("L1.TEXT.TYPO", layer=1, category="text", severity="info", title="Possible typo",
      description="A word that is neither in the domain lexicon nor in the German dictionary, one letter away from "
                  "a known word ('Auftragnehemer' -> 'Auftragnehmer'). Runs only when the hunspell dictionary "
                  "is installed.")
def typo(ctx):
    lines = ctx.input.lines
    if not lines or not is_german(lines):
        return
    checker = spelling.default_checker()
    if checker.hunspell is None:
        # With the lexicon alone about half the alarms are real words ("Mutter" -> "Muster"): stay silent.
        return
    glued: dict[str, list[tuple[str, str]]] = defaultdict(list)
    found = occurrences(lines, whole_tokens=False, glued=glued)
    by_lower: dict[str, list[str]] = defaultdict(list)
    weights: Counter = Counter()
    for word, places in found.items():
        by_lower[word.lower()].append(word)
        weights[word.lower()] += len(places)
    document_index = spelling.build_index(w for w in weights if len(w) >= spelling.MIN_WORD_LENGTH - 1)

    for lower, forms in by_lower.items():
        common = max(forms, key=lambda form: len(found[form]))
        suggestion = checker.suggest(common, document_index, weights)
        if suggestion is None:
            continue
        # Drop occurrences that are half of a word split by a space ("st atischen" = "statischen").
        places = [place for form in forms for place, (left, right) in zip(found[form], glued[form])
                  if not ((left and checker.known(left)) or (right and checker.known(right)))]
        if not places:
            continue
        related, codes = where(places)
        certain = not suggestion.alternatives and suggestion.distance == 1
        fix = replacement_fix(places, {form: spelling.match_case(form, suggestion.candidate) for form in forms},
                              0.7 if certain else 0.5, f"'{suggestion.candidate}' is a known word one edit away.")
        also = f" (or {', '.join(repr(a) for a in suggestion.alternatives[:3])})" if suggestion.alternatives else ""
        yield ctx.finding(
            line=related[0], field=places[0][1], discriminator=lower, suggested_fix=fix,
            related_line_ids=[line.id for line in related[1:]],
            message=f"'{common}' looks like a typo for '{suggestion.candidate}'{also}: {len(places)} time(s) "
                    f"in {len(related)} item(s), {codes}.",
            evidence={"word": common, "forms": sorted(forms), "suggestion": suggestion.candidate,
                      "alternatives": suggestion.alternatives, "distance": suggestion.distance,
                      "occurrences": len(places), "line_codes": [line.code for line in related[:MAX_LISTED]],
                      "dictionary": checker.dictionary_name})


@rule("L1.TEXT.SPELLING_VARIANT", layer=1, category="text", severity="info", title="Same word spelled differently",
      description="One word written in two ways in the same document: Baustrom-Kabel / Baustromkabel, "
                  "Anschluß / Anschluss, Sectionaltor / Sektionaltor.")
def spelling_variant(ctx):
    lines = ctx.input.lines
    if not lines or not is_german(lines):
        return
    checker = spelling.default_checker()
    found = occurrences(lines, whole_tokens=True)
    groups: dict[str, dict[str, list[str]]] = defaultdict(lambda: defaultdict(list))
    for word in found:
        groups[spelling.variant_key(word)][word.lower()].append(word)
    for key, spellings in groups.items():
        if len(spellings) < 2:
            continue
        count = {lower: sum(len(found[form]) for form in forms) for lower, forms in spellings.items()}

        def score(lower: str) -> tuple:
            known = all(checker.known(part) for part in spelling.parts(spellings[lower][0])
                        if len(part) >= spelling.MIN_PART_LENGTH)
            return (known, count[lower], lower)

        preferred = max(spellings, key=score)
        preferred_form = max(spellings[preferred], key=lambda form: len(found[form]))
        others = [lower for lower in spellings if lower != preferred]
        forms = {form: spelling.match_case(form, preferred_form) for lower in others for form in spellings[lower]}
        places = [place for form in forms for place in found[form]]
        related, codes = where(places)
        written = ", ".join(f"'{spellings[lower][0]}' ({count[lower]}x)" for lower in sorted(spellings, key=count.get,
                                                                                             reverse=True))
        fix = replacement_fix(places, forms, 0.5, f"Use one spelling; '{preferred_form}' is the most common or the "
                                                  f"dictionary form.")
        yield ctx.finding(
            line=related[0], field=places[0][1], discriminator=key, suggested_fix=fix,
            related_line_ids=[line.id for line in related[1:]],
            message=f"The document writes the same word as {written}. Suggested: '{preferred_form}' "
                    f"(change {len(places)} occurrence(s) in {codes}).",
            evidence={"spellings": {spellings[lower][0]: count[lower] for lower in spellings},
                      "preferred": preferred_form, "line_codes": [line.code for line in related[:MAX_LISTED]]})


DN = re.compile(r"\bDN( ?)\d{1,4}\b")
DIMENSION = re.compile(r"(?<![\w,.])\d+(?:,\d+)?( ?)[x×]( ?)\d+(?:,\d+)?(?![\w,])")


def _styles(lines: list[Line], pattern: re.Pattern, style) -> dict[str, list[tuple[Line, str]]]:
    found: dict[str, list[tuple[Line, str]]] = defaultdict(list)
    for line in lines:
        for match in pattern.finditer(text_of(line)):
            name = style(match)
            if name:
                found[name].append((line, match.group(0)))
    return found


@rule("L1.TEXT.NOTATION_VARIANT", layer=1, category="text", severity="info", title="Inconsistent notation",
      description="The same unit or value written in different ways: St / Stk, psch / Psch, DN15 / DN 15, "
                  "5x25 / 5 x 25.")
def notation_variant(ctx):
    lines = ctx.input.lines
    units: dict[str, dict[str, list[Line]]] = defaultdict(lambda: defaultdict(list))
    for line in lines:
        if line.unit and line.unit_raw and line.unit_raw.strip():
            units[line.unit][line.unit_raw.strip()].append(line)
    for unit, spellings in units.items():
        if len(spellings) < 2:
            continue
        ordered = sorted(spellings, key=lambda raw: len(spellings[raw]), reverse=True)
        minority = [line for raw in ordered[1:] for line in spellings[raw]]
        written = ", ".join(f"'{raw}' ({len(spellings[raw])}x)" for raw in ordered)
        yield ctx.finding(line=minority[0], field="unit", discriminator=f"unit:{unit}",
                          related_line_ids=[line.id for line in minority[1:MAX_LISTED]],
                          message=f"The unit {unit} is written as {written}. Use one spelling.",
                          evidence={"unit": unit, "spellings": {raw: len(spellings[raw]) for raw in ordered}})

    def spaced(match: re.Match) -> str | None:
        gaps = [g for g in match.groups()]
        if all(gaps):
            return "spaced"
        return "compact" if not any(gaps) else None

    for kind, pattern, example in (("DN", DN, "DN 100 / DN100"), ("dimension", DIMENSION, "5 x 25 / 5x25")):
        styles = _styles(lines, pattern, spaced)
        if len(styles) < 2:
            continue
        ordered = sorted(styles, key=lambda name: len({line.id for line, _ in styles[name]}), reverse=True)
        minority = list({line.id: line for name in ordered[1:] for line, _ in styles[name]}.values())
        examples = {name: sorted({text for _, text in styles[name]})[:3] for name in ordered}
        written = "; ".join(f"{name} ({len(styles[name])}x, e.g. {', '.join(examples[name])})" for name in ordered)
        yield ctx.finding(line=minority[0], field="long_text", discriminator=kind,
                          related_line_ids=[line.id for line in minority[1:MAX_LISTED]],
                          message=f"{kind} values are written in two styles ({example}): {written}. "
                                  f"{label(minority[0])} uses the less common one.",
                          evidence={"kind": kind, "styles": {name: len(styles[name]) for name in ordered},
                                    "examples": examples})
