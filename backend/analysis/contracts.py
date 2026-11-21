"""Shared models for the analysis pipeline. See docs/ANALYSIS_CONTRACT.md.

Changes to this file need the agreement of every layer owner. Bump SCHEMA_VERSION on any
change that breaks existing JSON.
"""

from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal
from enum import Enum
from hashlib import sha256
import json
from typing import Annotated, Any, Literal, Union
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field

SCHEMA_VERSION = "0.1"


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", use_enum_values=True)


# --------------------------------------------------------------------------- input


class SourceDocument(_Model):
    id: str | None = None
    filename: str | None = None
    format: str | None = None


class Project(_Model):
    id: str | None = None
    name: str | None = None
    currency: str | None = None
    gaeb_phase: str | None = None  # "83" tender, "84" bid, "86" award
    source_document: SourceDocument = Field(default_factory=SourceDocument)


class Bom(_Model):
    bom_version_id: str | None = None
    package_code: str | None = None
    title: str | None = None
    trade: str | None = None
    stated_net_total: Decimal | None = None  # total written in the source file, if any


class Area(_Model):
    id: str
    parent_id: str | None = None
    name: str
    kind: str = "unknown"


class Section(_Model):
    id: str
    parent_id: str | None = None
    code: str | None = None
    code_parts: list[str] = Field(default_factory=list)
    title: str | None = None
    sort_order: int
    stated_total: Decimal | None = None  # subtotal written in the source file, if any
    # Subtotal after a section discount (GAEB XML TotAfterDisc). Parent sections add this amount, not stated_total.
    stated_total_after_discount: Decimal | None = None
    # Lump-sum price for the whole section (GAEB XML TotalLSUM). Without a discount, parents add this amount.
    stated_lump_sum_total: Decimal | None = None


class ReferenceRange(_Model):
    min: Decimal
    median: Decimal
    max: Decimal
    n: int


class PriceSource(str, Enum):
    CATALOGUE = "catalogue"
    REFERENCE = "reference"
    AI = "ai"
    CLIENT = "client"
    NONE = "none"


class PriceInfo(_Model):
    """What the pricing phase hands to the analysis for one line."""

    unit_price: Decimal | None = None
    currency: str | None = None
    price_unit: str | None = None  # canonical unit the price refers to
    line_amount: Decimal | None = None
    source: PriceSource = PriceSource.NONE
    source_ref: str | None = None
    matched_text: str | None = None
    match_confidence: float | None = Field(default=None, ge=0, le=1)
    price_date: date | None = None
    reference_range: ReferenceRange | None = None
    citations: list[str] = Field(default_factory=list)


class SourceAmounts(_Model):
    """Prices written in the uploaded file itself (GAEB 84/86 bids)."""

    unit_price: Decimal | None = None
    line_amount: Decimal | None = None


class Distribution(_Model):
    area_id: str
    quantity: Decimal | None = None


class Line(_Model):
    id: str
    code: str | None = None
    code_parts: list[str] = Field(default_factory=list)
    section_id: str | None = None
    sort_order: int
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


class ImportWarning(_Model):
    code: str
    message: str | None = None
    locator: dict[str, Any] = Field(default_factory=dict)


class AnalysisInput(_Model):
    schema_version: str = SCHEMA_VERSION
    input_hash: str = ""
    project: Project = Field(default_factory=Project)
    bom: Bom = Field(default_factory=Bom)
    areas: list[Area] = Field(default_factory=list)
    sections: list[Section] = Field(default_factory=list)
    lines: list[Line] = Field(default_factory=list)
    import_warnings: list[ImportWarning] = Field(default_factory=list)

    def compute_hash(self) -> str:
        payload = self.model_dump(mode="json", exclude={"input_hash"})
        canonical = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
        return sha256(canonical.encode("utf-8")).hexdigest()

    def with_hash(self) -> AnalysisInput:
        return self.model_copy(update={"input_hash": self.compute_hash()})

    # Convenience lookups for rule authors. Not serialized.
    def line_by_id(self) -> dict[str, Line]:
        return {line.id: line for line in self.lines}

    def section_by_id(self) -> dict[str, Section]:
        return {section.id: section for section in self.sections}

    def lines_in_section(self, section_id: str | None) -> list[Line]:
        return [line for line in self.lines if line.section_id == section_id]


