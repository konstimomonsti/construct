"""Typos and inconsistent spelling or notation in the item texts, found without an LLM.

All three rules are info: a typo rarely changes the price, but it makes the tender look careless and can
hide a search match (a bidder looking for "Auftragnehmer" will not find "Auftragnehemer").
"""

from __future__ import annotations

from collections import Counter, defaultdict
import re

from ..contracts import Fix, Line, Section, SetField
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
        new = old
        for match in reversed(list(pattern.finditer(spelling.mask(old)))):
            new = new[:match.start()] + forms[match[0]] + new[match.end():]
        if new != old:
            operations.append(SetField(line_id=line.id, field=field, old_value=old, new_value=new))
    return Fix(operations=operations, confidence=confidence, rationale=rationale)


def where(places: list[tuple[Line, str]]) -> tuple[list[Line], str]:
    lines = list({line.id: line for line, _ in places}.values())
    codes = ", ".join(line.code or "(no code)" for line in lines[:5]) + (", ..." if len(lines) > 5 else "")
    return lines, codes


def _title_source_words(line: Line, sections: dict[str, Section]) -> dict[str, dict[str, str | None]]:
    evidence = {token.text.lower(): {"field": "long_text", "position": line.code, "term": token.text}
                for token in spelling.tokens(line.long_text or "")}
    seen = set()
    section = sections.get(line.section_id)
    while section and section.id not in seen:
        seen.add(section.id)
        for token in spelling.tokens(section.title or ""):
            word = token.text.lower()
            source = {"field": "section_title", "section": section.code, "term": token.text}
            evidence.setdefault(word, source)
            for suffix in ("arbeiten", "leistungen"):
                if word.endswith(suffix) and len(word) - len(suffix) >= spelling.MIN_WORD_LENGTH:
                    evidence.setdefault(word[:-len(suffix)], source)
        section = sections.get(section.parent_id)
    return evidence


def _title_transpositions(line: Line, sections: dict[str, Section], checker: spelling.SpellChecker):
    source = _title_source_words(line, sections)
    for token in spelling.tokens(line.short_text or ""):
        word = token.text
        if not spelling.checkable(word) or len(word) < 9 or "-" in word or checker.known(word):
            continue
        lower = word.lower()
        if lower in source:
            continue
        variants = {lower[:i] + lower[i+1] + lower[i] + lower[i+2:] for i in range(len(lower) - 1)
                    if lower[i] != lower[i+1]}
        supported = variants & source.keys()
        if len(supported) != 1:
            if supported or checker.hunspell is None:
                continue
            supported = {variant for variant in variants if checker.known(variant)}
        if len(supported) != 1:
            continue
        candidate = supported.pop()
        yield token, spelling.match_case(word, candidate), source.get(candidate)


@rule("L1.TEXT.TYPO", layer=1, category="text", severity="info", title="Possible typo",
      description="Adjacent letters in a short description appear reversed when the position, its section heading "
                  "or the German dictionary supports a unique correction. The optional dictionary also supports "
                  "general spelling checks.")
def typo(ctx):
    lines = ctx.input.lines
    if not lines or not is_german(lines):
        return
    checker = spelling.default_checker()
    sections = ctx.input.section_by_id()
    corrected = set()
    for line in lines:
        if not line.short_text:
            continue
        replacements = list(_title_transpositions(line, sections, checker))
        if not replacements:
            continue
        new_text = line.short_text
        corrections = []
        for token, candidate, support in reversed(replacements):
            new_text = new_text[:token.start] + candidate + new_text[token.end:]
            corrected.add((line.id, token.text.lower()))
            corrections.append({"word": token.text, "suggestion": candidate,
                                "source": support or {"dictionary": checker.dictionary_name}})
        corrections.reverse()
        first = corrections[0]
        yield ctx.finding(
            line=line, field="short_text", discriminator="title-transposition",
            message=f"Check '{first['word']}' against '{first['suggestion']}' in {line.code or '(no code)'}.",
            evidence={**first, "corrections": corrections},
            suggested_fix=Fix(operations=[SetField(line_id=line.id, field="short_text",
                                                   old_value=line.short_text, new_value=new_text)],
                              confidence=0.7, rationale="The proposed spelling reverses adjacent letters and "
                                                       "matches the supporting text or dictionary."),
        )
    if checker.hunspell is None:
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
                  if not (place[1] == "short_text" and (place[0].id, lower) in corrected)
                  and not ((left and checker.known(left)) or (right and checker.known(right)))]
        if not places:
            continue
        related, codes = where(places)
        certain = not suggestion.alternatives and suggestion.distance == 1
        edits = "one edit" if suggestion.distance == 1 else f"{suggestion.distance} edits"
        fix = replacement_fix(places, {form: spelling.match_case(form, suggestion.candidate) for form in forms},
                              0.7 if certain else 0.5, f"'{suggestion.candidate}' is a known word {edits} away.")
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
    # OCR can change capitalization and spacing even when the printed notation is consistent.
    lines = [line for line in ctx.input.lines if not line.source_locator.get("ocr_pages")]
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
