"""Match workspace positions using catalogue text and unit evidence."""

from collections import defaultdict
from dataclasses import dataclass
from difflib import SequenceMatcher
import re
import unicodedata

from analysis.units import normalize


STLB_HEADING = re.compile(r"(?im)^stlb[- ]bau\s+\d{4}[-./]\d{2}\s+\[telefon_\d+\]\s*$")
LAYOUT_FOOTER = re.compile(
    r"(?im)^[ \t]*(?:summe (?:abschnitt|bereich|titel)\b|(?:abschnitt|bereich) +\d+[. ]"
    r"|hinweistext\b|zusammenstellung(?: +bereich)?(?: +\d+(?:\.\d+)*\.?)?[ \t]*$)"
)
BANK_FOOTER = re.compile(r"(?im)^[^\n]*?\bIBAN:\s*[A-Z]{2}\s*\d{2}[^\n]*?\bBIC:[^\n]*$")
NAMED_COMPONENT = re.compile(r"(?im)^\s*unterbeschreibung +\d+ *:[ \t]*$")
COMPONENT_OVERRIDE = re.compile(r"(?i)\b(?:abweichend|anstelle|ersetzt|entfällt|stattdessen)\b")

PAGE_CONTINUATION = re.compile(
    r"(?im)^[ \t-]*(?:fortsetzung auf n(?:ä|ae)chster seite[ \t-]*(?:übertrag[: .]*)?|übertrag[: .]*)[ \t]*$"
)
STLB_TEXT_REFERENCE = re.compile(r"\[TA\d+(?=\s+Einzelbeschreibungs-Nr\b)", re.I)
PRINTED_PRICE_FIELDS = re.compile(
    r"(?i)(?<![\w.,])\d+(?:[.,]\d+)?\s+(?P<unit>psch|pau|st(?:k)?|m[²³23]?|kg|t)\s+\.{5,}\s+\.{5,}(?=\s|$)"
)
OPTIONAL_POSITION_BANNER = re.compile(r"^\s*\*{3,}\s*(?:bedarfsposition|alternativposition)\b[^\n]*$", re.I)
PRINTED_REPORT_TOTAL = re.compile(r"(?im)^[ \t]*(?:gesamtsumme\b|mwst\.)[^\n]*[ \t]+\.{8,}[ \t]*$")
DETACHED_PREAMBLE = re.compile(
    r"(?im)^(?P<heading>[^\W\d_][\w .-]{1,65})[ \t]*\r?\n(?P=heading)[ \t]*\r?\n"
    r"[ \t]*vorbemerkung(?:en)?[ \t]+-[ \t]+"
)
DUCT_MARKING = re.compile(r"(?i)\bpe[\s-]+hd\b")
DUCT_BUNDLE_SIZE = re.compile(r"(?i)\b([1-9]\d*)\s*[x×]\s*da\s*(\d+(?:[.,]\d+)?)\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*mm\b")
DUCT_BODY_COUNT = re.compile(r"(?i)\b(?:aus|mit)\s+(\d+)\s+(?:innen)?rohr(?:en|e)?\b")
EMPTY_LABELLED_FIELD = re.compile(r"""(?i)(?:#{3}|\[person_\d+\])\s*:\s*['"]?\.{8,}['"]?""")
REDACTED_MATERIAL_LABEL = re.compile(r"(?i)\bwerkstoff[ \t]+(?=\[person_\d+\][ \t]*:)")
STAINLESS_GRADES = frozenset({"1.4301", "1.4408"})
PLACEHOLDER_PREFIXES = ("person_", "firma_", "telefon_", "ort_")
DIMENSION_KEYS = frozenset({"dn", "sn", "pn", "sdr"})

QUALIFIERS = frozenset({"nicht", "ohne", "mit", "anstelle", "abweichend", "jedoch", "statt",
                        "material", "werkstoff", "farbe", "beschichtung", "oberfläche",
                        "fabrikat", "modell", "hersteller", "alternativ", "mindestens"})
MATERIAL_VARIANTS = frozenset({"stahl", "edelstahl", "alu", "aluminium", "kupfer", "messing",
                               "epdm", "nbr", "pvc", "pp", "pe"})



def tender_unit(value):
    return normalize(value.casefold()) if isinstance(value, str) else None


