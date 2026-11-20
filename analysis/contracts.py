"""Pydantic implementation of ANALYSIS_CONTRACT.md v0.1.

Rules receive these models; only adapters normalize source values. Unknown
fields are retained so this layer can coexist with other analysis owners.
"""

from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class Model(BaseModel):
    model_config = ConfigDict(extra="allow", allow_inf_nan=False)


class SourceDocument(Model):
    id: str | None = None
    filename: str | None = None
    format: str | None = None


class Project(Model):
    id: str = "import"
    name: str = "Imported BoQ"
    currency: str = "EUR"
    gaeb_phase: Literal["83", "84", "86"] | None = None
    source_document: SourceDocument | None = None


class Bom(Model):
    bom_version_id: str = "import"
    package_code: str | None = None
    title: str | None = None
    trade: str | None = None


class Area(Model):
    id: str
    parent_id: str | None = None
    name: str = ""
    kind: str = "unknown"


class Section(Model):
    id: str
    parent_id: str | None = None
    code: str | None = None
    title: str = ""
    sort_order: int = 0


class ReferenceRange(Model):
    min: Decimal | None = None
    median: Decimal | None = None
    max: Decimal | None = None
    n: int = 0


class PriceInfo(Model):
    unit_price: Decimal | None = None
    currency: str = "EUR"
    price_unit: str | None = None
    line_amount: Decimal | None = None
    source: Literal["catalogue", "reference", "ai", "client", "none"] = "none"
    source_ref: str | None = None
    matched_text: str | None = None
    match_confidence: float = Field(default=0, ge=0, le=1)
    price_date: date | None = None
    reference_range: ReferenceRange | None = None
    citations: list[str] = Field(default_factory=list)


class SourceAmounts(Model):
    unit_price: Decimal | None = None
    line_amount: Decimal | None = None


class Distribution(Model):
    area_id: str
    quantity: Decimal | None = None


class Line(Model):
    id: str
    code: str | None = None
    code_parts: list[str] = Field(default_factory=list)
    section_id: str | None = None
    sort_order: int = 0
    short_text: str | None = None
    long_text: str | None = None
    quantity: Decimal | None = None
    quantity_raw: str | None = None
    unit: str | None = None
    unit_raw: str | None = None
    pricing_basis: Literal["unit_rate", "lump_sum"] = "unit_rate"
    total_rule: Literal["include", "conditional", "unit_price_only"] = "include"
    alternative_for: str | None = None
    gaeb_flags: dict[str, str] = Field(default_factory=dict)
    source_amounts: SourceAmounts | None = None
    price: PriceInfo | None = None
    distributions: list[Distribution] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    source_locator: dict[str, Any] = Field(default_factory=dict)


class AnalysisInput(Model):
    schema_version: Literal["0.1"] = "0.1"
    input_hash: str = ""
    project: Project = Field(default_factory=Project)
    bom: Bom = Field(default_factory=Bom)
    areas: list[Area] = Field(default_factory=list)
    sections: list[Section] = Field(default_factory=list)
    lines: list[Line] = Field(default_factory=list)
    import_warnings: list[dict[str, Any]] = Field(default_factory=list)

    @field_validator("lines", "areas", "sections")
    @classmethod
    def unique_internal_ids(cls, values):
        ids = [value.id for value in values]
        if len(ids) != len(set(ids)):
            raise ValueError("Internal IDs must be unique within each collection")
        return values


class Target(Model):
    line_id: str | None = None
    line_code: str | None = None
    section_id: str | None = None
    area_id: str | None = None
    field: str | None = None


class SetField(Model):
    op: Literal["set_field"] = "set_field"
    line_id: str
    field: Literal["quantity", "unit", "short_text", "long_text", "pricing_basis",
                   "total_rule", "alternative_for", "unit_price"]
    old_value: Any = None
    new_value: Any


class ProposedLine(Model):
    short_text: str
    long_text: str | None = None
    quantity: Decimal | None = None
    unit: str | None = None
    pricing_basis: Literal["unit_rate", "lump_sum"] = "unit_rate"


class AddLine(Model):
    op: Literal["add_line"] = "add_line"
    section_id: str | None = None
    after_line_id: str | None = None
    line: ProposedLine
    distributions: list[Distribution] = Field(default_factory=list)


class RemoveLine(Model):
    op: Literal["remove_line"] = "remove_line"
    line_id: str


class MergeLines(Model):
    op: Literal["merge_lines"] = "merge_lines"
    keep_line_id: str
    remove_line_ids: list[str]
    new_quantity: Decimal


class LinkAlternative(Model):
    op: Literal["link_alternative"] = "link_alternative"
    line_id: str
    alternative_for: str


Operation = Annotated[
    SetField | AddLine | RemoveLine | MergeLines | LinkAlternative,
    Field(discriminator="op"),
]


class Fix(Model):
    operations: list[Operation]
    confidence: float = Field(ge=0, le=1)
    rationale: str


class Finding(Model):
    id: str
    layer: Literal[1, 2, 3]
    rule_id: str
    category: str
    severity: Literal["error", "warning", "info"]
    scope: Literal["line", "section", "area", "bom"]
    target: Target = Field(default_factory=Target)
    related_line_ids: list[str] = Field(default_factory=list)
    title: str
    message: str
    evidence: dict[str, Any] = Field(default_factory=dict)
    suggested_fix: Fix | None = None
    origin: Literal["rule", "llm"] = "rule"
    model: str | None = None
    status: Literal["open", "accepted", "rejected", "applied", "stale"] = "open"
    source_locator: dict[str, Any] | None = None


class AnalysisResult(Model):
    run_id: str
    schema_version: str = "0.1"
    bom_version_id: str
    input_hash: str
    created_at: datetime
    layers_run: list[int]
    findings: list[Finding]
    summary: dict[str, Any]

