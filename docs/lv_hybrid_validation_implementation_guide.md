# Implementation Spec: Hybrid LV Risk & DIN Dependency Validator

This document is a **complete, implementation-ready technical specification** for building an automated validation pipeline for German construction tenders (*Leistungsverzeichnisse* / LVs), using **Stahlbetonfertigteile (Precast Concrete)** as the reference trade.

It is structured so a developer or AI coding agent can implement the full MVP end-to-end without ambiguity.

---

## 1. System Architecture & Data Flow

```text
[GAEB .x83 / PDF]
       │
       ▼
┌─────────────────────────────────┐
│ Step 1: Ingestion & OZ Chunking │  -> list[RawLVItem]
└────────────────┬────────────────┘
                 ▼
┌─────────────────────────────────┐
│ Step 2: Structured Extraction   │  -> list[PrecastElementItem]  (Fast LLM, temp=0.0)
└────────────────┬────────────────┘
                 ▼
┌─────────────────────────────────┐
│ Step 3: DIN & Dependency Engine │  -> list[ValidationFinding]   (Pure Python + JSON Rules)
└────────────────┬────────────────┘
                 ▼
┌─────────────────────────────────┐
│ Step 4: Cross-Item Scope Audit  │  -> list[ValidationFinding]   (Reasoning LLM, temp=0.0)
└────────────────┬────────────────┘
                 ▼
┌─────────────────────────────────┐
│ Step 5: Report & RFI Export     │  -> .xlsx Risk Matrix + .md Bieterfragen
└─────────────────────────────────┘
```

---

## 2. Project Setup, Environment & CLI Contract

### 2.1 Directory Structure

```text
lv-validator/
├── .env.example
├── requirements.txt
├── data/
│   ├── input/                     # Drop .x83 or .pdf files here
│   ├── output/                    # Generated .xlsx and .md reports
│   └── rules/
│       ├── din_1045_2_matrix.json # Concrete strength vs. exposure class rules
│       ├── dependencies.json      # Conditional mandatory field rules
│       └── vob_units.json         # Standard units per work type (DIN 18331)
├── src/
│   ├── __init__.py
│   ├── config.py                  # Env loading & constants
│   ├── models.py                  # ALL shared Pydantic data contracts
│   ├── utils.py                   # German float parsing & string normalization
│   ├── ingest/
│   │   ├── __init__.py
│   │   ├── gaeb_parser.py         # Namespace-agnostic GAEB XML (.x83/.d83) parser
│   │   └── pdf_parser.py          # Layout-aware PDF parser with page-break merging
│   ├── extract/
│   │   ├── __init__.py
│   │   ├── llm_client.py          # Abstract LLM interface + Google GenAI implementation
│   │   └── extractor.py           # RawLVItem -> PrecastElementItem
│   ├── validate/
│   │   ├── __init__.py
│   │   ├── deterministic.py       # Math, DIN 1045-2, Dependency, and VOB Unit checks
│   │   └── cross_item_llm.py      # Whole-LV scope & dependency auditor
│   ├── export/
│   │   ├── __init__.py
│   │   └── reporter.py            # Excel Risk Matrix & German Bieterfragen generator
│   └── main.py                    # CLI entrypoint & pipeline orchestrator
└── tests/
    ├── fixtures/
    │   └── lv11_sample_items.json # Offline fixture mirroring LV 11 Sandwich-Sockel
    ├── test_utils.py
    ├── test_deterministic.py
    └── test_lv11_golden.py        # End-to-end mocked pipeline regression tests
```

### 2.2 Dependencies (`requirements.txt`)

```text
pydantic>=2.7.0
pydantic-settings>=2.2.0
lxml>=5.2.0
pymupdf>=1.24.0
openpyxl>=3.1.2
google-genai>=1.0.0
tenacity>=8.3.0
pytest>=8.2.0
```

### 2.3 Environment Variables (`.env.example`)

```env
GEMINI_API_KEY=your_api_key_here
EXTRACTION_MODEL=gemini-2.5-flash
AUDIT_MODEL=gemini-2.5-pro
LLM_MAX_RETRIES=3
```

### 2.4 CLI Entrypoint (`src/main.py`)

Must support invocation via:

```bash
python -m src.main --input data/input/LV_11.pdf --output-dir data/output/
```