def clean_description(value):
    return str(value or "").strip() if value != "(ohne Kurztext)" else ""


def clipped_description(value):
    return len(value) >= 3995 and value.endswith(("…", "..."))


def tokens(value):
    text = unicodedata.normalize("NFKC", clean_description(value)).casefold()
    text = re.sub(r"\b(person_|per|firma_|telefon_|ort_)0*(\d+)\b",
                  lambda match: (match[1] if match[1] != "per" else "person_") + match[2], text)
    # The designation and conductor dimensions remain intact when the offer inflects the product noun.
    text = re.sub(r"^(?:liefern|lieferung) eines (steuerkabel|energiekabel|datenkabel)s\b", r"\1", text)
    text = re.sub(r"\b(dn|pn|sn|sdr)(?=\d)", r"\1 ", text)
    text = re.sub(r"(?<=\d),(?=\d)", ".", text)
    text = re.sub(r"(?<=\d)(?=(?:mm|cm|kg|m[23]?|bar|mpa|grad)\b)", " ", text)
    text = re.sub(r"(?<=\d)\s*[x×]\s*(?=\d)", " x ", text)
    text = text.replace("≥", ">=").replace("≤", "<=")
    return tuple(re.findall(r"[<>]=?|[^\W_]+_\d+|(?<![\w.,])-\d+(?:[.]\d+)?|[^\W_]+(?:[.]\d+)*", text))


def reference_override(terms):
    return terms[3:] if terms[:3] == ("wie", "vor", "jedoch") else terms


def explicit_title(position, name):
    if not name or name[-1] not in {"mit", "ohne", "integrierter", "integriertem", "integriert"}:
        return name
    lines = [line for line in clean_description(position.get("long")).splitlines() if line.strip()]
    if len(lines) >= 2 and tokens(lines[0]) == name:
        continuation = tokens(lines[1])
        if 0 < len(continuation) <= 3:
            return (*name, *continuation)
    return name


def descriptions(name, value):
    value = STLB_TEXT_REFERENCE.sub("", PAGE_CONTINUATION.sub("", clean_description(value)))
    value = BANK_FOOTER.sub("", value)
    value = PRINTED_PRICE_FIELDS.sub("\n", value)
    heading = STLB_HEADING.search(value)
    detail = tokens(STLB_HEADING.sub("", LAYOUT_FOOTER.split(value, maxsplit=1)[0]))
    variants = detail_variants(name, deduplicate_wrap(detail))
    if heading:
        body = deduplicate_wrap(tokens(LAYOUT_FOOTER.split(value[heading.end():], maxsplit=1)[0]))
        if body not in variants:
            return (*variants, body)
    return variants


def primary_specifications(name, raw):
    """Keep separately listed components distinct from the parent product specification."""
    component = NAMED_COMPONENT.search(raw)
    if component and not COMPONENT_OVERRIDE.search(raw, component.end()):
        return tuple(body for body in descriptions(name, raw[:component.start()]) if len(body) >= 12)
    return ()


def stainless_specifications(name, raw):
    """Keep exact grades when their material name is repeated or redacted."""
    if not all(grade in raw for grade in STAINLESS_GRADES):
        return ()
    raw = EMPTY_LABELLED_FIELD.sub("", REDACTED_MATERIAL_LABEL.sub("", raw))
    return tuple(
        tuple(term for previous, term in zip(("", *body), body)
              if previous not in STAINLESS_GRADES or not (term == "edelstahl" or term.startswith("person_")))
        for body in descriptions(name, raw)
        if len(body) >= 32 and STAINLESS_GRADES.issubset(body)
    )


