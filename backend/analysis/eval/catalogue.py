"""The mutation catalogue: one planner per mutation type, each returning plans with their labels.

A plan is backend independent: a list of operations (see ops.py) plus the label that says what a correct
analysis must report. Planners work on the seed document only; they never run the analysis, so a missed
detection cannot make a mutation disappear. The only things they check are applicability rules, such as
"remove a dependency only if no remaining text still names it", which use the layer 2 regexes.

Types marked gap=True are errors no rule detects yet. They are planted and labelled with the rule that
should catch them once it exists, and are reported as gaps instead of being left out.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal
import random
import re
from typing import Callable, Iterator

from .. import units
from ..layer2.schema import RuleSpec, compile_regex, load_rules
from . import docio

D = Decimal


@dataclass
class Plan:
    id: str
    type: str
    description: str
    ops: list[dict]
    label: dict
    params: dict = field(default_factory=dict)
    whitespace_only: bool = False


@dataclass(frozen=True)
class MutationType:
    name: str
    title: str
    expect: str  # for the documentation table
    gap: bool
    control: bool
    plan: Callable[["Context", int, random.Random], Iterator[Plan]]
    per_type: bool = True  # False: enumerated (one plan per dependency), --per-type does not apply


# --------------------------------------------------------------------------- context


class Context:
    """The seed and what the planners need to know about it (layer 2 involvement, amounts)."""

    def __init__(self, doc: dict, seed: int):
        self.doc = doc
        self.seed = seed
        self.rules = load_rules()
        self._involved = self._compute_involved()

    # -- layer 2 texts and regexes, as the engine reads them
    @staticmethod
    def trigger_text(line: dict) -> str:
        return line.get("short_text") or line.get("long_text") or ""

    @staticmethod
    def full_text(line: dict) -> str:
        return " ".join(filter(None, [line.get("short_text"), line.get("long_text")]))

    def dependencies(self) -> Iterator[tuple[RuleSpec, object]]:
        for rule in self.rules:
            for dep in rule.dependencies:
                yield rule, dep

    def triggers(self, doc: dict, rule: RuleSpec, dep=None) -> list[dict]:
        """Lines that make `rule` (and, with `dep`, that dependency) apply."""
        trigger = compile_regex(rule.trigger_regex)
        exclude = compile_regex(rule.exclude_regex) if rule.exclude_regex else None
        condition = compile_regex(dep.trigger_regex) if dep is not None and dep.trigger_regex else None
        dep_exclude = compile_regex(dep.exclude_regex) if dep is not None and dep.exclude_regex else None
        found = []
        for line in doc["lines"]:
            text = self.trigger_text(line) if rule.trigger_in == "short_text" else self.full_text(line)
            if not trigger.search(text) or (exclude and exclude.search(text)):
                continue
            own = self.trigger_text(line)
            if condition and not condition.search(own):
                continue
            if dep_exclude and dep_exclude.search(own):
                continue
            found.append(line)
        return found

    def matches(self, doc: dict, dep) -> list[dict]:
        pattern = compile_regex(dep.regex)
        return [line for line in doc["lines"] if pattern.search(self.full_text(line))]

    def _compute_involved(self) -> set[str]:
        involved: set[str] = set()
        for rule, dep in self.dependencies():
            involved |= {line["id"] for line in self.triggers(self.doc, rule)}
            involved |= {line["id"] for line in self.matches(self.doc, dep)}
        return involved

    def involved_in_layer2(self, line: dict) -> bool:
        """Does any layer 2 rule read this line (as trigger or as dependency)? Layer 1 mutations avoid these."""
        return line["id"] in self._involved

    def still_uninvolved(self, line: dict) -> bool:
        """The same check for a changed line: its new text must not start to match a layer 2 regex."""
        for rule, dep in self.dependencies():
            if compile_regex(rule.trigger_regex).search(self.trigger_text(line)):
                return False
            if compile_regex(dep.regex).search(self.full_text(line)):
                return False
        return True

    def lines(self, predicate) -> list[dict]:
        return sorted((line for line in self.doc["lines"] if predicate(line)), key=lambda line: line["code"])


def rng_for(ctx: Context, name: str) -> random.Random:
    return random.Random(f"{ctx.seed}:{name}")


# --------------------------------------------------------------------------- helpers shared by planners


def derive(doc: dict, planted: list[dict], touched: list[str]) -> list[dict]:
    """The operations an estimator's software would do on its own after the planted change:
    line amounts of the touched lines follow quantity x unit price, subtotals and net total follow the amounts."""
    after_doc = apply_ops(doc, planted)
    extra: list[dict] = []
    for line_id in touched:
        try:
            line = docio.get_line(after_doc, line_id)
        except KeyError:
            continue
        expected = docio.expected_line_amount(line)
        if docio.unit_price(line) is not None and docio.line_amount(line) != expected:
            extra.append({"op": "set", "id": line_id, "field": "line_amount", "value": expected, "derived": True})
            docio.set_amount_field(line, "line_amount", expected)
    for section in after_doc["sections"]:
        total = docio.section_sum(after_doc, section["id"])
        if section["stated_total"] != total:
            extra.append({"op": "section_total", "code": section["code"], "value": total, "derived": True})
    net = docio.net_sum(after_doc)
    if after_doc["bom"]["stated_net_total"] != net:
        extra.append({"op": "net_total", "value": net, "derived": True})
    return extra


def combine(doc: dict, plans: list[Plan]) -> list[dict]:
    """Planted operations of several plans in one list, with the arithmetic recomputed for the whole.

    Only for plans whose planted operations are independent (different lines)."""
    planted = [op for plan in plans for op in plan.ops if not op.get("derived")]
    touched = [op.get("id") or op["line"]["id"] for op in planted if op["op"] in ("set", "insert_after")]
    return planted + derive(doc, planted, touched)


def apply_ops(doc: dict, ops: list[dict]) -> dict:
    from .ops import apply_to_doc
    return apply_to_doc(doc, ops)


def label(*, target: dict, expect: list[str], match: str, also: list[str] = (), gap: bool = False,
          control: bool = False, note: str = "") -> dict:
    layers = sorted({int(pattern[1]) for pattern in expect if re.match(r"L\d\.", pattern)})
    return {"target": target, "expect": list(expect), "match": match, "also_acceptable": list(also),
            "gap": gap, "control": control, "layers": layers, "note": note}


def line_target(*lines: dict) -> dict:
    return {"line_codes": [line["code"] for line in lines]}


def pick(rng: random.Random, candidates: list, count: int) -> list:
    return rng.sample(candidates, min(count, len(candidates)))


def clone_line(line: dict, code: str, line_id: str) -> dict:
    new = docio.clone({"line": line})["line"]
    new.update(id=line_id, code=code, code_parts=code.split("."))
    return new


def next_code(code: str, step: int = 5) -> str:
    head, last = code.rsplit(".", 1)
    return f"{head}.{int(last) + step:0{len(last)}d}"


def set_op(line: dict, field_name: str, value) -> dict:
    return {"op": "set", "id": line["id"], "field": field_name, "value": value}


def unit_rate(line: dict) -> bool:
    return line["pricing_basis"] == "unit_rate" and docio.unit_price(line) is not None


# --------------------------------------------------------------------------- layer 1 quantity and unit


def plan_quantity(kind: str):
    def planner(ctx: Context, count: int, rng: random.Random) -> Iterator[Plan]:
        candidates = ctx.lines(lambda l: unit_rate(l) and not ctx.involved_in_layer2(l) and l["quantity"]
                               and l["quantity"] > 0)
        for number, line in enumerate(pick(rng, candidates, count), 1):
            value = {"ZERO": D(0), "MISSING": None, "NEGATIVE": -line["quantity"]}[kind]
            planted = [set_op(line, "quantity", value)]
            ops = planted + derive(ctx.doc, planted, [line["id"]])
            rule = {"ZERO": "L1.QTY.ZERO", "MISSING": "L1.QTY.MISSING", "NEGATIVE": "L1.QTY.NEGATIVE"}[kind]
            wording = {"ZERO": "set to 0", "MISSING": "removed", "NEGATIVE": f"set to {value}"}[kind]
            yield Plan(f"QTY-{kind}-{number:02d}", f"QTY-{kind}", f"Quantity of {line['code']} {wording}", ops,
                       label(target=line_target(line), expect=[rule], match="line"),
                       {"line": line["code"], "old": str(line["quantity"]), "new": None if value is None else str(value)})
    return planner


def plan_fractional(ctx: Context, count: int, rng: random.Random) -> Iterator[Plan]:
    candidates = ctx.lines(lambda l: unit_rate(l) and units.dimension(units.normalize(l["unit"])) is units.Dimension.COUNT
                           and not ctx.involved_in_layer2(l))
    for number, line in enumerate(pick(rng, candidates, count), 1):
        value = line["quantity"] + D("0.5")
        planted = [set_op(line, "quantity", value)]
        yield Plan(f"QTY-FRACTIONAL-{number:02d}", "QTY-FRACTIONAL",
                   f"Piece count of {line['code']} changed to {value}", planted + derive(ctx.doc, planted, [line["id"]]),
                   label(target=line_target(line), expect=["L1.QTY.FRACTIONAL_COUNT"], match="line"),
                   {"line": line["code"], "old": str(line["quantity"]), "new": str(value)})


def plan_lump_quantity(ctx: Context, count: int, rng: random.Random) -> Iterator[Plan]:
    candidates = ctx.lines(lambda l: l["pricing_basis"] == "lump_sum" and docio.unit_price(l) is not None
                           and not ctx.involved_in_layer2(l))
    for number, line in enumerate(pick(rng, candidates, count), 1):
        planted = [set_op(line, "quantity", D(3))]
        yield Plan(f"LUMP-QTY3-{number:02d}", "LUMP-QTY3", f"Lump sum {line['code']} with quantity 3",
                   planted + derive(ctx.doc, planted, [line["id"]]),
                   label(target=line_target(line), expect=["L1.LUMP.INCONSISTENT"], match="line"),
                   {"line": line["code"]})


def plan_unit_missing(ctx: Context, count: int, rng: random.Random) -> Iterator[Plan]:
    candidates = ctx.lines(lambda l: unit_rate(l) and not ctx.involved_in_layer2(l))
    for number, line in enumerate(pick(rng, candidates, count), 1):
        yield Plan(f"UNIT-MISSING-{number:02d}", "UNIT-MISSING", f"Unit of {line['code']} removed",
                   [set_op(line, "unit", None)],
                   label(target=line_target(line), expect=["L1.UNIT.MISSING"], match="line"),
                   {"line": line["code"], "old": line["unit"]})


def plan_unit_unknown(ctx: Context, count: int, rng: random.Random) -> Iterator[Plan]:
    candidates = ctx.lines(lambda l: unit_rate(l) and not ctx.involved_in_layer2(l))
    for number, line in enumerate(pick(rng, candidates, count), 1):
        yield Plan(f"UNIT-UNKNOWN-{number:02d}", "UNIT-UNKNOWN", f"Unit of {line['code']} changed to 'Pkt'",
                   [set_op(line, "unit", "Pkt")],
                   label(target=line_target(line), expect=["L1.UNIT.UNKNOWN"], match="line",
                         also=["L1.UNIT.TEXT_MISMATCH"],
                         note="The 'Abrechnung nach' text then also contradicts the unknown unit."),
                   {"line": line["code"], "old": line["unit"], "new": "Pkt"})


_OTHER_DIMENSION = {"m2": "m3", "m3": "m2", "m": "m2", "t": "m3", "St": "m"}


def plan_unit_dimension(ctx: Context, count: int, rng: random.Random) -> Iterator[Plan]:
    candidates = ctx.lines(lambda l: unit_rate(l) and l["unit"] in _OTHER_DIMENSION
                           and re.search(r"Abrechnung nach", l["long_text"] or "") and not ctx.involved_in_layer2(l))
    for number, line in enumerate(pick(rng, candidates, count), 1):
        new = _OTHER_DIMENSION[line["unit"]]
        yield Plan(f"UNIT-DIMENSION-{number:02d}", "UNIT-DIMENSION",
                   f"Unit of {line['code']} changed from {line['unit']} to {new}, text says 'Abrechnung nach'",
                   [set_op(line, "unit", new)],
                   label(target=line_target(line), expect=["L1.UNIT.TEXT_MISMATCH"], match="line"),
                   {"line": line["code"], "old": line["unit"], "new": new})


# --------------------------------------------------------------------------- duplicates and text (layer 1 / gaps)


def plan_duplicate(kind: str):
    def planner(ctx: Context, count: int, rng: random.Random) -> Iterator[Plan]:
        candidates = ctx.lines(lambda l: unit_rate(l) and not ctx.involved_in_layer2(l))
        for number, line in enumerate(pick(rng, candidates, count), 1):
            if kind == "SAME-OZ":
                code, new_id = line["code"], f"{line['id']}-dup"
                new = clone_line(line, code, new_id)
                expect, also = ["L1.CODE.DUPLICATE"], ["L1.DUP.SUSPECTED"]
                text = f"{line['code']} copied with the same OZ"
            elif kind == "NEW-OZ":
                code = next_code(line["code"])
                new = clone_line(line, code, f"L{code}")
                expect, also = ["L1.DUP.SUSPECTED"], []
                text = f"{line['code']} copied under the new OZ {code}"
            else:  # reworded
                code = next_code(line["code"])
                new = clone_line(line, code, f"L{code}")
                new["short_text"] = reword(line["short_text"])
                new["long_text"] = reword(line["long_text"])
                expect, also = ["L1.DUP.*"], []
                text = f"{line['code']} copied under the new OZ {code} with reworded texts"
            planted = [{"op": "insert_after", "after_id": line["id"], "line": new}]
            yield Plan(f"DUP-{kind}-{number:02d}", f"DUP-{kind}", text,
                       planted + derive(ctx.doc, planted, [new["id"]]),
                       label(target=line_target(new), expect=expect, match="line", also=also, gap=kind == "REWORDED",
                             note="No rule compares reworded descriptions yet." if kind == "REWORDED" else ""),
                       {"source": line["code"], "new_code": code})
    return planner


_SYNONYMS = [("liefern", "bereitstellen"), ("einbauen", "montieren"), ("herstellen", "erstellen"),
             ("verlegen", "einbringen"), ("befestigen", "montieren"), ("abziehen", "abstreichen"),
             ("Baugrube", "Baugrubenbereich"), ("vorbereiten", "aufbereiten"), ("nachbehandeln", "pflegen"),
             ("verdichten", "verfestigen"), ("anschließen", "verbinden"), ("sichern", "befestigen"),
             ("auftragen", "aufbringen"), ("ausbessern", "instand setzen"), ("streichen", "anstreichen"),
             ("trennen", "separieren"), ("entsorgen", "beseitigen")]


def reword(text: str | None) -> str | None:
    """Same meaning, different words. Falls back to rotating the comma-separated parts."""
    if text is None:
        return None
    result = text
    for old, new in _SYNONYMS:
        result = re.sub(rf"\b{old}\b", new, result)
    if result == text:
        parts = text.split(", ")
        result = ", ".join(parts[1:] + parts[:1]) if len(parts) > 1 else "Ausführung: " + text
    return result


def plan_typo(ctx: Context, count: int, rng: random.Random) -> Iterator[Plan]:
    candidates = ctx.lines(lambda l: not ctx.involved_in_layer2(l)
                           and any(len(word) >= 9 and word.isalpha() for word in (l["short_text"] or "").split()))
    for number, line in enumerate(pick(rng, candidates, count), 1):
        words = [w for w in line["short_text"].split() if len(w) >= 9 and w.isalpha()]
        word = max(words, key=len)
        position = rng.randrange(2, len(word) - 3)
        wrong = word[:position] + word[position + 1] + word[position] + word[position + 2:]
        if wrong == word:  # two identical letters swapped: drop one instead
            wrong = word[:position] + word[position + 1:]
        text = line["short_text"].replace(word, wrong, 1)
        if not ctx.still_uninvolved({**line, "short_text": text}):
            continue
        yield Plan(f"TEXT-TYPO-{number:02d}", "TEXT-TYPO", f"{line['code']}: '{word}' misspelled as '{wrong}'",
                   [{"op": "set", "id": line["id"], "field": "short_text", "value": text}],
                   label(target=line_target(line), expect=["L1.TEXT.TYPO"], match="line", gap=True,
                         note="Current spelling checks need enough evidence for an unambiguous correction."),
                   {"line": line["code"], "word": word, "typo": wrong})


def plan_vague(ctx: Context, count: int, rng: random.Random) -> Iterator[Plan]:
    sections = sorted({line["section_id"] for line in ctx.doc["lines"]})
    for number, section_id in enumerate(pick(rng, sections, count), 1):
        last = [line for line in ctx.doc["lines"] if line["section_id"] == section_id][-1]
        code = next_code(last["code"], 10)
        new = clone_line(last, code, f"L{code}")
        new.update(short_text="Zusätzliche Leistungen nach Aufwand",
                   long_text="Weitere Leistungen nach Aufwand ausführen, Umfang nach Anweisung der Bauleitung. "
                             "Abrechnung pauschal.",
                   quantity=D(1), unit="psch", pricing_basis="lump_sum", gaeb_flags={"LumpSumItem": "Yes"},
                   source_amounts={"unit_price": D("5000.00"), "line_amount": D("5000.00")})
        planted = [{"op": "insert_after", "after_id": last["id"], "line": new}]
        yield Plan(f"TEXT-VAGUE-{number:02d}", "TEXT-VAGUE", f"Vague item 'nach Aufwand' added as {code}",
                   planted + derive(ctx.doc, planted, []),
                   label(target=line_target(new), expect=["L1.TEXT.SPEC_PLACEHOLDER"], match="line", gap=True,
                         note="Open quantity basis ('nach Aufwand') is not detected yet."),
                   {"new_code": code})


def plan_conflict(kind: str):
    def planner(ctx: Context, count: int, rng: random.Random) -> Iterator[Plan]:
        pattern = re.compile(r"\bC\d{2}/\d{2}\b") if kind == "CLASS" else re.compile(r"\bDN \d+\b")
        candidates = ctx.lines(lambda l: pattern.search(l["short_text"] or "") and pattern.search(l["long_text"] or ""))
        for number, line in enumerate(pick(rng, candidates, count), 1):
            old = pattern.search(line["long_text"]).group(0)
            if kind == "CLASS":
                new = "C20/25" if old != "C20/25" else "C25/30"
            else:
                new = "DN 70" if old != "DN 70" else "DN 100"
            text = line["long_text"].replace(old, new, 1)
            yield Plan(f"TEXT-CONFLICT-{kind}-{number:02d}", f"TEXT-CONFLICT-{kind}",
                       f"{line['code']}: long text says {new}, short text says {pattern.search(line['short_text']).group(0)}",
                       [{"op": "set", "id": line["id"], "field": "long_text", "value": text}],
                       label(target=line_target(line),
                             expect=["L1.TEXT.VALUE_CONFLICT", "L3.TEXT.SHORT_LONG_CONTRADICTION"], match="line"),
                       {"line": line["code"], "old": old, "new": new})
    return planner


# --------------------------------------------------------------------------- arithmetic (priced seed)


def _delta(rng: random.Random, base: Decimal, low: int = 2, high: int = 12) -> Decimal:
    percent = D(rng.randint(low, high)) / 100
    return max(D("1.00"), docio.money(abs(base) * percent))


def plan_arith_line(ctx: Context, count: int, rng: random.Random) -> Iterator[Plan]:
    candidates = ctx.lines(lambda l: unit_rate(l) and docio.line_amount(l) and docio.line_amount(l) > 100)
    for number, line in enumerate(pick(rng, candidates, count), 1):
        amount = docio.line_amount(line)
        wrong = amount + _delta(rng, amount)
        yield Plan(f"ARITH-LINE-{number:02d}", "ARITH-LINE", f"Line amount of {line['code']} changed from {amount} to {wrong}",
                   [set_op(line, "line_amount", wrong)],
                   label(target=line_target(line), expect=["L1.ARITH.LINE_AMOUNT"], match="line",
                         also=["L1.ARITH.SECTION_TOTAL", "L1.ARITH.NET_TOTAL"],
                         note="The subtotals still carry the correct amount, so they differ from the new line amount."),
                   {"line": line["code"], "old": str(amount), "new": str(wrong)})


def plan_arith_section(ctx: Context, count: int, rng: random.Random) -> Iterator[Plan]:
    leaves = sorted((s for s in ctx.doc["sections"] if any(l["section_id"] == s["id"] for l in ctx.doc["lines"])),
                    key=lambda s: s["code"])
    for number, section in enumerate(pick(rng, leaves, count), 1):
        wrong = section["stated_total"] + _delta(rng, section["stated_total"])
        yield Plan(f"ARITH-SECTION-{number:02d}", "ARITH-SECTION",
                   f"Subtotal of section {section['code']} changed from {section['stated_total']} to {wrong}",
                   [{"op": "section_total", "code": section["code"], "value": wrong}],
                   label(target={"section_codes": [section["code"]]}, expect=["L1.ARITH.SECTION_TOTAL"],
                         match="section"),
                   {"section": section["code"], "old": str(section["stated_total"]), "new": str(wrong)})


def plan_arith_net(ctx: Context, count: int, rng: random.Random) -> Iterator[Plan]:
    net = ctx.doc["bom"]["stated_net_total"]
    for number in range(1, min(count, 1) + 1):
        wrong = net + _delta(rng, net, 1, 4)
        yield Plan(f"ARITH-NET-{number:02d}", "ARITH-NET", f"Net total changed from {net} to {wrong}",
                   [{"op": "net_total", "value": wrong}],
                   label(target={}, expect=["L1.ARITH.NET_TOTAL"], match="bom"),
                   {"old": str(net), "new": str(wrong)})


# --------------------------------------------------------------------------- layer 2 dependencies


_CLIENT_SHORT = "Leistung bauseits"
_CLIENT_LONG = "Die Leistung wird bauseits erbracht und ist nicht Bestandteil dieses Leistungsverzeichnisses."


def _rule_id(rule: RuleSpec, dep) -> str:
    return f"{rule.rule_id}_NEEDS_{dep.key}"


def _only_dependency_line(ctx: Context, dep) -> dict | None:
    """The single line that names the dependency, or None if several do (then removing one proves nothing)."""
    found = ctx.matches(ctx.doc, dep)
    return found[0] if len(found) == 1 else None


def _collateral(ctx: Context, rule: RuleSpec, dep, line: dict) -> list[str]:
    """Other dependency checks that rely on this line alone: they may fire too, which is correct."""
    others = []
    for other_rule, other in ctx.dependencies():
        if other is dep:
            continue
        pattern = compile_regex(other.regex)
        if pattern.search(ctx.full_text(line)) and len(ctx.matches(ctx.doc, other)) == 1:
            others.append(_rule_id(other_rule, other))
    return others


def _dependency_plans(ctx: Context, kind: str) -> Iterator[Plan]:
    for rule, dep in ctx.dependencies():
        line = _only_dependency_line(ctx, dep)
        triggers = ctx.triggers(ctx.doc, rule, dep)
        if line is None or not triggers:
            continue
        key = dep.key
        target = {"trigger_codes": [t["code"] for t in triggers], "dependency_code": line["code"]}
        also = _collateral(ctx, rule, dep, line)
        expect = [_rule_id(rule, dep)]
        if kind == "REMOVE":
            planted = [{"op": "remove", "id": line["id"]}]
            ops = planted + derive(ctx.doc, planted, [])
            text = f"{rule.rule_id}: {dep.name} ({line['code']}) removed"
        elif kind == "CLIENT":
            replacement = {"op": "raw_text", "id": line["id"], "field": "short_text", "value": _CLIENT_SHORT}
            ops = [replacement, {"op": "raw_text", "id": line["id"], "field": "long_text", "value": _CLIENT_LONG}]
            text = f"{rule.rule_id}: {dep.name} ({line['code']}) declared 'bauseits'"
            probe = {**line, "short_text": _CLIENT_SHORT, "long_text": _CLIENT_LONG}
            if compile_regex(dep.regex).search(ctx.full_text(probe)) or not ctx.still_uninvolved(probe):
                continue
        else:  # HALF
            if dep.check_type != "QuantityMatch":
                continue
            unit = dep.quantity_unit
            half = (line["quantity"] / 2).quantize(D("0.001"), rounding=ROUND_HALF_UP)
            planted = [set_op(line, "quantity", half)]
            ops = planted + derive(ctx.doc, planted, [line["id"]])
            required = sum((units.convert(t["quantity"], units.normalize(t["unit"]), unit) or D(0) for t in triggers),
                           D(0))
            others = [m for m in ctx.matches(ctx.doc, dep) if m is not line]
            remaining = half + sum((units.convert(m["quantity"], units.normalize(m["unit"]), unit) or D(0)
                                    for m in others), D(0))
            if remaining >= required * D("0.9"):
                continue  # the cut would still be inside the tolerance
            text = f"{rule.rule_id}: quantity of {dep.name} ({line['code']}) cut from {line['quantity']} to {half}"
        yield Plan(f"L2-{kind}-{key}", f"L2-{kind}", text, ops,
                   label(target=target, expect=expect, match="dependency", also=also),
                   {"rule": rule.rule_id, "dependency": dep.name, "line": line["code"]})


def plan_l2(kind: str):
    return lambda ctx, count, rng: _dependency_plans(ctx, kind)


def plan_inline(ctx: Context, count: int, rng: random.Random) -> Iterator[Plan]:
    """Control: the dependency line is removed but named inside a trigger line's long text. Nothing is missing."""
    for rule, dep in ctx.dependencies():
        line = _only_dependency_line(ctx, dep)
        triggers = ctx.triggers(ctx.doc, rule, dep)
        if line is None or not triggers or dep.check_type != "Boolean":
            continue
        host = triggers[0]
        sentence = f"Einschließlich {line['short_text']}."
        text = f"{host['long_text']} {sentence}"
        if not compile_regex(dep.regex).search(sentence):
            continue
        planted = [{"op": "remove", "id": line["id"]},
                   {"op": "set", "id": host["id"], "field": "long_text", "value": text}]
        yield Plan(f"CTRL-INLINE-{dep.key}", "CTRL-INLINE",
                   f"{dep.name}: line {line['code']} moved into the text of {host['code']}",
                   planted + derive(ctx.doc, planted, []),
                   label(target={"line_codes": [host["code"]]}, expect=[], match="none", control=True,
                         note="The dependency is still named, so no finding is expected."),
                   {"rule": rule.rule_id, "dependency": dep.name, "removed": line["code"], "host": host["code"]})


