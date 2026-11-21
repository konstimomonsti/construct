# Task: Extended DIN & VOB/C Norms Implementation (Layer 1 Deterministic Rules)

**Target Branch:** `feat/extended-din-rules`  
**Execution Context:** `construct` repo (`backend/analysis/layer1/`)

---

## 1. Objective

Extend `backend/analysis/layer1/din.py` and `backend/analysis/layer1/textvalues.py` to enforce critical German construction standards (DIN norms) and VOB/C rules on tender positions (*Leistungsverzeichnis* / LV):

1. **DIN 18217 & DBV-Merkblatt "Sichtbeton"**: Enforce explicit fair-faced concrete classes (`SB1`–`SB4`).
2. **DIN 18533**: Check water-impact and waterproofing requirements for ground-contact precast elements (*FT-Sockel*, *erdberührte Bauteile*).
3. **DIN 4102 / DIN EN 13501**: Detect fire-resistance ratings (`F30`–`F120`, `REI 30`–`REI 120`), flag contradictions and unclassified fire walls.
4. **DIN 18331 (VOB/C ATV)**: Flag illegal opening deduction clauses (openings $\le 2.5\text{ m}^2$ or $\le 0.5\text{ m}^3$ are *Übermessungsgrößen* per VOB/C).
5. **DIN 488**: Enforce valid reinforcing steel designations (`B500A`, `B500B`, `B500NR`).
6. **DIN 18202 / 18203-1**: Detect ambiguous precast tolerance claims (*"erhöhte Genauigkeit"* without class definition).

---

## 2. Rules Specification

| Rule ID | Severity | Category | What it detects | Evidence & Bieterfrage |
|---|---|---|---|---|
| `L1.DIN.SICHTBETON_MISSING_CLASS` | `warning` | `din` | Mentions "Sichtbeton" or fair-faced concrete without specifying class `SB1`, `SB2`, `SB3`, or `SB4`. | **Bieterfrage:** `Zu Pos. {oz}: Es wird Sichtbeton gefordert, jedoch fehlt die Angabe der Sichtbetonklasse nach DBV/DIN 18217 (SB1 bis SB4) sowie die Schalungshaut- und Texturanforderung. Welche Klasse ist geschuldet?` |
| `L1.DIN.WATERPROOFING_MISSING` | `warning` | `din` | Precast plinth / sandwich element specified as ground-contact (*erdberührt*, *Sockel im Erdreich*) without specifying water-impact class (`W1-E`, `W1.1-E`, `W1.2-E`, `W2.1-E`, `W4-E`) or waterproofing type according to DIN 18533. | **Bieterfrage:** `Zu Pos. {oz}: Das Bauteil befindet sich im Erd-/Spritzwasserbereich. Gemäß DIN 18533 fehlt die Angabe der Wassereinwirkungsklasse (z. B. W1-E, W4-E) und der bauseits erforderlichen Abdichtungsmaßnahme.` |
| `L1.DIN.FIRE_RATING_CONFLICT` | `error` | `din` | Short and long text state conflicting fire ratings (e.g., `F30` vs `F90`, or `REI 30` vs `REI 60`), or mentions fire protection wall without class. | **Bieterfrage:** `Zu Pos. {oz}: Widersprüchliche oder unklare Brandschutzanforderung ({short_val} vs. {long_val}). Wir bitten um Bestätigung der maßgeblichen Feuerwiderstandsklasse nach DIN 4102 / DIN EN 13501.` |
| `L1.DIN.VOB_DEDUCTION_VIOLATION` | `warning` | `din` | Tender text specifies deduction (*Abzug*) of openings under the VOB/C DIN 18331 threshold ($\le 2.5\text{ m}^2$ for area or $\le 0.5\text{ m}^3$ for volume). | **Bieterfrage:** `Zu Pos. {oz}: Die Ausschreibung sieht den Abzug von Aussparungen kleiner als 2,5 m² bzw. 0,5 m³ vor. Gemäß VOB/C DIN 18331 Abs. 5 sind diese zu übermessen. Wir bitten um Klarstellung der Abrechnungseinheit.` |
| `L1.DIN.REBAR_UNKNOWN_GRADE` | `warning` | `din` | Reinforcing steel item states a grade that is not DIN 488 conformant (valid: `B500A`, `B500B`, `B500NR`, `Bst 500 S/M`). | **Bieterfrage:** `Zu Pos. {oz}: Der angegebene Betonstahl entspricht nicht der DIN 488 (z. B. B500A/B). Bitte bestätigen Sie die geforderte Duktilitätsklasse.` |
| `L1.DIN.TOLERANCE_UNSPECIFIED` | `info` | `din` | Mentions *"erhöhte Genauigkeit"* or *"Sondertoleranz"* without referencing DIN 18202 Table 3 line or DIN 18203-1 class. | **Bieterfrage:** `Zu Pos. {oz}: Es werden erhöhte Toleranzen gefordert, ohne Bezug auf DIN 18202 (Tab. 3) oder DIN 18203-1. Bitte definieren Sie die zulässigen Grenzabweichungen.` |