Optional flags:
* `--skip-cross-audit`: Run Steps 1–3 only (useful for fast deterministic testing).
* `--format [auto|gaeb|pdf]`: Defaults to `auto` (inferred from file extension `.x83`/`.d83`/`.xml` vs `.pdf`).

---

## 3. Shared Data Contracts (`src/models.py`)

All modules **must** communicate strictly using these Pydantic v2 models. Do not pass untyped dictionaries between pipeline stages.

```python
from pydantic import BaseModel, Field
from typing import Optional, Literal


class RawLVItem(BaseModel):
    """Output of Step 1 (Ingestion)."""
    oz: str = Field(..., description="Ordnungszahl, normalized without trailing dot, e.g. '3.2.40'")
    category_title: Optional[str] = Field(None, description="Parent section, e.g. '3.2. Stahlbetonfertigteile'")
    short_text: str = Field("", description="Short title / first line of position")
    long_text: str = Field(..., description="Full cleaned Leistungsbeschreibung text")
    quantity: Optional[float] = Field(None, description="Parsed float quantity, e.g. 1.0 or 0.7")
    unit: Optional[str] = Field(None, description="Normalized unit, e.g. 'St', 'TO', 'm', 'PSCH'")
    source_pages: list[int] = Field(default_factory=list, description="1-indexed PDF pages (empty for GAEB)")


class LayerSpec(BaseModel):
    facing_shell_cm: Optional[float] = Field(None, description="Dicke Vorsatzschale in cm")
    insulation_cm: Optional[float] = Field(None, description="Dicke Dämmschicht in cm")
    insulation_material: Optional[str] = Field(None, description="e.g. 'XPS, WLG 035'")
    structural_shell_cm: Optional[float] = Field(None, description="Dicke Tragschale in cm")
    total_thickness_cm: Optional[float] = Field(None, description="Gesamtdicke d in cm")


class PrecastElementItem(BaseModel):
    """Output of Step 2 (LLM Extraction)."""
    oz: str
    item_type: Literal[
        "sandwich_plinth",
        "shop_drawings",
        "rebar",
        "opening_surcharge",
        "embedded_part",
        "other",
    ]
    element_code: Optional[str] = Field(None, description="e.g. 'FS 01', 'FS 03'")
    quantity: Optional[float] = None
    unit: Optional[str] = None
    length_m: Optional[float] = None
    height_m: Optional[float] = None
    layers: Optional[LayerSpec] = None
    concrete_grade: Optional[str] = Field(None, description="Normalized, e.g. 'C35/45'")
    exposure_classes: list[str] = Field(default_factory=list, description="e.g. ['XC2', 'XF2', 'WA']")
    surface_inside: Optional[str] = Field(None, description="e.g. 'SB2'")
    surface_outside: Optional[str] = Field(None, description="e.g. 'SB2'")
    is_through_colored: bool = False
    color_pigment_ral: Optional[str] = Field(None, description="Exact RAL or pigment spec if stated")
    includes_transport_and_mounting: bool = False
    includes_anchor_engineering: bool = False
    axis_location: Optional[str] = Field(None, description="Einbauort, e.g. 'Achse D/1'")
    has_redacted_or_unclear_text: bool = Field(
        False, description="True if placeholders like [FIRMA_095], [KENNZEICHEN_005], or '?' appear"
    )
    unclear_text_evidence: Optional[str] = Field(
        None, description="Exact snippet triggering has_redacted_or_unclear_text"
    )


class ValidationFinding(BaseModel):
    """Unified output of Step 3 (Deterministic) and Step 4 (Cross-Item LLM)."""
    oz: str = Field(..., description="Single OZ like '3.2.40', or comma-separated '3.2.70, 3.2.20-3.2.60'")
    rule_id: str = Field(..., description="e.g. 'MATH_001', 'DIN_001', 'DEP_001', 'VOB_001', 'LLM_SCOPE_01'")
    source: Literal["DETERMINISTIC", "LLM_CROSS_AUDIT"]
    severity: Literal["HIGH", "MEDIUM", "INFO"]
    category: Literal["MATH", "DIN_COMPLIANCE", "MISSING_SPEC", "UNIT_MISMATCH", "SCOPE_AMBIGUITY", "OPTIMIZATION", "TEXT_DEFECT"]
    issue_description: str
    recommended_action: str
    bieterfrage_de: Optional[str] = Field(
        None, description="Polite, formal German clarification question for the client (Auftraggeber)"
    )


class CrossItemAuditResponse(BaseModel):
    """Structured output wrapper for Step 4 LLM call."""
    findings: list[ValidationFinding] = Field(default_factory=list)
    total_bundled_precast_length_m: Optional[float] = None


class PipelineResult(BaseModel):
    """Final aggregated object passed to Step 5 Reporter."""
    source_file: str
    raw_items: list[RawLVItem]
    extracted_items: list[PrecastElementItem]
    findings: list[ValidationFinding]
```