# --------------------------------------------------------------------------- output


class Severity(str, Enum):
    ERROR = "error"
    WARNING = "warning"
    INFO = "info"


class Scope(str, Enum):
    LINE = "line"
    SECTION = "section"
    AREA = "area"
    BOM = "bom"


class Status(str, Enum):
    OPEN = "open"
    ACCEPTED = "accepted"
    REJECTED = "rejected"
    APPLIED = "applied"
    STALE = "stale"


class Origin(str, Enum):
    RULE = "rule"
    LLM = "llm"


SettableField = Literal[
    "quantity", "unit", "short_text", "long_text", "pricing_basis", "total_rule", "alternative_for", "unit_price",
]


class SetField(_Model):
    op: Literal["set_field"] = "set_field"
    line_id: str
    field: SettableField
    old_value: Any = None
    new_value: Any = None


class NewLine(_Model):
    short_text: str
    long_text: str | None = None
    quantity: Decimal | None = None
    unit: str | None = None
    pricing_basis: Literal["unit_rate", "lump_sum"] = "unit_rate"


class AddLine(_Model):
    op: Literal["add_line"] = "add_line"
    section_id: str | None = None
    after_line_id: str | None = None
    line: NewLine
    distributions: list[Distribution] = Field(default_factory=list)


class RemoveLine(_Model):
    op: Literal["remove_line"] = "remove_line"
    line_id: str


class MergeLines(_Model):
    op: Literal["merge_lines"] = "merge_lines"
    keep_line_id: str
    remove_line_ids: list[str]
    new_quantity: Decimal | None = None


class LinkAlternative(_Model):
    op: Literal["link_alternative"] = "link_alternative"
    line_id: str
    alternative_for: str


Operation = Annotated[
    Union[SetField, AddLine, RemoveLine, MergeLines, LinkAlternative], Field(discriminator="op")
]


class Fix(_Model):
    operations: list[Operation]
    confidence: float = Field(ge=0, le=1)
    rationale: str


class Target(_Model):
    line_id: str | None = None
    line_code: str | None = None
    section_id: str | None = None
    area_id: str | None = None
    field: str | None = None


def finding_key(rule_id: str, target: Target, discriminator: str | None = None) -> str:
    """Stable id: the same problem on the same target gets the same id on every run."""
    parts = [rule_id, target.line_id or "", target.section_id or "", target.area_id or "", target.field or "",
             discriminator or ""]
    return "f_" + sha256("|".join(parts).encode("utf-8")).hexdigest()[:24]


class Finding(_Model):
    id: str
    layer: Literal[1, 2, 3]
    rule_id: str
    category: str
    severity: Severity
    scope: Scope
    target: Target
    related_line_ids: list[str] = Field(default_factory=list)
    title: str
    message: str
    evidence: dict[str, Any] = Field(default_factory=dict)
    suggested_fix: Fix | None = None
    origin: Origin = Origin.RULE
    model: str | None = None
    status: Status = Status.OPEN
    source_locator: dict[str, Any] | None = None

    @classmethod
    def create(cls, *, rule_id: str, layer: int, target: Target, discriminator: str | None = None,
               **fields: Any) -> Finding:
        """Build a finding with its stable id derived from rule, target and an optional discriminator."""
        return cls(id=finding_key(rule_id, target, discriminator), rule_id=rule_id, layer=layer, target=target,
                   **fields)


class Summary(_Model):
    total: int = 0
    by_layer: dict[str, int] = Field(default_factory=dict)
    by_severity: dict[str, int] = Field(default_factory=dict)
    by_category: dict[str, int] = Field(default_factory=dict)
    by_rule: dict[str, int] = Field(default_factory=dict)


class AnalysisResult(_Model):
    run_id: str = Field(default_factory=lambda: str(uuid4()))
    schema_version: str = SCHEMA_VERSION
    bom_version_id: str | None = None
    input_hash: str
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    layers_run: list[int] = Field(default_factory=list)
    findings: list[Finding] = Field(default_factory=list)
    summary: Summary = Field(default_factory=Summary)
    errors: list[str] = Field(default_factory=list)  # rules that crashed, layers not available