---

## 3. Files Allowed to Modify

Strict allowlist:
- `backend/analysis/layer1/textvalues.py`: Add regexes for `SICHTBETON` (`r"\bSB\s*[1-4]\b"`), `REBAR_GRADES` (`r"\bB\s*500\s*[ABNR]\b"`), `WATER_IMPACT` (`r"\bW[1-4](?:\.[1-2])?-E\b"`), `VOB_DEDUCTION` patterns.
- `backend/analysis/layer1/din.py`: Implement the 6 rules decorated with `@rule(..., category="din")`.
- `backend/analysis/tests/test_layer1_din.py`: Positive and negative test cases for each new rule.
- `docs/ANALYSIS_CONTRACT.md`: Update rule catalogue table.

---

## 4. Implementation Steps

1. **Extractors (`textvalues.py`)**:
   - Add regex helper functions:
     ```python
     SICHTBETON_CLASS = re.compile(r"\bSB\s*([1-4])\b", re.I)
     SICHTBETON_KEYWORD = re.compile(r"\bSichtbeton\w*\b", re.I)
     WATER_IMPACT = re.compile(r"\bW\s*[1-4](?:\.[1-2])?\s*-\s*E\b", re.I)
     ERDBERUEHRT = re.compile(r"\b(?:erdberührt\w*|Bodenkontakt|Spritzwasser\w*|Sockelelement|FT-Sockel)\b", re.I)
     REBAR_GRADES = re.compile(r"\b(?:B\s*500\s*[ABNR]|Bst\s*500\s*[SM])\b", re.I)
     REBAR_KEYWORD = re.compile(r"\b(?:Betonstahl|Bewehrung|Betonstabstahl|Bewehrungsstahl)\b", re.I)
     VOB_ILLEGAL_DEDUCTION = re.compile(r"\b(?:Aussparung\w*|Öffnung\w*)\s+(?:unter|<|bis)\s+2[,.]5\s*(?:m²|qm)\s+(?:abziehen|abzuziehen|in\s+Abzug)\b", re.I)
     ```
2. **Rules in `din.py`**:
   - Register rules using `@rule("L1.DIN.<NAME>", layer=1, category="din", severity=...)`.
   - Ensure each finding includes:
     - `message`: Clear English description.
     - `field`: `"short_text"` or `"long_text"`.
     - `evidence`: Dictionary containing technical facts and formal German `bieterfrage_de`.
3. **Tests in `test_layer1_din.py`**:
   - Write comprehensive tests:
     - `test_sichtbeton_missing_class_and_valid()`
     - `test_waterproofing_ground_contact()`
     - `test_fire_rating_consistency()`
     - `test_vob_illegal_deduction()`
     - `test_rebar_grades()`
     - `test_tolerance_unspecified()`

---

## 5. Verification Commands

Run in PowerShell from the repository root:
```powershell
$env:PYTHONPATH="construct/backend;construct/backend/importer"
& "C:\Users\Biel Barcelo\AppData\Local\Python\bin\python.exe" -m pytest -q construct/backend/analysis/tests/test_layer1_din.py
```

All analysis tests must be green with zero regressions:
```powershell
& "C:\Users\Biel Barcelo\AppData\Local\Python\bin\python.exe" -m pytest -q construct/backend/analysis/tests
```

---

## 6. Self-Destruction Routine (Crucial)

To guarantee that this task specification file leaves no trace after successful completion, execute the following auto-elimination step **as the very last command in the implementation pipeline**:

### PowerShell Self-Destruct:
```powershell
if ($?) {
    Remove-Item -Path "construct/tasks/task-din-extended-norms.md" -Force
    Write-Host "[AUTO-CLEANUP] Task specification construct/tasks/task-din-extended-norms.md successfully removed."
}
```

### Python Self-Destruct Snippet:
```python
import os
task_file = "construct/tasks/task-din-extended-norms.md"
if os.path.exists(task_file):
    os.remove(task_file)
    print(f"[AUTO-CLEANUP] {task_file} removed.")
```