---

## 4. Utility & Normalization Rules (`src/utils.py`)

Implement these deterministic helpers and test them thoroughly in `tests/test_utils.py`:

1. **`parse_german_float(val: str) -> float`**:
   * Strips whitespace.
   * Removes thousands separators `.` and replaces decimal comma `,` with `.`.
   * Examples: `"1,000"` $\rightarrow$ `1.0`, `"1.250,50"` $\rightarrow$ `1250.5`, `"0,700"` $\rightarrow$ `0.7`.
2. **`normalize_oz(oz: str) -> str`**:
   * Strips whitespace and trailing dots: `"3.2.40. "` $\rightarrow$ `"3.2.40"`.
3. **`normalize_unit(unit: str | None) -> str | None`**:
   * Maps common German tender aliases to canonical values:
     * `"S"`, `"St."`, `"Stk"`, `"Stk."`, `"ST"` $\rightarrow$ `"St"`
     * `"to"`, `"To"`, `"t"`, `"TO"` $\rightarrow$ `"TO"`
     * `"psch"`, `"Psch"`, `"PA"`, `"PSCH"` $\rightarrow$ `"PSCH"`
     * `"lfm"`, `"m"`, `"M"` $\rightarrow$ `"m"`
     * `"m2"`, `"m²"`, `"qm"` $\rightarrow$ `"m2"`
4. **`normalize_concrete_grade(grade: str | None) -> str | None`**:
   * Uppercase and remove internal spaces: `"c 35 / 45"` $\rightarrow$ `"C35/45"`.

---

## 5. Step-by-Step Module Implementation

### Step 1: Ingestion & OZ Chunking (`src/ingest/`)

#### 1A. Namespace-Agnostic GAEB XML Parser (`gaeb_parser.py`)
Real German GAEB files (`.x83`, `.d83`, `.xml`) vary between GAEB DA XML 3.1, 3.2, and 3.3 and declare XML namespaces (e.g., `xmlns="http://www.gaeb.de/GAEB_DA_XML/DA83/3.2"`).

* **CRITICAL:** Never hardcode namespace URLs. Use `lxml` wildcard element matching (`{*}`) or `local-name()` XPath:
  * Find all categories: `tree.xpath("//*[local-name()='BoQCtgy']")`
  * Build hierarchical `oz` by joining ancestor `BoQCtgy/@RNoPart` + `Item/@RNoPart` with `"."` (e.g., `3` + `2` + `40` $\rightarrow$ `"3.2.40"`).
  * Extract `<Qty>` $\rightarrow$ `float`, `<QU>` $\rightarrow$ `normalize_unit(...)`.
  * Extract `<OutlineText>` for `short_text` and join all text nodes inside `<DetailTxt>` (using `"".join(detail_node.itertext())`) for `long_text`.
  * Handle both `UTF-8` and `ISO-8859-1` encodings automatically via `lxml.etree.XMLParser(recover=True)`.

#### 1B. Layout-Aware PDF Parser (`pdf_parser.py`)
PDFs frequently split single positions across pages (e.g., `3.2.30. FS 02` starts on Page 1 and its quantity `1,000 St` appears on Page 2) and place the `OZ` column horizontally adjacent to text.

1. Open with `fitz.open(path)`.
2. For each page:
   * Extract text using `page.get_text("text", sort=True)`.
   * **Strip repeating headers/footers** line-by-line using regex filters:
     * Skip lines matching: `^(Projekt:|LV:|Anfrage|Druckdatum:|Seite:\s*\d+|Übertrag:|Summe\s+|Zuzüglich|Das LV besteht|Tel\.|\[FIRMA_|\[BILD_|\[EMAIL_)`.
     * Skip table header lines containing both `OZ` and `Leistungsbeschreibung`.
