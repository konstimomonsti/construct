"""Rule registry shared by all layers.

A rule is a generator that receives a RuleContext and yields Findings:

    @rule("L1.QTY.MISSING", layer=1, category="completeness", severity="error",
          title="Quantity missing", description="Item without quantity that is not a lump sum.")
    def quantity_missing(ctx):
        for line in ctx.input.lines:
            if line.quantity is None and line.pricing_basis != "lump_sum":
                yield ctx.finding(line=line, field="quantity", message="...")

Registration happens on import, so a layer package only has to import its rule modules.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Iterable

from .contracts import AnalysisInput, Finding, Fix, Line, Section, Target


@dataclass(frozen=True)
class RuleInfo:
    rule_id: str
    layer: int
    category: str
    severity: str
    title: str
    description: str
    func: Callable[[RuleContext], Iterable[Finding]] = field(compare=False, repr=False)

    def as_dict(self) -> dict[str, Any]:
        return {"rule_id": self.rule_id, "layer": self.layer, "category": self.category,
                "severity": self.severity, "title": self.title, "description": self.description}


_REGISTRY: dict[str, RuleInfo] = {}


def rule(rule_id: str, *, layer: int, category: str, severity: str, title: str, description: str):
    if not rule_id.startswith(f"L{layer}."):
        raise ValueError(f"{rule_id}: rule ids start with 'L{layer}.'")

    def register(func):
        if rule_id in _REGISTRY:
            raise ValueError(f"Duplicate rule id {rule_id}")
        _REGISTRY[rule_id] = RuleInfo(rule_id, layer, category, severity, title, description, func)
        return func

    return register


def rules_for(layer: int) -> list[RuleInfo]:
    return [info for info in _REGISTRY.values() if info.layer == layer]


def all_rules() -> list[RuleInfo]:
    return list(_REGISTRY.values())


@dataclass
class RuleContext:
    input: AnalysisInput
    prior_findings: list[Finding]
    info: RuleInfo

    def finding(self, *, message: str, line: Line | None = None, section: Section | None = None,
                area_id: str | None = None, field: str | None = None, title: str | None = None,
                severity: str | None = None, evidence: dict[str, Any] | None = None,
                related_line_ids: Iterable[str] = (), suggested_fix: Fix | None = None,
                discriminator: str | None = None, origin: str = "rule", model: str | None = None) -> Finding:
        """Build a Finding with this rule's defaults. Scope is taken from the most specific target given."""
        target = Target(
            line_id=line.id if line else None, line_code=line.code if line else None,
            section_id=(section.id if section else (line.section_id if line else None)),
            area_id=area_id, field=field,
        )
        scope = "line" if line else "section" if section else "area" if area_id else "bom"
        return Finding.create(
            rule_id=self.info.rule_id, layer=self.info.layer, target=target, discriminator=discriminator,
            category=self.info.category, severity=severity or self.info.severity, scope=scope,
            related_line_ids=list(related_line_ids), title=title or self.info.title, message=message,
            evidence=_jsonable(evidence or {}), suggested_fix=suggested_fix, origin=origin, model=model,
            source_locator=line.source_locator if line else None,
        )


def _jsonable(value: Any) -> Any:
    """Evidence goes to JSON and the database. Decimals become strings so no precision is lost."""
    from decimal import Decimal
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_jsonable(item) for item in value]
    return value


def run_layer(layer: int, analysis_input: AnalysisInput, prior_findings: list[Finding],
              errors: list[str] | None = None) -> list[Finding]:
    """Run every registered rule of a layer. A crashing rule is reported in `errors`, not fatal."""
    findings: list[Finding] = []
    for info in rules_for(layer):
        context = RuleContext(analysis_input, prior_findings, info)
        try:
            findings.extend(info.func(context) or [])
        except Exception as exc:  # one broken rule must not hide the others
            if errors is None:
                raise
            errors.append(f"{info.rule_id}: {type(exc).__name__}: {exc}")
    return findings
