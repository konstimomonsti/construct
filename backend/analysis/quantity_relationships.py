"""Verify Layer 3 relationship proposals against the assessed tender."""

from dataclasses import dataclass
from decimal import Decimal
import re
import unicodedata

from pydantic import BaseModel, ConfigDict, Field

from .contracts import AnalysisInput, Line
from .layer1.common import excluded_scope_sections, is_counted
from .units import convert

RULE_ID = "L3.QTY.RELATIONSHIP"
PER = r"(?:per|for each|for every|pro|je|für jeden|für jede|für jedes|für jeweils)"
RELATION_MARKER = re.compile(rf"\b(?:{PER}|each|jeder|jede|jedes|jeweils|ratio|verhältnis)\b", re.I)
SCOPE_MARKER = re.compile(
    r"\b(?:includ\w*|package|packs? of|sets? of|bundl\w*|option\w*|alternativ\w*|allowance|provisional|"
    r"if required|as needed|up to|at least|at most|approximately|exclud\w*|without|omit\w*|by others|not|or|assum\w*|"
    r"enthalten|inbegriffen|einschließlich|inkl\.?|mitgeliefert|bauseits|wahlweise|"
    r"bei Bedarf|ggf\.?|bedarfs\w*|eventual\w*|bis zu|mindestens|höchstens|ca\.?|"
    r"nicht|ohne|entfällt|entfallen|oder|annahme)\b", re.I,
)
POSITION_REF = re.compile(r"\b(?:pos(?:ition)?\.?|item|OZ)\s*[:#]?\s*(\d+(?:\.\d+)+|\d+)\b", re.I)
LOCAL_SCOPE = re.compile(r"\b(room|classroom|raum|zimmer|lot|los)\s+([a-z]?[.-]?\d+(?:[.-]\d+)*[a-z]?|[a-z])\b", re.I)

_EN = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty".split()
_DE = "null eins zwei drei vier fünf sechs sieben acht neun zehn elf zwölf dreizehn vierzehn fünfzehn sechzehn siebzehn achtzehn neunzehn zwanzig".split()
NUMBER_WORDS = {word: i for words in (_EN, _DE) for i, word in enumerate(words)}
NUMBER_WORDS.update(dict.fromkeys(("ein", "eine", "einen", "einem", "einer", "eines", "a", "an"), 1))
NUMBER_WORDS.update({"fuenf": 5, "zwoelf": 12})
_EN_TENS = "twenty thirty forty fifty sixty seventy eighty ninety".split()
_DE_TENS = "zwanzig dreißig vierzig fünfzig sechzig siebzig achtzig neunzig".split()
for tens, (en, de) in enumerate(zip(_EN_TENS, _DE_TENS), 2):
    NUMBER_WORDS.update({en: tens * 10, de: tens * 10})
    for ones in range(1, 10):
        NUMBER_WORDS[f"{en}-{_EN[ones]}"] = tens * 10 + ones
        NUMBER_WORDS[f"{'ein' if ones == 1 else _DE[ones]}und{de}"] = tens * 10 + ones
NUMBER_WORDS = {word.casefold(): value for word, value in NUMBER_WORDS.items()}
NUMBER = r"(?<![\w.,/+-])(?:[0-9]+(?:[.,][0-9]{1,2})?|(?:" + "|".join(
    sorted(NUMBER_WORDS, key=len, reverse=True)) + r"))\b"