3. Track page boundaries while joining cleaned lines into a single stream.
4. **Chunk by OZ**:
   * Match OZ markers using `re.compile(r"(?:^|\s)(\d+\.\d+\.\d+\.?)(?=\s|$)")`.
   * *Edge case guard:* In some PDF tables (like Page 4 of LV 11), `3.2.80.` or `3.2.90.` may appear *after* the title line due to column layout. Always verify that each extracted OZ chunk contains at least 20 characters; if an OZ appears at the end of a block with no following text before the next OZ, attach the preceding un-indexed lines to it.
5. **Extract trailing Quantity & Unit** from each chunk:
   * Regex: `r"(\d{1,3}(?:\.\d{3})*,\d{2,3})\s+(St\.?|Stk\.?|S|m2|m²|m3|m|TO|to|kg|PSCH|psch)\b"`
   * Take the **last** match in the chunk (to avoid matching dimensions like `l=1,25m` inside the description).
   * Parse with `parse_german_float` and `normalize_unit`.

---

### Step 2: Structured Extraction (`src/extract/`)

#### 2A. LLM Client Abstraction (`llm_client.py`)
Define an abstract base class `LLMClient` so unit tests can inject a `MockLLMClient` with zero network calls:

```python
from abc import ABC, abstractmethod
from typing import TypeVar, Type
from pydantic import BaseModel

T = TypeVar("T", bound=BaseModel)

class LLMClient(ABC):
    @abstractmethod
    def generate_structured(
        self,
        system_prompt: str,
        user_prompt: str,
        response_schema: Type[T],
        model_name: str,
    ) -> T:
        ...
```

Implement `GeminiLLMClient(LLMClient)` using `google-genai`:
* Always pass `temperature=0.0`.
* Use native structured outputs: `config=types.GenerateContentConfig(system_instruction=system_prompt, response_mime_type="application/json", response_schema=response_schema, temperature=0.0)`.
* Wrap the API call with `tenacity.retry` (exponential backoff, max 3 attempts on 429/5xx errors).
* Validate and return `response_schema.model_validate_json(response.text)`.

#### 2B. Extractor (`extractor.py`)
Loop over `list[RawLVItem]` and call `llm_client.generate_structured(..., response_schema=PrecastElementItem, model_name=config.EXTRACTION_MODEL)`.
* After LLM extraction, **force-overwrite** `item.oz = raw.oz` and, if `raw.quantity is not None`, prefer the deterministic parser's `raw.quantity` and `raw.unit` over the LLM's guess.
* Apply `normalize_concrete_grade` and `normalize_unit` to the extracted object.

**Exact Extraction System Prompt:**
> You are a strict German construction quantity surveyor (Kalkulator) data extractor. Extract technical parameters from the provided German LV position into the required JSON schema.
> Rules:
> 1. Convert all lengths and heights to meters (`m`) and all layer thicknesses to centimeters (`cm`).
> 2. Never invent, estimate, or infer missing values. If height (`Höhe`) or exact color/RAL/pigment is not explicitly written in the text, return `null`.
> 3. Classify `item_type` strictly: use `sandwich_plinth` for FT-Sockel/Sandwichelement, `shop_drawings` for Werkstattzeichnungen/Montagepläne, `rebar` for Betonstahl, `opening_surcharge` for Zulage Aussparungen/Öffnungen, `embedded_part` for Halfen/Ankerschienen/Einbauteile, else `other`.
> 4. Set `has_redacted_or_unclear_text = true` and populate `unclear_text_evidence` if you see question marks in dimensions (e.g., `d=? 30cm`) or redacted/missing placeholders like `[FIRMA_095]` or `[KENNZEICHEN_005]`.

---

### Step 3: Deterministic DIN & Dependency Engine (`src/validate/deterministic.py`)

Load all three JSON files from `data/rules/` at startup.

#### 3A. Rule Files (`data/rules/`)

