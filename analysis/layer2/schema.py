"""Rule configuration using the schema in gaeb_dependency_validator_spec.md."""

import json
import re
from decimal import Decimal
from importlib.resources import files
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from ..units import UNITS


def compile_regex(pattern: str) -> re.Pattern:
    """Accept Python regexes and /pattern/i notation from the specification."""
    flags = re.IGNORECASE
    if pattern.startswith("/") and pattern.rfind("/") > 0:
        end = pattern.rfind("/")
        suffix = pattern[end + 1:]
        if any(flag not in "ims" for flag in suffix):
            raise ValueError(f"Unsupported regex flags: {suffix!r}")
        for flag in suffix:
            flags |= {"i": re.I, "m": re.M, "s": re.S}[flag]
        pattern = pattern[1:end]
    if not pattern.strip():
        raise ValueError("A rule regex cannot be empty")
    try:
        return re.compile(pattern, flags)
    except re.error as error:
        raise ValueError(f"Invalid regex: {error}") from error


class DependencySpec(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    name: str = Field(alias="DependencyName", min_length=1)
    regex: str = Field(alias="Regex")
    check_type: Literal["Boolean", "QuantityMatch"] = Field(alias="CheckType")
    tolerance: Decimal | None = Field(default=None, alias="TolerancePct", ge=0, lt=1)
    quantity_unit: str = Field(default="m²", alias="QuantityUnit")
    trigger_regex: str | None = Field(default=None, alias="TriggerRegex")
    suggested_text: str | None = Field(default=None, alias="SuggestedText")

    @field_validator("regex", "trigger_regex")
    @classmethod
    def valid_regex(cls, value: str | None) -> str | None:
        if value is not None:
            compile_regex(value)
        return value

    @field_validator("quantity_unit")
    @classmethod
    def valid_unit(cls, value: str) -> str:
        if value not in UNITS:
            raise ValueError("QuantityUnit must use the canonical unit vocabulary")
        return value

    @field_validator("name")
    @classmethod
    def valid_name(cls, value: str) -> str:
        if not re.search(r"[A-Za-z0-9]", value):
            raise ValueError("DependencyName needs an ASCII letter or digit for its rule ID")
        return value

    @property
    def key(self) -> str:
        return re.sub(r"[^A-Z0-9]+", "_", self.name.upper()).strip("_")


class RuleSpec(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    rule_id: str = Field(alias="RuleID", pattern=r"^L2\.[A-Z0-9_]+(?:\.[A-Z0-9_]+)*$")
    category: str = Field(alias="Category", min_length=1)
    trigger_regex: str = Field(alias="TriggerRegex")
    dependencies: list[DependencySpec] = Field(alias="Required_Dependencies", min_length=1)

    @field_validator("trigger_regex")
    @classmethod
    def valid_regex(cls, value: str) -> str:
        compile_regex(value)
        return value

    @field_validator("dependencies")
    @classmethod
    def unique_dependencies(cls, value: list[DependencySpec]) -> list[DependencySpec]:
        keys = [dependency.key for dependency in value]
        if len(set(keys)) != len(keys):
            raise ValueError("Dependency names must produce unique rule IDs")
        return value


def load_rules(path: str | Path | None = None) -> list[RuleSpec]:
    text = (Path(path).read_text(encoding="utf-8-sig") if path else
            files("analysis.layer2").joinpath("rules.json").read_text(encoding="utf-8"))
    payload = json.loads(text)
    if not isinstance(payload, list):
        raise ValueError("Rules must be a JSON array")
    rules = [RuleSpec.model_validate(rule) for rule in payload]
    ids = [f"{rule.rule_id}_NEEDS_{dep.key}" for rule in rules for dep in rule.dependencies]
    if len(ids) != len(set(ids)):
        raise ValueError("Rule IDs must be unique")
    return rules


def rule_metadata(rules: list[RuleSpec] | None = None) -> list[dict]:
    return [{
        "rule_id": f"{rule.rule_id}_NEEDS_{dep.key}", "layer": 2,
        "category": "dependency", "default_severity": "warning",
        "trade_category": rule.category,
        "description": f"{rule.category} requires {dep.name.lower()} ({dep.check_type}).",
    } for rule in (load_rules() if rules is None else rules) for dep in rule.dependencies]