class Relationship(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source_ref: str = Field(min_length=1)
    quote: str = Field(min_length=1, max_length=900)
    base_ref: str = Field(min_length=1)
    base_item: str = Field(min_length=1, max_length=120)
    dependent_ref: str | None
    dependent_item: str = Field(min_length=1, max_length=120)
    ratio: Decimal | None = Field(gt=0, max_digits=10, decimal_places=2)
    qualifier: str | None = Field(max_length=900)


@dataclass(frozen=True)
class Verification:
    source: Line
    base: Line
    dependent: Line | None
    reason: str
    required: Decimal | None = None
    listed: Decimal | None = None
    extra: Decimal | None = None


def normalized(text: str) -> str:
    return " ".join(unicodedata.normalize("NFC", text).casefold().split())


def position_code(code: str | None) -> tuple[str, ...]:
    return tuple(part.lstrip("0") or "0" for part in code.strip(".").split(".")) if code else ()


def references(text: str) -> set[tuple[str, ...]]:
    return {position_code(match[1]) for match in POSITION_REF.finditer(text)}


def _terms(text: str) -> set[str]:
    # Stripping common inflections allows chairs/chair and Leuchten/Leuchte to match.
    text = unicodedata.normalize("NFKD", text.casefold())
    tokens = re.findall(r"[^\W\d_]+", "".join(c for c in text if not unicodedata.combining(c)))
    return {re.sub(r"(?:ern|en|er|es|e|s|n)$", "", token) if len(token) > 3 else token
            for token in tokens if token not in {"the", "das", "der", "die", "den", "dem", "des", "of"}}


def _item_matches(item: str, line: Line) -> bool:
    if code := POSITION_REF.fullmatch(item.strip()):
        return position_code(code[1]) == position_code(line.code)
    terms = _terms(item)
    return bool(terms) and terms <= _terms(line.short_text or line.long_text or "")


def _local_scopes(text: str) -> set[tuple[str, str]]:
    return {("lot" if kind in {"lot", "los"} else "room", name)
            for kind, name in LOCAL_SCOPE.findall(normalized(text))}


def _line_scope(snapshot: AnalysisInput, line: Line) -> set[tuple[str, str]]:
    labels = [line.short_text or "", line.long_text or ""]
    sections = snapshot.section_by_id()
    seen = set()
    section_id = line.section_id
    while section_id in sections and section_id not in seen:
        seen.add(section_id)
        section = sections[section_id]
        labels.append(section.title or "")
        section_id = section.parent_id
    return _local_scopes(" ".join(labels))


def _text(line: Line) -> str:
    return " ".join(filter(None, (line.short_text, line.long_text)))


def _same_scope(snapshot: AnalysisInput, first: Line, second: Line, *, explicit: bool = False) -> bool:
    if first.id != second.id and (first.distributions or second.distributions):
        if (len(first.distributions) != 1 or len(second.distributions) != 1
                or first.distributions[0].area_id != second.distributions[0].area_id
                or any(line.distributions[0].quantity not in {None, line.quantity} for line in (first, second))):
            return False
    left, right = _line_scope(snapshot, first), _line_scope(snapshot, second)
    for kind in ("lot", "room"):
        a, b = ({scope for scope in scopes if scope[0] == kind} for scopes in (left, right))
        if a and b and (a != b or len(a) > 1):
            return False
        if not explicit and a != b:
            return False
    return first.section_id == second.section_id or bool(left and left == right) or explicit


def _ratios(text: str, base_item: str, dependent_item: str) -> set[Decimal]:
    base, dependent = (re.escape(normalized(name)) for name in (base_item, dependent_item))
    # The phrases and their order come from the tender. A number elsewhere in the quote cannot validate the ratio.
    # Keep position references outside the quantity capture.
    ref = r"(?:\s*\((?:pos(?:ition)?\.?|item|oz)\s*[:#]?\s*[\d.]+\))?"
    count = rf"({NUMBER})\s+(?:(?:matching|passende[nr]?|stück|stk\.?)\s+)?{dependent}(?!\w){ref}"
    patterns = (
        rf"{count}\s+(?:{PER})\s+(?:(?:the|der|den|einen|einem)\s+)?{base}(?!\w)",
        rf"\b(?:{PER}|each|jeder|jede|jedes)\s+{base}(?!\w){ref}[^.!?\d;]{{0,45}}?{count}",
        rf"(?<!\w){base}(?!\w)\s+(?:mit|with|erhält|requires|needs|receives)\s+{count}",
    )
    return {Decimal(NUMBER_WORDS[token]) if token in NUMBER_WORDS else Decimal(token.replace(",", "."))
            for pattern in patterns for token in re.findall(pattern, normalized(text))}


def verify(snapshot: AnalysisInput, item: Relationship) -> Verification | None:
    lines = snapshot.line_by_id()
    source, base, dependent = (lines.get(ref) for ref in (item.source_ref, item.base_ref, item.dependent_ref))
    if source is None or base is None or (item.dependent_ref is not None and dependent is None) or base == dependent:
        return None
    quote = normalized(item.quote)
    source_texts = [normalized(text) for text in (source.short_text, source.long_text) if text]
    if not any(quote in text for text in source_texts) or not _item_matches(item.base_item, base):
        return None
    if dependent is not None and not _item_matches(item.dependent_item, dependent):
        return None
    if not all(re.search(rf"(?<!\w){re.escape(normalized(name))}(?!\w)", quote)
               for name in (item.base_item, item.dependent_item)):
        return None

    def review(reason: str) -> Verification:
        return Verification(source, base, dependent, reason)

    ratios = _ratios(quote, item.base_item, item.dependent_item)
    if not ratios:
        return review("assumption")
    if item.ratio not in ratios:
        return review("assumption") if item.ratio is None else None
    full_ratios = set().union(*(_ratios(text, item.base_item, item.dependent_item) for text in source_texts))
    if len(full_ratios) > 1:
        return review("conflict")
    if item.qualifier or any(SCOPE_MARKER.search(text) for text in (*source_texts, _text(base), _text(dependent) if dependent else "")):
        return review("qualified_scope")
    excluded = excluded_scope_sections(snapshot)
    if any(not is_counted(line) or line.section_id in excluded or line.alternative_for
           for line in (source, base, dependent) if line):
        return review("qualified_scope")
    mentioned = references(quote)
    if not _same_scope(snapshot, source, base, explicit=position_code(base.code) in mentioned):
        return review("ambiguous_scope")
    if source.id != base.id and position_code(base.code) not in mentioned and any(
        line.id != base.id and _item_matches(item.base_item, line) and _same_scope(snapshot, source, line)
        for line in snapshot.lines
    ):
        return review("ambiguous_scope")
    candidates = [line for line in snapshot.lines if line.id != base.id and _item_matches(item.dependent_item, line)]
    named = [line for line in candidates if position_code(line.code) in mentioned]
    if named:
        candidates = named
    scoped = [line for line in candidates if _same_scope(
        snapshot, base, line, explicit=position_code(line.code) in mentioned)]
    if dependent is None:
        return review("ambiguous_scope" if candidates else "missing_position")
    if len(scoped) != 1 or scoped[0].id != dependent.id:
        return review("ambiguous_scope")
    # Also check sibling evidence the extraction may have omitted or seen in another batch.
    item_terms = _terms(item.base_item) | _terms(item.dependent_item)
    for line in snapshot.lines:
        if line.id in {source.id, base.id, dependent.id} or not _same_scope(snapshot, base, line):
            continue
        for text in (line.short_text, line.long_text):
            if not text or not item_terms <= _terms(text):
                continue
            if _ratios(text, item.base_item, item.dependent_item) - {item.ratio}:
                return review("conflict")
            if SCOPE_MARKER.search(text):
                return review("qualified_scope")
    if any(line.alternative_for in {base.id, dependent.id} for line in snapshot.lines):
        return review("qualified_scope")
    if any(line.quantity is None or not line.quantity.is_finite() or line.quantity < 0 for line in (base, dependent)):
        return review("invalid_quantity")
    # The extracted grammar is a count-per-count relationship. A set, area or length cannot stand in for a piece.
    per_piece = convert(base.quantity, base.unit, "ea")
    if per_piece is None or convert(Decimal(1), "ea", dependent.unit) is None:
        return review("incompatible_units")
    required = convert(per_piece * item.ratio, "ea", dependent.unit)
    extra = required - dependent.quantity
    if extra > 0 and (dependent.pricing_basis != "unit_rate" or dependent.quantity <= 0):
        return Verification(source, base, dependent, "missing_rate_position", required, dependent.quantity, extra)
    return Verification(source, base, dependent, "shortfall" if extra > 0 else "covered",
                        required, dependent.quantity, extra)