**`din_1045_2_matrix.json`**:
```json
{
  "strength_rank": {
    "C16/20": 1, "C20/25": 2, "C25/30": 3,
    "C30/37": 4, "C35/45": 5, "C40/50": 6, "C45/55": 7, "C50/60": 8
  },
  "exposure_min_strength": {
    "XC1": "C16/20", "XC2": "C16/20", "XC3": "C20/25", "XC4": "C25/30",
    "XF1": "C25/30", "XF2": "C25/30", "XF3": "C25/30", "XF4": "C30/37",
    "XD1": "C30/37", "XD2": "C35/45", "XD3": "C35/45",
    "XS1": "C30/37", "XS2": "C35/45", "XS3": "C35/45"
  },
  "special_notes": {
    "XF2": "Verify whether air-entrained concrete (LP-Beton) is required or if C35/45 without LP is accepted per DIN 1045-2.",
    "WA": "Alkali-Richtlinie (Feuchtigkeitsklasse WA) applies: verify alkali-resistant aggregate certification with precast plant."
  }
}
```

**`dependencies.json`**:
```json
[
  {
    "rule_id": "DEP_001",
    "severity": "HIGH",
    "category": "MISSING_SPEC",
    "if": { "item_type": "sandwich_plinth" },
    "require_non_null": ["height_m", "length_m", "concrete_grade", "layers.total_thickness_cm"],
    "message": "Missing critical geometric or concrete specification ({missing_fields}) needed for formwork and pricing.",
    "recommended_action": "Request missing dimensions/specs from architectural drawings before pricing.",
    "bieterfrage_de": "Zu Pos. {oz}: Für die Kalkulation fehlen folgende Angaben: {missing_fields}. Wir bitten um Ergänzung bzw. Zusendung der zugehörigen Ansichts-/Schnittpläne."
  },
  {
    "rule_id": "DEP_002",
    "severity": "HIGH",
    "category": "MISSING_SPEC",
    "if": { "is_through_colored": true },
    "require_non_null": ["color_pigment_ral"],
    "message": "Through-colored concrete ('durchgefärbt') is specified, but no RAL tone or pigment dosage is defined.",
    "recommended_action": "Clarify pigment color and dosage; dark/bright pigments add €30–€100+/m³ plus minimum batch surcharges.",
    "bieterfrage_de": "Zu Pos. {oz}: Es wird durchgefärbter Beton ausgeschrieben, jedoch ohne Angabe des Farbtons (z. B. RAL) oder der Pigmentdosierung. Welcher Farbton ist zu kalkulieren?"
  },
  {
    "rule_id": "DEP_003",
    "severity": "MEDIUM",
    "category": "TEXT_DEFECT",
    "if": { "has_redacted_or_unclear_text": true },
    "require_non_null": [],
    "always_trigger": true,
    "message": "Source text contains typo, unclear dimension, or missing product identifier ({unclear_text_evidence}).",
    "recommended_action": "Verify exact product type/dimension with the client before binding offer.",
    "bieterfrage_de": "Zu Pos. {oz}: Der Ausschreibungstext enthält unklare bzw. unvollständige Angaben ({unclear_text_evidence}). Wir bitten um Klarstellung des genauen Fabrikats/Typs bzw. der Abmessung."
  }
]
```

**`vob_units.json`**:
```json
{
  "sandwich_plinth": ["St", "m2", "m"],
  "rebar": ["TO", "kg"],
  "opening_surcharge": ["St"],
  "embedded_part": ["St", "m"],
  "shop_drawings": ["PSCH", "Std"]
}
```

#### 3B. Exact Deterministic Evaluator Logic (`deterministic.py`)

Implement `run_deterministic_checks(items: list[PrecastElementItem], rules_dir: Path) -> list[ValidationFinding]`:

1. **Nested Attribute Helper**: Implement `get_nested(obj, "layers.total_thickness_cm")` so dot-paths in `dependencies.json` resolve cleanly against Pydantic models (returning `None` if an intermediate object is `None`).
2. **Check 1 — Layer Math (`MATH_001`)**:
   * If `item.layers` is not `None` and all four values (`facing_shell_cm`, `insulation_cm`, `structural_shell_cm`, `total_thickness_cm`) are present:
     * Compute $\Delta = |(t_{\text{facing}} + t_{\text{insulation}} + t_{\text{structural}}) - t_{\text{total}}|$.
     * If $\Delta > 0.1$: emit `ValidationFinding(rule_id="MATH_001", severity="HIGH", category="MATH", ...)`.