# --------------------------------------------------------------------------- controls


def plan_reorder(ctx: Context, count: int, rng: random.Random) -> Iterator[Plan]:
    pairs = []
    lines = ctx.doc["lines"]
    for first, second in zip(lines, lines[1:]):
        if first["section_id"] == second["section_id"]:
            pairs.append((first, second))
    for number, (first, second) in enumerate(pick(rng, pairs, count), 1):
        yield Plan(f"CTRL-REORDER-{number:02d}", "CTRL-REORDER", f"{first['code']} and {second['code']} swapped",
                   [{"op": "swap", "a": first["id"], "b": second["id"]}],
                   label(target=line_target(first, second), expect=[], match="none", control=True,
                         note="Item order is irrelevant for every check."),
                   {"lines": [first["code"], second["code"]]})


def plan_whitespace(ctx: Context, count: int, rng: random.Random) -> Iterator[Plan]:
    for number, line in enumerate(pick(rng, ctx.lines(lambda l: True), count), 1):
        short = "  " + line["short_text"].replace(" ", "  ", 2) + "  "
        long = line["long_text"].replace(". ", ".   ").replace(", ", ",  ") + " "
        yield Plan(f"CTRL-WHITESPACE-{number:02d}", "CTRL-WHITESPACE", f"Extra spaces in the texts of {line['code']}",
                   [{"op": "raw_text", "id": line["id"], "field": "short_text", "value": short},
                    {"op": "raw_text", "id": line["id"], "field": "long_text", "value": long}],
                   label(target=line_target(line), expect=[], match="none", control=True,
                         note="Importers normalise whitespace; no finding is expected."),
                   {"line": line["code"]}, whitespace_only=True)


