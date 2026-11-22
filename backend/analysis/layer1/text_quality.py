"""Find likely typos in item texts without an LLM."""

from __future__ import annotations

from collections import Counter, defaultdict
import re

from ..contracts import Fix, Line, SetField
from ..registry import rule
from . import spelling
from .common import text_of

FIELDS = ("short_text", "long_text")
MAX_LISTED = 20
# German vs English function words: the typo checks only run on German texts.
GERMAN = re.compile(r"\b(?:und|der|die|das|mit|für|von|nach|gemäß|sowie|einschl|inkl|oder|werden|ist)\b", re.I)
ENGLISH = re.compile(r"\b(?:the|and|with|for|of|to|including|according|shall|is|are)\b", re.I)


def is_german(lines: list[Line]) -> bool:
    text = "\n".join(text_of(line) for line in lines)
    return len(GERMAN.findall(text)) >= len(ENGLISH.findall(text))


def occurrences(lines: list[Line], glued: dict[str, list[tuple[str, str]]]) -> dict[str, list[tuple[Line, str]]]:
    """Collect candidate words and their neighbors to detect words split by an export."""
    found: dict[str, list[tuple[Line, str]]] = defaultdict(list)
    for line in lines:
        for field in FIELDS:
            text = getattr(line, field)
            for token in spelling.tokens(text or ""):
                pieces = spelling.parts(token.text)
                for i, word in enumerate(pieces):
                    if spelling.checkable(word):
                        found[word].append((line, field))
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
    found = occurrences(lines, glued)
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