3. **Check 2 — DIN 1045-2 Compliance (`DIN_001` & `DIN_NOTE`)**:
   * If `item.concrete_grade` is present:
     * Look up `actual_rank = strength_rank.get(item.concrete_grade)`.
     * If `actual_rank is None`: emit `MEDIUM` warning for unknown concrete grade.
     * Else for each `exp` in `item.exposure_classes`:
       * If `exp` in `exposure_min_strength`: compare `actual_rank < strength_rank[min_grade]`. If under-specified, emit `HIGH` finding (`DIN_001`).
       * If `exp` in `special_notes`: emit `INFO` finding (`DIN_NOTE_{exp}`).
4. **Check 3 — Conditional Dependencies (`DEP_xxx`)**:
   * For each rule in `dependencies.json`:
     * Evaluate `rule["if"]` using **AND** logic (all key-value pairs must match `get_nested(item, key) == expected`).
     * If matched:
       * If `rule.get("always_trigger")` is `True`: emit finding, formatting `{oz}` and `{unclear_text_evidence}`.
       * Else collect `missing = [f for f in rule["require_non_null"] if get_nested(item, f) is None]`. If `missing` is non-empty, emit finding formatting `{oz}` and `{missing_fields}`.
5. **Check 4 — VOB/C Unit Validation (`VOB_001`)**:
   * Look up `allowed = vob_units.get(item.item_type)`.
   * If `allowed` and `item.unit` and `item.unit not in allowed`:
     * Emit `MEDIUM` finding (`VOB_001`, category `UNIT_MISMATCH`) with German *Bieterfrage* asking whether billing is intended per `allowed[0]` instead of `item.unit`.

---

### Step 4: Cross-Item Scope & Dependency Auditor (`src/validate/cross_item_llm.py`)

Pass the **entire serialized `list[PrecastElementItem]`** (clean JSON, not raw PDF text) to `llm_client.generate_structured(..., response_schema=CrossItemAuditResponse, model_name=config.AUDIT_MODEL)`.

**Exact Cross-Item Audit System Prompt:**
> You are a senior German construction estimator (Oberkalkulator) auditing a normalized precast concrete LV. All single-item math, DIN, and missing-field checks have already been run—DO NOT repeat them.
> Focus EXCLUSIVELY on cross-item relationships and return a `CrossItemAuditResponse`:
> 1. `LLM_SCOPE_01` (`SCOPE_AMBIGUITY`, `HIGH`): Check if rebar (`item_type == "rebar"`) is tendered separately from precast elements (`sandwich_plinth`) without clarifying whether it is internal factory reinforcement or on-site connection steel.
> 2. `LLM_SCOPE_02` (`SCOPE_AMBIGUITY`, `MEDIUM`): Check if `shop_drawings` (`Werkstattzeichnungen`) overlaps with `includes_anchor_engineering` inside the precast positions.
> 3. `LLM_SCOPE_03` (`SCOPE_AMBIGUITY`, `MEDIUM`): Check if `embedded_part` (e.g., Halfen rails) lacks allocation to specific `element_code`s (`FS 01`–`FS 05`).
> 4. `LLM_OPT_01` (`OPTIMIZATION`, `INFO`): Group identical precast cross-sections (same thickness, concrete grade, surface finish) and calculate `total_bundled_precast_length_m` to highlight formwork/pigment amortization.
> For every `HIGH` and `MEDIUM` finding, write a polite, concise German `bieterfrage_de` referencing the exact OZ numbers.
> Set `source = "LLM_CROSS_AUDIT"` on all returned findings.

---

### Step 5: Report & *Bieterfragen* Export (`src/export/reporter.py`)

Generate two files inside `--output-dir` named `<stem>_Risk_Report.xlsx` and `<stem>_Bieterfragen.md`:

#### 5A. Excel Workbook (`openpyxl`)
* **Tab 1: `Summary`**
  * Source filename, total LV items parsed, counts by severity (`HIGH`, `MEDIUM`, `INFO`), count by source (`DETERMINISTIC` vs `LLM_CROSS_AUDIT`), total precast element count & bundled length (m).