def plan_plus5(ctx: Context, count: int, rng: random.Random) -> Iterator[Plan]:
    candidates = ctx.lines(lambda l: unit_rate(l) and not ctx.involved_in_layer2(l) and l["unit"] in ("m", "m2", "m3", "t"))
    for number, line in enumerate(pick(rng, candidates, count), 1):
        value = (line["quantity"] * D("1.05")).quantize(D("0.001"), rounding=ROUND_HALF_UP)
        planted = [set_op(line, "quantity", value)]
        yield Plan(f"CTRL-PLUS5-{number:02d}", "CTRL-PLUS5", f"Quantity of unrelated line {line['code']} +5%",
                   planted + derive(ctx.doc, planted, [line["id"]]),
                   label(target=line_target(line), expect=[], match="none", control=True,
                         note="A plausible quantity change on a line no dependency refers to."),
                   {"line": line["code"], "old": str(line["quantity"]), "new": str(value)})


# --------------------------------------------------------------------------- the catalogue


TYPES: list[MutationType] = [
    MutationType("QTY-ZERO", "Quantity 0 on a priced line", "L1.QTY.ZERO", False, False, plan_quantity("ZERO")),
    MutationType("QTY-MISSING", "Quantity missing", "L1.QTY.MISSING", False, False, plan_quantity("MISSING")),
    MutationType("QTY-NEGATIVE", "Negative quantity", "L1.QTY.NEGATIVE", False, False, plan_quantity("NEGATIVE")),
    MutationType("QTY-FRACTIONAL", "Fractional piece count", "L1.QTY.FRACTIONAL_COUNT", False, False, plan_fractional),
    MutationType("LUMP-QTY3", "Lump sum with quantity 3", "L1.LUMP.INCONSISTENT", False, False, plan_lump_quantity),
    MutationType("UNIT-MISSING", "Unit missing", "L1.UNIT.MISSING", False, False, plan_unit_missing),
    MutationType("UNIT-UNKNOWN", "Unknown unit", "L1.UNIT.UNKNOWN", False, False, plan_unit_unknown),
    MutationType("UNIT-DIMENSION", "Wrong dimension against 'Abrechnung nach'", "L1.UNIT.TEXT_MISMATCH", False, False,
                 plan_unit_dimension),
    MutationType("DUP-NEW-OZ", "Exact duplicate, new OZ", "L1.DUP.SUSPECTED", False, False, plan_duplicate("NEW-OZ")),
    MutationType("DUP-SAME-OZ", "Exact duplicate, same OZ", "L1.CODE.DUPLICATE", False, False, plan_duplicate("SAME-OZ")),
    MutationType("DUP-REWORDED", "Reworded duplicate", "gap: no similarity rule", True, False, plan_duplicate("REWORDED")),
    MutationType("TEXT-TYPO", "Typo in the short text", "gap: L1.TEXT.TYPO planned", True, False, plan_typo),
    MutationType("TEXT-VAGUE", "Vague item 'nach Aufwand'", "gap: L1.TEXT.SPEC_PLACEHOLDER planned", True, False, plan_vague),
    MutationType("TEXT-CONFLICT-CLASS", "Concrete class differs in the long text",
                 "L1.TEXT.VALUE_CONFLICT / L3", False, False, plan_conflict("CLASS")),
    MutationType("TEXT-CONFLICT-DN", "DN differs in the long text", "L1.TEXT.VALUE_CONFLICT / L3", False,
                 False, plan_conflict("DN")),
    MutationType("L2-REMOVE", "Dependency removed", "L2.<GROUP>_NEEDS_<DEP>", False, False, plan_l2("REMOVE"),
                 per_type=False),
    MutationType("L2-HALF", "Dependency quantity cut by 50%", "L2.<GROUP>_NEEDS_<DEP>", False, False, plan_l2("HALF"),
                 per_type=False),
    MutationType("L2-CLIENT", "Dependency declared 'bauseits'", "L2.<GROUP>_NEEDS_<DEP>", False, False, plan_l2("CLIENT"),
                 per_type=False),
    MutationType("ARITH-LINE", "Line amount broken", "L1.ARITH.LINE_AMOUNT", False, False, plan_arith_line),
    MutationType("ARITH-SECTION", "Section subtotal broken", "L1.ARITH.SECTION_TOTAL", False, False, plan_arith_section),
    MutationType("ARITH-NET", "Net total broken", "L1.ARITH.NET_TOTAL", False, False, plan_arith_net),
    MutationType("CTRL-INLINE", "Control: dependency moved inline", "nothing", False, True, plan_inline, per_type=False),
    MutationType("CTRL-REORDER", "Control: items reordered", "nothing", False, True, plan_reorder),
    MutationType("CTRL-WHITESPACE", "Control: whitespace changed", "nothing", False, True, plan_whitespace),
    MutationType("CTRL-PLUS5", "Control: +5% on an unrelated line", "nothing", False, True, plan_plus5),
]
TYPES_BY_NAME = {t.name: t for t in TYPES}


def plan_all(doc: dict, seed: int, per_type: int = 3, only: set[str] | None = None) -> list[Plan]:
    """Every plan of the catalogue for a seed document. Deterministic for a given seed and per_type."""
    ctx = Context(doc, seed)
    plans: list[Plan] = []
    for mutation_type in TYPES:
        if only and mutation_type.name not in only and not any(mutation_type.name.startswith(o) for o in only):
            continue
        rng = rng_for(ctx, mutation_type.name)
        plans.extend(mutation_type.plan(ctx, per_type, rng))
    ids = [plan.id for plan in plans]
    assert len(ids) == len(set(ids)), "plan ids must be unique"
    return plans