def deduplicate_wrap(terms):
    # A page continuation can repeat the last words of a wrapped description.
    output = []
    for term in terms:
        output.append(term)
        for width in range(2, min(len(output) // 2, 6) + 1):
            if output[-width:] == output[-2 * width:-width] and not numbered_terms(output[-width:]):
                del output[-width:]
                break
    return tuple(output)


def detail_variants(name, detail):
    if name and detail[:len(name)] == name and detail != name:
        return (detail[len(name):], detail)
    return (detail,)


def is_specific(terms):
    return bool(numbered_terms(terms)) or len(terms) >= 6


def numbered_terms(terms):
    return {term for term in terms if any(char.isdigit() for char in term)
            and not term.startswith(PLACEHOLDER_PREFIXES)}


def begins(text, prefix):
    return len(text) >= len(prefix) and text[:len(prefix)] == prefix


def phrases(terms, size=6):
    return (terms[index:index + size] for index in range(len(terms) - size + 1))


def intersecting_prefix(left, right):
    return begins(left, right) or begins(right, left)


def labelled_values(terms):
    return {(label, value) for label, value in zip(terms, terms[1:]) if label in DIMENSION_KEYS and value[0].isdigit()}


def number_conflict(left, right):
    left_values, right_values = labelled_values(left), labelled_values(right)
    for key in DIMENSION_KEYS:
        a = {value for label, value in left_values if label == key}
        b = {value for label, value in right_values if label == key}
        if a and b and a.isdisjoint(b):
            return True
    return False


def safe_layout_tail(terms, known):
    # A printed continuation may repeat the heading, project metadata, or margin text.
    # An added dimension or qualifier can change the variant even if most text is identical.
    if QUALIFIERS.intersection(terms) or MATERIAL_VARIANTS.intersection(terms) - set(known):
        return False
    return not numbered_terms(terms) - numbered_terms(known)


def compare_detail(left, right, same_name, truncated):
    if min(len(left), len(right)) < 12:
        return False
    # Test ordered token spans and keep unmatched text visible to the compatibility check.
    comparison = SequenceMatcher(None, left, right, autojunk=False)
    block = comparison.find_longest_match()
    if block.size == len(right):
        return safe_layout_tail((*left[:block.a], *left[block.a + block.size:]), right)
    if truncated and same_name and block.a == block.b == 0 and block.size >= len(left) - 1 and len(left) >= 40:
        return True
    if block.size < min(len(left), len(right)) - 2 or block.size < 16:
        return False
    # Permit only printed redaction markers outside the shared span.
    left_extra = (*left[:block.a], *left[block.a + block.size:])
    right_extra = (*right[:block.b], *right[block.b + block.size:])
    return all(term.startswith(PLACEHOLDER_PREFIXES) for term in (*left_extra, *right_extra))


def similar_detail(left, right):
    if min(len(left), len(right)) < 20:
        return False
    comparison = SequenceMatcher(None, left, right, autojunk=False)
    if comparison.quick_ratio() < .94 or comparison.ratio() < .94:
        return False
    # A finish, type, or condition change can be a single word in a long otherwise identical specification.
    for tag, start, end, other_start, other_end in comparison.get_opcodes():
        if tag == "equal":
            continue
        old = left[start:end]
        new = right[other_start:other_end]
        if looks_like_redaction(old, new) or looks_like_redaction(new, old):
            continue
        if not old or not new:
            return False
        if "".join(old) != "".join(new):
            return False
    return True


def compatible_layout_excerpt(detail, description, title, catalogue_title):
    """Accept a sufficiently complete excerpt of a uniquely identified specification."""
    if min(len(detail), len(description)) < 6:
        return False
    title_and_detail = (*title, *detail)
    required = labelled_values((*catalogue_title, *description))
    if not required.issubset(labelled_values(title_and_detail)):
        return False
    comparison = SequenceMatcher(None, detail, description, autojunk=False)
    block = comparison.find_longest_match()
    if block.size == len(description):
        # The full catalogue specification appears in the tender. Do not allow an explicit
        # local override to cancel its material, rating or other variant.
        remainder = (*detail[:block.a], *detail[block.a + block.size:])
        explicit_change = {"ohne", "nicht", "abweichend", "anstelle", "statt", "jedoch", "alternativ"}
        variant_terms = MATERIAL_VARIANTS | {"material", "werkstoff", "beschichtung", "oberfläche", "farbe", "typ", "modell"}
        return (not explicit_change.intersection(remainder)
                and not (variant_terms.intersection(remainder) - set((*catalogue_title, *description)))
                and labelled_values(remainder).issubset(required))
    if block.size == len(detail) and block.size >= 8:
        omitted = (*description[:block.b], *description[block.b + block.size:])
        return safe_layout_tail(omitted, title_and_detail)
    if min(len(detail), len(description)) < 12 or comparison.quick_ratio() < .94 or comparison.ratio() < .94:
        return False

    # Replacements require an observed formatting or redaction difference. A plausible
    # substitute material, coating or connection is not equivalent just because most words agree.
    for tag, i, j, k, l in comparison.get_opcodes():
        if tag == "equal":
            continue
        left, right = detail[i:j], description[k:l]
        if "".join(left) == "".join(right) or looks_like_redaction(left, right) or looks_like_redaction(right, left):
            continue
        if left and right:
            return False
        extra = left or right
        if not safe_layout_tail(extra, title_and_detail) or len(extra) > 3:
            return False
    return True


def review_similarity(left, right):
    if len(right) < 12 or number_conflict(left, right):
        return 0., 0
    left_material = MATERIAL_VARIANTS.intersection(left)
    right_material = MATERIAL_VARIANTS.intersection(right)
    if left_material and right_material and left_material.isdisjoint(right_material):
        return 0., 0
    comparison = SequenceMatcher(None, left, right, autojunk=False)
    return (comparison.ratio(), min(len(left), len(right))) if comparison.quick_ratio() >= .84 else (0., 0)


def reviewable_detail(left, right, same_name):
    similarity, length = review_similarity(left, right)
    if (same_name and similarity >= .84) or (length >= 25 and similarity >= .95):
        return similarity
    if length >= 32 and similarity >= .88 and len(numbered_terms(left) & numbered_terms(right)) >= 3:
        return similarity
    return 0.


def review_descriptions(name, raw):
    # Preserve the original evidence for the model. These shortened views only shortlist candidates.
    bodies = descriptions(name, raw)
    if preamble := DETACHED_PREAMBLE.search(raw):
        return (*bodies, *descriptions(name, raw[:preamble.start()]))
    if total := PRINTED_REPORT_TOTAL.search(raw):
        if not PRINTED_REPORT_TOTAL.sub("", raw[total.start():]).strip():
            return (*bodies, *descriptions(name, raw[:total.start()]))
    return bodies


def duct_bundle(text):
    """Read a count, outside diameter, and wall thickness for a marked PE-HD duct bundle."""
    if not DUCT_MARKING.search(text) or not re.search(r"(?i)\bleerrohr\w*", text):
        return None
    sizes = {tuple(value.replace(",", ".") for value in group) for group in DUCT_BUNDLE_SIZE.findall(text)}
    if len(sizes) != 1:
        return None
    size = next(iter(sizes))
    return size if set(DUCT_BODY_COUNT.findall(text)).issubset({size[0]}) else None


def looks_like_redaction(markers, words):
    if len(markers) != 1 or not markers[0].startswith(PLACEHOLDER_PREFIXES):
        return False
    if len(words) == 1 and re.fullmatch(r"p0*\d+", words[0]):
        return markers[0] == f"person_{int(words[0][1:])}"
    return len(words) <= 3 and not numbered_terms(words) and safe_layout_tail(words, ())


def pipe_key(terms):
    """Normalize supply wording for pipes with explicit technical identifiers."""
    terms = reference_override(terms)
    if len(terms) < 4 or not DIMENSION_KEYS.intersection(terms):
        return ()
    if not {"rohr", "rohre", "muffendruckrohr", "muffendruckrohre",
            "abwasserrohr", "entwaesserungsrohr", "entwässerungsrohr"}.intersection(terms):
        return ()
    if set(terms).intersection(("ohne", "nicht", "verlegen", "demontieren", "bestehend", "bauseits",
                                "nur", "und", "oder")):
        return ()
    aliases = {"rohre": "rohr", "muffendruckrohre": "muffendruckrohr"}
    if "sn" in terms:
        aliases.update(dict.fromkeys(("abwasserrohr", "entwaesserungsrohr", "entwässerungsrohr"), "rohr"))
    filtered = tuple(aliases.get(term, term) for term in terms if term not in {"lieferung", "liefern", "aus"})
    # Keep the order of numbers within each labelled dimension, including pairs and ranges.
    groups = []
    for term in filtered:
        if groups and groups[-1][0] in DIMENSION_KEYS and term[0].isdigit():
            groups[-1].append(term)
        else:
            groups.append([term])
    return tuple(sorted(tuple(group) for group in groups))


def trim_delivery(detail):
    suffix = ("lieferung", "auf", "die", "baustelle")
    return detail[:-len(suffix)] if detail[-len(suffix):] == suffix else detail


@dataclass(frozen=True, slots=True)
class ProductText:
    row: dict
    units: frozenset[str]
    name: tuple[str, ...]
    details: tuple[tuple[str, ...], ...]
    pipe: tuple[tuple[str, ...], ...]
    stainless: tuple[tuple[str, ...], ...]


class ProductMatcher:
    """Index identity evidence once per upload and abstain on ties."""

    def __init__(self, rows):
        self.products = []
        self.names = defaultdict(set)
        self.detail_phrases = defaultdict(set)
        self.long_names = defaultdict(set)
        self.leading_specs = defaultdict(set)
        self.pipes = defaultdict(set)
        self.duct_bundles = defaultdict(set)
        self.qualified_pipes = set()
        for row in rows:
            name = tokens(row["name"])
            details = descriptions(name, row["description"])
            units = frozenset(filter(None, map(tender_unit, (row["unit_code"], *row["tender_units"]))))
            if not units:
                printed_units = {tender_unit(m["unit"]) for m in PRINTED_PRICE_FIELDS.finditer(row["description"])}
                if len(printed_units) == 1:
                    units = frozenset(printed_units)
            pipe = pipe_key(name)
            index = len(self.products)
            self.products.append(ProductText(row, units, name, details, pipe, stainless_specifications(name, row["description"])))
            self.names[reference_override(name)].add(index)
            if len(name) >= 5 and is_specific(name):
                self.long_names[name[:4]].add(index)
            if pipe:
                self.pipes[pipe].add(index)
            if bundle := duct_bundle(f"{row['name']}\n{row['description']}"):
                self.duct_bundles[bundle].add(index)
            for marker in ("mit", "ohne"):
                if marker in name and (base := pipe_key(name[:name.index(marker)])):
                    self.qualified_pipes.add(base)
            for detail in details:
                for phrase in phrases(detail):
                    self.detail_phrases[phrase].add(index)
                if len(detail) >= 7:
                    self.leading_specs[detail[:5]].add(index)

    def match(self, position):
        raw = clean_description(position.get("long"))
        headline = clean_description(position.get("short"))
        if OPTIONAL_POSITION_BANNER.fullmatch(headline):
            headline = next((line for line in raw.splitlines()
                             if line.strip() and not OPTIONAL_POSITION_BANNER.fullmatch(line)), "")
        name = tokens(headline)
        if not name:
            return None
        details = tuple(detail for detail in descriptions(name, raw) if detail and detail != name)
        primary = primary_specifications(name, raw)
        stainless = stainless_specifications(name, raw)
        truncated = clipped_description(raw)
        pipe = pipe_key(name)
        unit = tender_unit(position.get("unit"))
        if reference_override(name) != name and pipe in self.qualified_pipes:
            return None
        normalized = reference_override(name)
        candidates = self.names.get(normalized, set()).copy()
        candidates.update(self.leading_specs.get(name[:5], ()))
        if pipe:
            candidates.update(self.pipes.get(pipe, ()))
        for body in details:
            candidates.update(self.long_names.get(body[:4], ()))
            for phrase in phrases(body):
                candidates.update(self.detail_phrases.get(phrase, ()))
        matches = defaultdict(list)
        for index in candidates:
            product = self.products[index]
            if unit and product.units and unit not in product.units:
                continue
            score = self.score(name, details, unit, pipe, product, truncated)
            if (unit in product.units and primary
                    and (normalized == reference_override(product.name) or begins(product.name, name))
                    and any(body in product.details for body in primary)):
                score = max(score, 5)
            if (unit in product.units and normalized == reference_override(product.name)
                    and any(body in product.stainless for body in stainless)):
                score = max(score, 5)
            if score:
                matches[score].append(product.row)
        if matches and len(best := matches[max(matches)]) == 1:
            return best[0]
        return None

    def review_candidate(self, position):
        """Shortlist a unique close specification for independent model review."""
        headline = clean_description(position.get("short"))
        raw = clean_description(position.get("long"))
        title = tokens(headline)
        name = reference_override(explicit_title(position, title))
        unit = tender_unit(position.get("unit"))
        bodies = [body for body in review_descriptions(title, raw) if len(body) >= 8 and body != title]
        if not unit or not name or not bodies:
            return None
        pipe = pipe_key(name)
        if reference_override(title) != title and pipe in self.qualified_pipes:
            return None
        candidates = self.names.get(name, set()).copy()
        if pipe:
            candidates.update(self.pipes.get(pipe, ()))
        duct_candidates = self.duct_bundles.get(duct_bundle(f"{headline}\n{raw}"), ()) if unit == "m" else ()
        candidates.update(duct_candidates)
        for body in bodies:
            for phrase in phrases(body):
                candidates.update(self.detail_phrases.get(phrase, ()))
        ranked = []
        for index in candidates:
            product = self.products[index]
            if unit not in product.units or number_conflict(name, product.name):
                continue
            same_name = name == reference_override(product.name)
            rating = max((reviewable_detail(left, right, same_name) for left in bodies for right in product.details),
                         default=0.)
            if not rating and (same_name or (pipe and pipe == product.pipe)) and len(numbered_terms(name)) >= 2:
                # A shared designation and multiple identifiers can justify review when one
                # description adds detail. The worker still has to validate their scope and variants.
                if not any(number_conflict((*name, *body), (*product.name, *detail))
                           for body in bodies for detail in product.details):
                    rating = .83
            if not rating and index in duct_candidates:
                rating = .83
            if rating:
                ranked.append((rating, index))
        ranked.sort(reverse=True)
        if not ranked or (len(ranked) > 1 and ranked[0][0] - ranked[1][0] < .03):
            return None
        return self.products[ranked[0][1]].row

    @staticmethod
    def score(name, details, unit, pipe, product, truncated):
        """Prefer agreement on both fields, followed by detailed text and then a clear title."""
        requested, catalogued = reference_override(name), reference_override(product.name)
        if number_conflict(requested, catalogued):
            return 0
        name_equal = requested == catalogued
        name_equivalent = name_equal or bool(pipe and pipe == product.pipe)
        related = intersecting_prefix(requested, catalogued) or (
            len(set(requested) & set(catalogued)) >= max(3, min(len(requested), len(catalogued)) - 2)
        )
        score = 0
        for detail in details:
            if (unit and not name_equal and len(catalogued) >= 5 and begins(detail, catalogued)
                    and begins(catalogued, requested) and safe_layout_tail(detail[len(catalogued):], catalogued)):
                score = max(score, 3)
            # The parser can split a wrapped catalogue title after the first display line.
            # Compare both the printed text and the version after that full title.
            for body in detail_variants(catalogued, detail):
                for description in product.details:
                    if related and compare_detail(body, description, name_equal, truncated):
                        score = max(score, 3)
            for description in product.details:
                if detail == description or trim_delivery(detail) == description:
                    if name_equivalent:
                        return 5
                    redacted_title = (
                        len(detail) >= 6 and unit in product.units and len(requested) == 1
                        and requested[0].startswith(PLACEHOLDER_PREFIXES) and begins(detail, requested)
                        and len(catalogued) >= 3 and begins(detail[1:], catalogued)
                    )
                    if len(detail) >= 7 or redacted_title:
                        score = max(score, 4)

                if (related or min(len(detail), len(description)) >= 40) and similar_detail(detail, description):
                    score = max(score, 3)
                if unit and product.units and (name_equal or (
                        min(len(requested), len(catalogued)) >= 4 and intersecting_prefix(requested, catalogued)
                )) and compatible_layout_excerpt(detail, description, requested, catalogued):
                    score = max(score, 2)
        if details:
            return score
        if (unit and product.units and len(name) >= 6 and numbered_terms(name)
                and any(begins(description, name) for description in product.details)):
            return 2
        if name_equivalent and unit and product.units:
            # A generic title alone does not identify a more specific catalogue variant.
            sizes = labelled_values(name)
            introduces_size = any(labelled_values(description) - sizes for description in product.details)
            if not introduces_size and (len(requested) >= 3 or not any(
                    numbered_terms(description) - numbered_terms(name) for description in product.details)):
                return 2
            if (name_equal and len(requested) >= 2 and not introduces_size and not product.row["unit_code"]
                    and any(begins(description, name) for description in product.details)):
                return 1
        if name_equal and not unit and not product.units and len(name) >= 2 and product.details == (name,):
            return 2
        return 0