* **Tab 2: `Normalized_Specs`**
  * Columns: `OZ | Type | Element | Qty | Unit | Length (m) | Height (m) | Total Thick. (cm) | Concrete | Exposure | Through-Colored | RAL/Pigment | Axis`
  * **Conditional Highlighting:** For any row where `Type == "sandwich_plinth"`, fill any `None`/empty cell in `Height (m)` or `RAL/Pigment` (when `Through-Colored == True`) with light red `#FFC7CE`.
* **Tab 3: `Findings_Log`**
  * Columns: `OZ | Rule ID | Source | Severity | Category | Issue Description | Recommended Action | Bieterfrage (DE)`
  * Sort by severity (`HIGH` $\rightarrow$ `MEDIUM` $\rightarrow$ `INFO`), then by `OZ`.
  * Fill `Severity` cell: `HIGH` = `#FFC7CE` (red), `MEDIUM` = `#FFEB9C` (amber), `INFO` = `#DDEBF7` (blue).
  * Auto-adjust column widths and enable text wrapping (`wrap_text=True`) + freeze top row (`A2`).

#### 5B. Draft *Bieterfragen* (`<stem>_Bieterfragen.md`)
* Filter `findings` where `severity in ("HIGH", "MEDIUM")` and `bieterfrage_de is not None`.
* Deduplicate identical/grouped questions (e.g., if `DEP_001` triggers on `3.2.20`–`3.2.60`, group them as `Pos. 3.2.20 – 3.2.60`).
* Render a ready-to-send German email template addressed to *Sehr geehrte Damen und Herren,* with a numbered list of questions.

---

## 6. Two-Tier Testing Strategy (`tests/`)

### 6.1 Offline Unit & Golden Tests (No API Key Required)
Create `tests/fixtures/lv11_sample_items.json` containing the 9 positions from `LV_11_Stahlbetonfertigeile_Sandwichsockel.pdf` (`3.2.10` through `3.2.90`). Inject a `MockLLMClient` that returns deterministic `PrecastElementItem` and `CrossItemAuditResponse` fixtures so `pytest` runs in `< 1 second` in CI/CD.

**Mandatory Assertions in `tests/test_lv11_golden.py`:**

| Assertion | Target OZ | Expected Result | Verified Layer |
| :--- | :--- | :--- | :--- |
| German number parsing | `3.2.20`, `3.2.70` | `"1,000 St"` $\rightarrow$ `1.0, "St"`; `"0,700 TO"` $\rightarrow$ `0.7, "TO"` | `utils.py` |
| Layer math passes | `3.2.20`–`3.2.60` | $7 + 8 + 15 = 30\text{ cm}$ $\rightarrow$ no `MATH_001` error | `deterministic.py` |
| Layer math fails (negative test) | synthetic item | $7 + 10 + 15 \neq 30\text{ cm}$ $\rightarrow$ `MATH_001` (`HIGH`) | `deterministic.py` |
| DIN 1045-2 check | `3.2.20`–`3.2.60` | `C35/45` satisfies `XC2, XF2`; emits `DIN_NOTE_XF2` & `DIN_NOTE_WA` | `deterministic.py` |
| DIN 1045-2 fail (negative test) | synthetic item | `C20/25` with `XF2` $\rightarrow$ `DIN_001` (`HIGH`) | `deterministic.py` |
| Missing height | `3.2.20`–`3.2.60` | `DEP_001` (`HIGH`) | `deterministic.py` |
| Missing pigment/RAL | `3.2.20`–`3.2.60` | `DEP_002` (`HIGH`) | `deterministic.py` |
| Typo / Redaction | `3.2.30`, `3.2.80`, `3.2.90` | `DEP_003` (`MEDIUM`) | `deterministic.py` |
| Unit mismatch | `3.2.80` | `VOB_001` (`MEDIUM`): `m` not in `["St"]` | `deterministic.py` |
| Cross-item rebar audit | `3.2.70` | `LLM_SCOPE_01` (`HIGH`) | `cross_item_llm.py` |
| Report generation | All | `.xlsx` has 3 sheets; `.md` contains numbered *Bieterfragen* | `reporter.py` |

### 6.2 Live Integration Test (`@pytest.mark.integration`)
Add an optional test marked `@pytest.mark.integration` (skipped unless `GEMINI_API_KEY` is set and `LV_11_Stahlbetonfertigeile_Sandwichsockel.pdf` exists in `data/input/`) that runs the full pipeline end-to-end on the real PDF.