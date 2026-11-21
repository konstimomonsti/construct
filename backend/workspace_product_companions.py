"""Recover product evidence from other independently uploaded copies of a tender."""

from collections import defaultdict
from decimal import Decimal, InvalidOperation
from difflib import SequenceMatcher
import re

from workspace_product_match import (
    begins, clean_description, descriptions, duct_bundle, labelled_values, number_conflict, numbered_terms,
    reference_override, review_similarity, tender_unit, tokens,
)
from workspace_product_references import PositionReferences


MIN_SHARED_ROWS = 16
MIN_EXACT_SUMMARY_TITLES = 15
ALIGNMENT = .90
VARIANT_MARKERS = frozenset({
    "ohne", "nicht", "statt", "alternativ", "anstelle", "abweichend", "unverzinkt", "verzinkt",
    "stahl", "edelstahl", "aluminium", "kupfer", "messing", "pvc", "pvc-u", "pe", "pp",
    "epdm", "nbr", "zugsicherung",
})
SCOPE_WORDS = frozenset({"herstellen", "einbauen", "ausbauen", "verlegen", "liefern", "montieren",
                         "aufsetzen", "setzen", "versetzen", "ausführen", "aufbauen", "befestigen"})


def position_number(position):
    value = str(position.get("oz") or "").rstrip(".")
    return tuple(int(part) for part in value.split(".")) if re.fullmatch(r"\d+(?:\.\d+)*", value) else ()


def numeric_value(value):
    try:
        number = Decimal(str(value))
        return number if number.is_finite() else None
    except InvalidOperation:
        return None


def measurement(position):
    facts = position.get("sourceFacts")
    if not isinstance(facts, dict):
        facts = {}
    quantity = numeric_value(facts.get("quantity", position.get("qty")))
    unit = tender_unit(facts.get("unit", position.get("unit")))
    return (quantity, unit) if unit and quantity is not None and quantity > 0 else None


def indexed_positions(positions):
    grouped = defaultdict(list)
    for position in positions:
        if isinstance(position, dict) and (number := position_number(position)):
            grouped[number].append(position)
    return {number: group[0] for number, group in grouped.items() if len(group) == 1}


def title(position):
    return reference_override(tokens(position.get("short")))


def compatible_title(left, right):
    return not number_conflict(left, right) and SequenceMatcher(None, left, right).ratio() >= .64


def aligned_positions(primary, secondary):
    left, right = indexed_positions(primary), indexed_positions(secondary)
    if left and not any(measurement(row) for row in left.values()):
        return aligned_position_summary(left, right)
    aligned = {}
    text_seen = text_agree = priced = prices_agree = 0
    for key in left.keys() & right.keys():
        original, companion = left[key], right[key]
        if not (measure := measurement(original)) or measure != measurement(companion):
            continue
        aligned[key] = companion
        own_title, other_title = title(original), title(companion)
        if own_title and other_title:
            text_seen += 1
            text_agree += compatible_title(own_title, other_title)
        price, other_price = numeric_value(original.get("up")), numeric_value(companion.get("up"))
        if price is not None and other_price is not None:
            priced += 1
            prices_agree += price == other_price
    if len(aligned) < max(MIN_SHARED_ROWS, ALIGNMENT * max(len(primary), len(secondary))):
        return {}
    if text_seen >= MIN_SHARED_ROWS and text_agree >= ALIGNMENT * text_seen:
        return aligned
    if priced >= MIN_SHARED_ROWS and prices_agree >= ALIGNMENT * priced:
        return aligned
    return {}


def aligned_position_summary(summary, full):
    """Identify a quantityless excerpt with independently matching position labels."""
    aligned = {
        key: full[key] for key, row in summary.items()
        if key in full and measurement(full[key])
        and tender_unit(row.get("unit")) == tender_unit(full[key].get("unit"))
    }
    if len(aligned) < max(MIN_SHARED_ROWS, ALIGNMENT * len(summary)):
        return {}
    exact, related = set(), set()
    for key, row in aligned.items():
        own, other = title(summary[key]), title(row)
        if len(own) >= 2 and own == other:
            exact.add(own)
        if own and other and compatible_title(own, other):
            related.add(key)
    if len(exact) < MIN_EXACT_SUMMARY_TITLES or len(related) < .60 * len(aligned):
        return {}
    return aligned


def compatible_summary_title(headline, full_title, full_detail):
    # The row belongs to a verified abridged copy. A local identifier still has
    # to corroborate this specific row, and the detailed copy must cover local numbers.
    full = (*full_title, *full_detail)
    numbers = numbered_terms(headline)
    if numbers - numbered_terms(full):
        return False
    own_words = {word for word in headline if len(word) >= 7} - SCOPE_WORDS
    other_words = set(full) - SCOPE_WORDS
    if own_words & other_words:
        return True
    return bool(numbers and {word[:7] for word in own_words} & {word[:7] for word in other_words})


def compatible_specification(original, companion, summary=False):
    own_title, other_title = title(original), title(companion)
    if number_conflict(own_title, other_title):
        return False
    own_versions = descriptions(tokens(original.get("short")), original.get("long"))
    other_versions = descriptions(tokens(companion.get("short")), companion.get("long"))
    own_details, other_details = own_versions[0], other_versions[0]
    if own_title and not compatible_title(own_title, other_title):
        summary_title_matches = (summary and (not own_details or own_details == own_title)
                                 and compatible_summary_title(own_title, other_title, other_details))
        # Printouts can carry a shorthand title while preserving the full specification.
        if not summary_title_matches and not any(
                review_similarity(left, right)[0] >= .96
                for left in own_versions for right in other_versions if min(len(left), len(right)) >= 24):
            return False
    own_text, other_text = (*own_title, *own_details), (*other_title, *other_details)
    if number_conflict(own_text, other_text):
        return False
    if summary and numbered_terms(own_text) - numbered_terms(other_text):
        return False
    # A matching title alone cannot override contradictory specification text.
    if VARIANT_MARKERS.intersection(own_text) - set(other_text):
        return False
    if len(own_details) < 8 or len(other_details) < 8:
        return not labelled_values(own_text) - labelled_values(other_text)
    if begins(other_details, own_details) or begins(own_details, other_details):
        return True
    return SequenceMatcher(None, own_details, other_details, autojunk=False).ratio() >= .78


def compatible_duct_summary(original, companion):
    """Corroborate a short item using the complete bundle dimensions and scope."""
    heading = clean_description(original.get("short"))
    detail = clean_description(original.get("long"))
    if detail and tokens(detail) != tokens(heading):
        return False
    supporting_text = f"{clean_description(companion.get('short'))}\n{clean_description(companion.get('long'))}"
    bundle = duct_bundle(heading)
    if not bundle or bundle != duct_bundle(supporting_text):
        return False
    listed, supporting = set(tokens(heading)), set(tokens(supporting_text))
    scope = SCOPE_WORDS & listed
    return bool(scope and scope == SCOPE_WORDS & supporting and not (VARIANT_MARKERS & listed) - supporting)


def catalogue_matches(primary, siblings, matcher):
    """Use agreement among independently matched tender copies to resolve gaps."""
    original = indexed_positions(primary)
    summary = bool(original) and not any(measurement(row) for row in original.values())
    options = defaultdict(dict)
    for positions in siblings:
        aligned = aligned_positions(primary, positions)
        if not aligned:
            continue
        references = PositionReferences()
        for row in positions:
            if not isinstance(row, dict):
                continue
            prepared = references.resolve(row)
            number = position_number(row)
            if aligned.get(number) is not row:
                continue
            same_bundle = summary and compatible_duct_summary(original[number], prepared)
            if not same_bundle and not compatible_specification(original[number], prepared, summary):
                continue
            if product := matcher.match(prepared):
                options[number][product["id"]] = {"product": product, "position": prepared}
            elif same_bundle and (candidate := matcher.review_candidate(prepared)):
                options[number].setdefault(candidate["id"], {
                    "product": candidate, "position": prepared, "requires_catalogue_review": True,
                })
    return {number: next(iter(products.values())) for number, products in options.items() if len(products) == 1}
