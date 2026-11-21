# Implementation plan for the next features

Date: 21 November 2026. Seven read-only research passes produced this plan, one per roadmap feature. Each pass read the code and docs and measured its proposals on the real files in `Data/`. Nothing in the code was changed. The order follows the roadmap deck ("Construct: Next Steps"): error detection first because the brief marks it as the priority, then risk and change orders, the risk report, proof on known-error BoQs, Excel, and prices/what-if. The pitch (step 5) is not a code feature and is not covered here.

Start with [ANALYSIS_LAYERS.md](ANALYSIS_LAYERS.md) and [ANALYSIS_PHASE_SUMMARY.md](ANALYSIS_PHASE_SUMMARY.md) if you are new to the code.

## 0. Read this first: findings that affect several features

1. **The wrong `pdftotext` breaks PDF import silently.** In Git Bash, `pdftotext` resolves to `C:\Program Files\Git\mingw64\bin\pdftotext.exe`, which is xpdf 4.00, not Poppler. PowerShell and the running webapp find MiKTeX's Poppler 24.04. xpdf scrambles the column layout:

   | PDF | Poppler | xpdf |
   |---|---|---|
   | HEM2301-2_Gesamt-LV | 159 positions, all correct | 2 positions |
   | LV-Ausdruck-[PROJEKT_004] | 50 | 0 |
   | LV_13_ELT / LV_14_Sanitaer | 146 / 168 | 13 / 0 |
   | All 27 `LV_xx` files | 1085 lines | 191 lines |

   This is why earlier runs reported "most trade PDFs import 0–14 lines". With Poppler they import fine. **Fix F0** (section 1) makes the importer check `pdftotext -v` and refuse or warn on xpdf.

2. **PDF item flags are ignored by the adapter.** The PDF parser sets `unit_price_only`, `provisional_included`, `alternative_item` and `base_item`. `analysis/adapter.py::derive_pricing` only reads the GAEB names (`Provis`, `AltItem`, `position_type`, `provisional_flag`), and `clean_flags` turns `False` into the string `"False"`. As a result:
   - the 146 "*** Bedarfsposition ohne GB" lines in the PDFs count in totals;
   - `L1.STRUCT.PROVISIONAL_ITEM` never fires on PDFs;
   - layer 2 counts those lines as covering dependencies;
   - their short text is the marker, so the real short text is lost.

   `draft.py` already reads these flags. Note: there is uncommitted work in the tree right now that also edits `derive_pricing` (for `MarkupItem`), so coordinate before changing it.

3. **`Data/` does contain a building project.** `LV_00`–`LV_23` are one training centre plus office, split by trade: Estrich, Trockenbau, Maler, Dachabdichtung, Rohbau, ELT, Sanitär, Fliesen and doors. The docs say there are no buildings. Correct them, and use these files to test layer 2 on real data.

4. **Line and finding ids depend on the file's hash.** They are `uuid5(sha256(file), xml_path)`, so the same file always gets the same finding ids and decisions survive re-analysis. A revised or mutated file gets new ids. Evaluation labels, and decisions carried over to a revised tender, must therefore key on the OZ (`line_code`), the section code or layer 2 trigger codes.

5. **Doc correction:** `ANALYSIS_LAYERS.md` says GAEB XML subtotals are not extracted. `structured.py` does read `Totals/Total` for `BoQCtgy` and `BoQInfo`, so the subtotal checks run on GAEB XML.

6. **Team decisions this plan needs** are collected in section 8: the contract change for risk, new dependencies and licences.

## Recommended order

| # | Work package | Roadmap step | Effort | Depends on |
|---|---|---|---|---|
| 1 | PDF fixes F0–F6 + golden pair test | 1 | S–M (~1 day) | none |
| 2 | Deterministic contradiction rule `L1.TEXT.VALUE_CONFLICT` | 1 | S–M | none |
| 3 | Risk signals as layer 1 rules + `analysis/risk/assess()` | 2 | M (2–3 days for tasks 1–7) | contract decision |
| 4 | Report: decisions store, risk summary, bidder questions, print | 3 | M (1.5–2 days) | 3 (fallback available) |
| 5 | Layer 2 new trades + engine tweaks | 1 | M | 1 |
| 6 | Building seed, mutator, eval harness, real-findings labels | 4 | M (~2 days) | 1, 2 |
| 7 | Reference, placeholder and attribute rules; typo rules | 1 | M + M | 2 |
| 8 | Excel import | 6 | M (1–1.5 days) | none |
| 9 | Reference prices + what-if | 7 | M–L (3–4 days) | 3 for the risk delta |
| 10 | `L3.TEXT.UNDERSPECIFIED`, `L3.QTY.IMPLAUSIBLE` | 1, 2 | M | a running local model |

Packages 1, 2, 3 and 8 touch different files and can run in parallel.

---

## 1. PDF extraction quality (step 1, "fewer false alarms")

**Baseline with Poppler**, on the GAEB/PDF pairs that really are the same document:

| PDF | GAEB | Positions found | Qty and unit right |
|---|---|---|---|
| Angebot AN24-0305.pdf | Angebot AN24-0305.D84 | 274/274 | 274 (unit prices 274/274) |
| Leistungsverzeichnis.pdf | same D84 | 274/274 | 274 |
| HEM2301-2_Gesamt-LV.pdf | 8209.003_…X83 | 159/159 | 159 |
| LV-Ausdruck-[PROJEKT_004].pdf | GAEB-[PROJEKT_004].X83 | 50/50 | 50 |
| Abgabe LV.pdf | [NUMMER_001]_leer.X83 | 241/248 | 239 |
| Leistungsverzeichnis_leer.pdf | [NUMMER_001]_leer.X83 | 240/248 | 238 |

Overall, 98.8% of positions are found and 99.7% of those have the right quantity and unit. There are no wrong values, only empty ones. Note: `Leistungsverzeichnis_leer.pdf` is not the 8209.003 document.

**Causes of the 73 lines with no quantity or unit.** Layer 1 reported each one three times (QTY.MISSING error, UNIT.MISSING error, IMPORT.WARNING), so there were 219 false findings:

| Cause | Lines | Example |
|---|---|---|
| A. One space between the unit and the dotted tail (`1,000 PSCH .....`) | 57 | LV_12 6.1.10, LV_18 11.1.10, LV_00 (49 items) |
| B. Quantity with no unit in the source | 1 | LV_00 1.4.7 (a real finding) |
| C. A 4-level OZ heading read as an item | 11 | LV_13 1.3.1., 1.4.1. |
| D. Garbled header on a continuation page, so the whole page is skipped | 4, plus 15 positions lost | Abgabe LV p.29/31, Leistungsverzeichnis_leer p.21/47 |

Other problems: E is the marker line used as the short text (146 lines, false `L1.DUP.SUSPECTED`). F is the flag mapping in finding 0.2. G is relative OZ codes like `.21` in LV_14a/b/c (110 lines).

**Fixes, in order.** Fixes F1–F4 were prototyped and measured.
- **F0 (S):** in `pdf.py::poppler()`, take the binary from an optional `POPPLER_BIN`, run `pdftotext -v` once, and raise or warn if it is not Poppler. Document it in the README.
- **F1 (S):** `_QUANTITY` accepts one space before a dotted tail: `^(?P<quantity>N)\s+(?P<unit>\S+)(?P<tail>(?:(?:[ \t]{2,}|[ \t]+(?=\.{3,}))\S.*)?)$`. This fixes all 57 cause-A lines. Don't exclude `.` from the unit, which breaks PROJEKT_004.
- **F2 (S/M):** accept a header that starts with `OZ`/`Pos-Nr.` when "Menge" appears within the next two lines. Optionally reuse the previous page's header, with a `pdf_header_inferred` warning. This recovers the 15 lost positions.
- **F3 (S):** if the current item has no amounts and the next code extends its code, turn it into a section, inline. A post-pass leaves the new sections empty.
- **F4 (S):** treat `N  .....` as quantity only, with unit None, so the real missing-unit finding stays.
- **F5 (S):** `derive_pricing` maps the PDF boolean flags the way `draft.py` does (finding 0.2).
- **F6 (S):** skip `*** Bedarfs-/Wahl-/Grund-/Eventualposition…` lines when choosing the short text.
- **F7 (S/M, safety net):** a fallback scan for `<number> <unit> ....` in the item's lines, marked `quantity_source: "fallback"`.
- **F8 (M):** when the source is a PDF and a `pdf_quantity_review` warning matches the line, emit QTY/UNIT.MISSING as a warning ("could not be read from the PDF, page N"), drop the duplicate IMPORT.WARNING, and group the remaining import warnings by code. No change to `contracts.py` is needed.

**Measured effect of F1–F4:** QTY.MISSING 73 → 0, UNIT.MISSING 73 → 1 (the real one), IMPORT.WARNING 73 → 0. All 6 pairs reach 100% of positions found and 100% quantity/unit agreement, with no regressions.

**Tests:** synthetic `dedent` layout snippets in `importer/tests/test_formats.py`, one per cause plus the xpdf banner. A golden pair test compares each PDF with its GAEB pair by normalised OZ and is skipped when Poppler is missing. A per-file check asserts the expected QTY/UNIT.MISSING counts for the `LV_xx` files.

## 2. Error-detection rules (step 1)

Do the PDF fixes first: the P0 items above are the same ones. One more small fix: add `messung|\w*feuchte|belegreife` to the screed `ExcludeRegex`, because "Messung Estrichfeuchte" in LV_08 triggers 4 false findings.

### 2.1 Contradictions without an LLM: `L1.TEXT.VALUE_CONFLICT` (S–M)
A shared extractor `layer1/textvalues.py` pulls values per family from the short and long text. A finding is raised when both texts state a value of the same family and no value is shared.

Families: DN `\bDN\s?(\d{2,4})\b`, concrete class `\b(L?C)\s?(\d{1,3})\s?/\s?(\d{1,3})\b`, fire rating `\b(T|EI2?|F)\s?-?(30|60|90|120)\b`, IP rating, board type `GKBI|GKFI|GKB|GKF`, screed class, cable cross-section, sizes, and thickness only when labelled (d=, Dicke, Stärke).

Measured: 6 real concrete-class conflicts ("Betonbord C20/25" in the short text vs "C25/30" in the long text, in StBALV23040.D86 and [NUMMER_001]_leer.X83) and 10 DN conflicts. Severity is warning for concrete, fire rating, board and screed, info for DN. A DN conflict is confirmed by a pipe-diameter table: in 8209.003, "DN 125" with "139,7 x 2,6 mm" shows the long text's "DN 100" is wrong. Layer 3's contradiction check should skip lines that already have this finding.

### 2.2 Unclear descriptions (M deterministic + M LLM)
- **`L1.TEXT.REFERENCE_UNRESOLVED`** (warning): references to a missing OZ, a "wie vor" with nothing before it, and self-references. Real case: in LV_12, 6.1.30 and 6.1.60 say "siehe auch Pos. 6.1.80", which does not exist (a likely missing skylight item). Named references are resolved by word overlap within the section. "wie Position zuletzt…" occurs 735 times in 501-24-01, so it must resolve to the last item that is not itself a "wie" item.
- **`L1.TEXT.SPEC_PLACEHOLDER`** (info), with a `kind`:
  - `placeholder`: values left as dashes, e.g. "Widerstandsklasse: ---", 14 times in LV_19;
  - `deferred`: "nach Angabe/Anweisung/Wahl des AG/der Bauleitung", "nach Bemusterung";
  - `open_quantity_basis`: "nach Erfordernis/Bedarf/Aufwand".
- **`L1.TEXT.SPEC_ATTRIBUTE_MISSING`** (info): a table of item type → required attributes. Pipe needs DN or a dimension plus material; cable needs a cross-section or type code; in-situ concrete needs a class; screed needs a type and thickness; insulation needs a thickness; tile needs a size; door needs a size. The attributes may come from the item, from section notes, or from the item a "wie vor" points to.
- **`L3.TEXT.UNDERSPECIFIED`**: runs only on candidates (any pre-signal, or a long text under 60 characters). The model returns a `missing_property` from a fixed list, a verbatim quote, and a draft bidder question. Confidence is capped at 0.6.

### 2.3 Typos and inconsistent spelling: `analysis/layer1/text_quality.py` (M)
Edit distance alone gave 30–170 false candidates per file (German inflections, real word pairs). The recommended approach:
- **Lexicon:** a domain lexicon mined from `Data/`, counting words that appear in at least 3 *projects*. Counting files would make repeated typos look like words.
- **Compounds:** split them into known parts.
- **Filtering:** mask anonymisation tokens, and skip ALLCAPS, product contexts and abbreviations.
- **Flag rule:** flag a word only if it is unknown and a known word exists at Damerau distance 1, or 2 for words of 12+ letters, and the pair is not just an inflection.
- **Optional hunspell:** pure-Python `spylls` with a local de_DE dictionary, set in `ANALYSIS_SPELL_DIC`. In a rough test it removed about 89% of false positives and kept 16 of 23 true typos.

Real typos found this way: Materail, Scihtprüfung, Elektotechnik, erfoderlichen (5×), Anfoderungen (5×), Auftragnehemer (11× in one file).

Three rules, all info:
- `L1.TEXT.TYPO`: one finding per distinct typo, with a `SetField` fix per line;
- `L1.TEXT.SPELLING_VARIANT`: Baustrom-Kabel/Baustromkabel, Anschluß/Anschluss, Sectionaltor/Sektionaltor;
- `L1.TEXT.NOTATION_VARIANT`: DN15/DN 15, 5x25/5 x 25 mm², St/Stk, psch/Psch.

Rejected: pyspellchecker (no compound handling) and an LLM (unverifiable, and it costs tokens).

### 2.4 Missing items in more trades: layer 2 (S JSON + S engine)
Engine and schema changes, in layer 2 files only:
- an optional per-dependency `"Severity": "info"` for items usually in another package;
- `QuantityMatch` skips matched lines whose unit dimension differs, instead of making the whole check "not assessable";
- use `trade` scope, because section scope gave a false "no pipe insulation" on LV_14.

New groups, tested on the real PDFs: `L2.ELEC.INSTALLATION`, `L2.ELEC.LIGHTING`, `L2.ELEC.CABLING`, `L2.ELEC.LIGHTNING_PROTECTION`, `L2.SANITARY.WC`, `L2.SANITARY.POTABLE_WATER`, `L2.TILE.COVERING`, `L2.DOOR.STEEL`, `L2.DOOR.INDUSTRIAL`, `L2.WINDOW` (synthetic only). The full JSON for `L2.ELEC.INSTALLATION` and `L2.SANITARY.WC` is in the research notes; the triggers and dependencies are summarised here:

| Group | Trigger | Dependencies |
|---|---|---|
| ELEC.INSTALLATION | sockets, switches, push buttons, motion/presence detectors | installation cable (NYM…), device boxes, RCD protection (info), initial verification VDE 0100-600, as-built documents |
| SANITARY.WC | wall/floor WC | WC seat, flush plate, mounting frame (QuantityMatch in ea, 0% tolerance) |
| SANITARY.POTABLE_WATER | drinking-water pipe systems | pipe insulation (QuantityMatch in m), pressure test, flushing/disinfection, water sampling |
| TILE.COVERING | tiles, porcelain stoneware, natural stone | primer (m²), waterproofing only for wet rooms, elastic joints, skirting/edge profiles |
| DOOR.STEEL | must contain "tür" | door closer for T30/RS, lock cylinder (info), hardware |
| DOOR.INDUSTRIAL | sectional/roller door | safety edge or light barrier, power supply to the drive (info) |

Plausible real gaps this finds:
- LV_13: no RCD protection and no emergency lighting for a training centre.
- LV_19: doors prepared for a profile cylinder ("PZ-vorgerichtet") but no cylinder, and no power supply for the gate drive.

LV_14 correctly gives 0 findings: 12 WCs against 12 seats and 12 frames, and 288 m of pipe against 288 m of insulation.

## 3. Risk scoring and change-order (Nachtrag) detection (step 2)

**Design:**
- **Signals are ordinary findings** (category `risk`, mostly layer 1), so they have stable ids and can be dismissed.
- **Scoring is a pure function after the layers:** `analysis/risk/assess(input, findings) -> RiskAssessment`. It is not a layer 4, because `Finding.layer` is `Literal[1,2,3]` and the scorer produces no findings.
- **Rejected findings are left out of the score**, so dismissing a signal lowers the score at once.

**Signal catalogue.** Counts are lines across `Data/`; they are inflated because some projects appear in several formats. w is the weight, k the impact.

| Rule | Detects | w | k | Side | Count |
|---|---|---|---|---|---|
| `L1.STRUCT.PROVISIONAL_ITEM` / `L1.RISK.PROVISIONAL_TEXT` | Bedarfs-/Eventualposition flag or wording | 0.35 | 1.0 | client | 24 flag / 66 text |
| `L1.RISK.DAYWORK` | Stundenlohn, Regie, unit h | 0.30 | 1.0 | client | 65 / 146 |
| `L1.RISK.COST_PLUS` | "nach (tatsächlichem) Aufwand" | 0.30 | 0.5 | client | 9 |
| `L1.RISK.BY_CLIENT` | bauseits, beigestellt | 0.20 | 0.3 | bidder | 50 |
| `L1.RISK.CLIENT_DECIDES` | nach Angabe/Wahl/Anordnung, Bemusterung (VOB/B §2(5)) | 0.30 | 0.4 | both | 33 |
| `L1.RISK.CATCH_ALL` | "inkl. aller", "komplett", "betriebsfertig" | 0.20 | 0.3 | bidder | 69 |
| `L1.TEXT.OR_EQUIVALENT` (existing) / `L1.RISK.OR_SIMILAR` | oder gleichwertig, Leitfabrikat / o.ä., sinngemäß | 0.15 / 0.20 | 0.2 / 0.3 | both | 157 / 20 |
| `L1.RISK.CONDITIONAL` | ggf., evtl., soweit erforderlich, je nach | 0.25 | 0.3 | both | 81 |
| `L1.RISK.APPROXIMATE` | ca., etwa | 0.10 | 0.2 | client | 252 |
| `L1.RISK.GROUND` | Homogenbereich, Fels, Grundwasser, Kampfmittel, Altlast, LAGA Z0–Z2 | 0.30 | 0.5 | client | 169 |
| `L1.RISK.EXISTING_FABRIC` | im Bestand, Abbruch, Rückbau, vorhandene Leitung | 0.20 | 0.3 | both | 108 (precision to fix) |
| `L1.RISK.TIME_RELATED` | vorhalten, je Woche, Stillstand (§6) | 0.15 | 0.3 | client | 149 |
| `L1.RISK.SURCHARGE` | Zulage / als Zulage | 0.10 | 0.3 | both | 244 |
| `L1.RISK.EXTERNAL_REF` | gem./siehe Plan, Statik, Gutachten | 0.10 | 0.2 | bidder | 163 |
| `L1.RISK.THIN_LUMP_SUM` | lump sum with under 200 characters of text | 0.35 | 0.5 | bidder | 29 |
| `L1.QTY.PLACEHOLDER` | quantity 1 in m/m²/m³/t/h on an item that isn't a lump sum | 0.30 | 1.0 | client | 28 |
| existing L1 errors, L2 missing dependency, L3 findings | see the research notes | 0.05–0.50 | 0.4–1.0 | | per run |

Each regex needs negative tests, e.g. "Bestandsdokumentation" must not count as existing structure. A line with no long text means less evidence, not more risk.

**Unusual quantities**, new rules in `layer1/quantities.py`:
- `L1.QTY.PLACEHOLDER`.
- `L1.QTY.ROUND_SHARE`: more than 60% round quantities in a section of at least 5 measured lines means the quantities look estimated, a §2(3) risk.
- `L1.QTY.IMPLIED_DURATION`: rental quantity ÷ set-up quantity gives a duration. In StBALV23040 it gives 28 weeks, but the weather tent says 20 weeks and the shoring works out to 50 days.
- `L1.UNIT.CROSS_SECTION_MISMATCH`: "Warnleuchte vorhalten" is in StWo in one section and in Std in another.
- `L1.QTY.SURCHARGE_EXCEEDS_BASE`: only when the Zulage names the OZ explicitly.
- `L1.QTY.UNIT_OUTLIER`: a robust z-score of log quantity within the same unit and the same item family.
- A new layer 2 check type `Ratio`: backfill ≤ excavation, bedding per m of pipe, screed edge strip per m², floor finish ≤ screed area.

**Score model `risk-v1`:**
- **Likelihood per line:** p = 1 − Π(1 − wᵢ·cᵢ), keeping the strongest signal per family, capped at 0.95. cᵢ is 1 for a rule, or the finding's confidence.
- **Exposure E, first available:** file line amount; quantity × file unit price (this also catches unit-price-only items); our price; quantity × reference median; the BoQ's median line amount, marked as estimated. A tender with no prices is ranked by likelihood only.
- **Expected amount:** EV = E·p·k, where k is the largest impact among the active signals.
- **Level:** high if p ≥ 0.5 or EV ≥ 2% of the net total.
- **Roll-up** by trade and section, split into the client side (change-order potential) and the bidder side (risk allowance or clarification question).
- Sections titled "Nachtrag" are left out of the score and used as labels instead.

**Contract addition:** add `RiskReason`, `LineRisk`, `GroupRisk`, `ClarificationQuestion` and `RiskAssessment`, and `AnalysisResult.risk: RiskAssessment | None`. Bump `SCHEMA_VERSION` to 0.2, because `extra="forbid"` would reject the new field. The runner calls `assess` after sorting, and a failure there goes to `errors`. The CLI gets `--no-risk` and `python -m analysis risk <file>`.

**Calibration:**
- **Today's one data point:** `[ORT_024] LV24069.D86` section 8 holds 6 real change orders (≈ 39.9 k€, 7.4% of the net total). That implies k ≈ 0.34, close to the default 0.3.
- **Back-test:** the scorer ranks the sections that received change orders (03 Aggregate, 07 Lüftung) highest. It misses the schedule-driven change order, because preamble texts are not in `AnalysisInput`, so add `AnalysisInput.notes`.
- **Later, with organiser data:** empirical-Bayes weights per signal, then logistic regression once there are about 200 or more labelled lines.

**Worked example, `StBALV23040.D86`:** expected exposure ≈ 53 k€ of 897 k€ (≈ 6%). The top risks are trench excavation 03.02.0003 (166 k€, ground, existing structure, time), reused paving, and rock in Homogenbereich X1 (a classic §2(3) quantity risk). Gap: a 90 k€ temporary bridge triggers no signal; that needs a price-outlier or layer 3 check.

**Bidder questions:** German templates for the high-value signals, one question per signal per section, at most 15, tenders only. Example: "Pos. 03.02.0009: Bitte stellen Sie das Baugrundgutachten mit Homogenbereichen und erwartetem Felsanteil zur Verfügung." The report UI plan in section 4 covers the template set for layer 1 rules.

**Tasks:**
1. Contract decision (S).
2. `layer1/risk.py` with negative tests (M).
3. `layer1/quantities.py` (M).
4. `analysis/risk/`: `weights.json`, exposure, model, roll-up, `assess`, runner hook (M).
5. Questions (S).
6. Risk tab (M).
7. Golden tests (S).
8. Layer 2 `Ratio` checks (M).
9. Layer 3 `QTY.IMPLAUSIBLE` / `SCOPE_AMBIGUITY` (M).
10. Calibration script (L).

## 4. Risk report web UI (step 3)

**Findings that shape the design:**
- Docker is installed but its daemon is not running, and `psycopg` is not installed.
- Migration 009's `analysis_finding` needs a `bom_version` that the webapp never creates, and has no reason column.
- WeasyPrint is installed but fails to import (no GTK on Windows).
- `contracts.Status` already has `accepted`/`rejected`.

**Screen layout:**
- **Header:** file name, phase badge, priced/not priced badge, and buttons for Print/Save PDF, Bidder questions and Download JSON.
- **Tabs:** Summary (default), Findings, Bidder questions, Positions.
- **Summary:**
  - tiles: risk score, money at stake (or "not priced"), open errors/warnings, change-order signals, reviewed n of m;
  - a banner for unpriced tenders explaining the ranking;
  - top-10 risks with reason chips and Accept/Dismiss;
  - by section/trade, by category, and a change-order signals list.
- **Findings:** a Status column, an Open/Dismissed/All filter, Accept/Dismiss with a reason, and bulk dismiss by rule.

**API** (`webapp/app.py`):
- Each BoQ gets `doc_key = sha256:boq_index`, plus `risk`, `decisions` and `orphaned_decisions`.
- `PUT /api/decisions/{doc_key}/{finding_id}` returns the decision and the re-scored risk.
- `POST /api/decisions/{doc_key}/bulk`.
- `GET /api/questions/{doc_key}` and `GET /api/questions/{doc_key}.docx`.
- A memory cache holds the last 8 analyses.
- GZip middleware: large responses shrink about 8×.

**Decisions storage:** one JSON file per document in `webapp/var/decisions/{sha256}.json`, written atomically. Add the folder to `.gitignore`, since notes contain tender content. Keep it behind a `DecisionStore` interface, so a PostgreSQL store with migration 010 (`decision_reason`, `decision_note`) can follow. The demo must not depend on Docker.

**Export:** browser print CSS (`@media print`, page breaks per section, controls hidden). It works everywhere and reuses the screen HTML. Stretch goal: a one-click PDF through headless Edge, which is already installed (`msedge --headless=new --print-to-pdf`). Generate the bidder questions .docx with `python-docx`.

**Bidder questions (Bieterfragen):** deterministic German templates keyed by `rule_id`, which are traceable and send no data anywhere. Price, arithmetic and bidder-input rules are left out. Examples:
- `L1.QTY.MISSING`: „Pos. {oz} „{short_text}“: Für diese Position ist keine Menge angegeben. Bitte teilen Sie uns die anzubietende Menge mit bzw. bestätigen Sie, ob die Leistung pauschal anzubieten ist.“
- `L1.DUP.SUSPECTED`: „Pos. {oz} und Pos. {same_as} beschreiben dem Anschein nach dieselbe Leistung … Bitte bestätigen Sie, ob beide Positionen getrennt anzubieten sind oder ob eine Doppelung vorliegt.“
- `L1.STRUCT.PROVISIONAL_ITEM`: „Pos. {oz} ist als Bedarfsposition gekennzeichnet. Bitte teilen Sie mit, ob und in welchem Umfang mit einer Beauftragung zu rechnen ist …“
- `L2.*_NEEDS_*`: „Zu Pos. {trigger_codes} ist keine Position für {dependency_de} enthalten. Bitte teilen Sie mit, ob diese Leistung in einer anderen Position enthalten ist, bauseits erbracht wird oder zusätzlich anzubieten ist.“ This needs a `name_de` per dependency.

Optional "polish with LLM": local only, with the verbatim check. Off by default.

**Performance:**
- Send only the top 50 risk positions.
- Render 200 findings rows with a "Show more" button, using one delegated listener.
- Update only the changed row when a decision is made.

**New files:** `analysis/questions.py`, `webapp/decisions.py`, a temporary `webapp/risk_fallback.py` (severity × amount, so the UI isn't blocked before `assess()` exists), and tests `test_questions.py` and `test_webapp.py` (TestClient).

**Tasks:**
1. Decisions store and API.
2. Findings tab actions.
3. Summary tab, using the fallback first.
4. Re-score on each decision.
5. Questions.
6. docx export.
7. Print CSS.
8. Performance pass and tests.
9. Docs.

## 5. Proof on BoQs with known errors (step 4)

**Data sources** (none downloaded; licences to check):

| Source | Format | Use |
|---|---|---|
| Dangl.AVA.Examples "Neubau Sportheim" (GitHub) | X86/D86, priced | A priced seed for the arithmetic mutations (no licence file) |
| BVBS Prüfdateien DA XML 3.2/3.3 | X83/X84/X86 | A priced XML seed |
| gaeb.de sample files and XSDs | X8x + XSD | Validating mutated files |
| Municipal tenders (e.g. Mülheim LV365 Estricharbeiten), oeffentlichevergabe.de OCDS (CC0 index; filter by CPV 45262321 screed, 45442100 painting) | PDF and X83 | Real building seeds |
| OpenConstructionERP demo projects | X83, AGPL | Backup |

The first choice is the `LV_xx` building PDFs once the PDF fixes land.

**Building seed:** `analysis/eval/seeds/building_hall.json`, about 60 hand-written lines (screed, concrete, drywall, painting, flat roof) with every dependency present, so it gives 0 warnings when clean. A small `gaeb_writer.py` exports it to X83 so the demo uses a real file.

**Mutator (`analysis/eval/mutate.py`).** Two backends: lxml editing of a real X83 (texts edited inside text nodes; new items cloned from a sibling) and AnalysisInput JSON. Runs are reproducible with `--seed`, one mutation per file. A mandatory read-back check confirms that only the planted change is present.

| Mutation | Expected rule |
|---|---|
| quantity 0 / missing / negative / fractional count | `L1.QTY.*` |
| lump sum with quantity 3 | `L1.LUMP.INCONSISTENT` |
| unit missing / unknown / wrong dimension with "Abrechnung nach" | `L1.UNIT.*` |
| exact duplicate, new OZ / same OZ | `L1.DUP.SUSPECTED` / `L1.CODE.DUPLICATE` |
| reworded duplicate, typo, vague "nach Aufwand" item | not detected yet: reported as gaps |
| DN or concrete class changed in the long text only | `L1.TEXT.VALUE_CONFLICT` (new) / `L3.TEXT.SHORT_LONG_CONTRADICTION` |
| dependency removed (only if no remaining text still names it), quantity cut 50%, "bauseits" | `L2.<GROUP>_NEEDS_<DEP>` |
| line amount, section total or net total broken (priced seed) | `L1.ARITH.*` |
| controls: dependency moved inline, items reordered, whitespace changed, +5% on an unrelated line | nothing; any new finding is a false alarm |

**Labels:** `<mutated>.labels.json` (schema `construct-eval-labels/1`). Each label has a target (line codes and trigger codes), the `expect` rule ids (fnmatch patterns allowed), a `match` mode (line / section / dependency / bom), `also_acceptable` rules and `gap`.

**Harness:** `python -m analysis.eval` with the commands `mutate`, `run`, `fp`, `label-template` and `report`.
1. Diff the mutated file's findings against the seed's baseline.
2. A label matched by a new finding counts as caught; an unmatched new finding counts as a false alarm.
3. Report precision per rule and recall per mutation type.
4. A label whose detector layer did not run (e.g. layer 3 without a model) counts as "not run", not as missed.

**Real-file labels:** `analysis/eval/labels/real_findings.csv`, with verdict `true_error | false_alarm | importer_artefact | unsure`. A group row with `finding_id="*"` covers a whole (file, rule) pair, so about 15 rows label today's 140 errors and warnings. `.gitignore` needs a `!analysis/eval/labels/*.csv` exception and should ignore `eval_out/`; never commit mutated copies of `Data/` files. Only the synthetic seed may go to an API model.

**Three-minute demo:**
1. `StBALV23040.D86`: subtotal off by exactly 982.20 €, pointing at the damaged OZ.
2. `[ORT_024] LV24069.D86`: 38 priced change-order items with quantity 0.
3. `building_hall_planted.X83`: missing edge insulation, a duplicate, quantity 0.
4. The eval table, including the honest gaps.
5. Nothing is changed automatically.

**Tasks:**
1. Seed and writer.
2. Backends and read-back check.
3. Mutation catalogue.
4. Labels and matching.
5. The `run`, `fp` and `report` commands.
6. Label the real findings.
7. Tests and gitignore.
8. Export layer 3 cases.
9. Demo file and `docs/EVALUATION.md`.

## 6. Excel import (step 6)

openpyxl 3.1.5, xlrd 2.0.2 and pandas are installed but not in any requirements file. Don't use pandas: it drops fonts, merged cells and number formats.

**Parser:** a new `importer/tender_import/spreadsheet.py::excel(data, fmt, mapping=None) -> Result`. It emits the same `item_candidate` and `section_candidate` payloads as `pdf.py`, so the adapter and every layer work unchanged.
- **Loading:**
  - `.xlsx`: run `checked_entries` (zip-bomb limits), then `openpyxl.load_workbook(data_only=True)`; macros are never run.
  - `.xls`: xlrd with `formatting_info`.
  - `.csv`: `csv.Sniffer`, with `;` as the default delimiter.
- **Header detection:** score the first 40 rows, and pairs of rows for two-row headers, against a synonym table:
  - code: oz, ordnungszahl, pos, posnr…
  - short text: kurztext, bezeichnung, leistung…
  - long text: langtext…
  - quantity: menge, lvmenge, vordersatz…
  - unit: einheit, me, eh…
  - unit price: ep, einheitspreis…
  - line amount: gp, gesamtpreis, betrag…
  - position type: posart, pa…
  - extra code column: titel, los

  Accept when there is a code plus a quantity or short text and the score is at least 6. Warn `excel_mapping_review` when confidence is below 0.75.
- **Rows:**
  - **Code:** rebuild a numeric OZ from its `number_format` (`01.0010` stored as 1.001).
  - **Sections:** a row with no amounts that is shallower than the item depth, bold, or labelled "Titel/Los" is a section.
  - **Long text:** text rows without a code continue the current item's long text. An amount on the last continuation row attaches to that item.
  - **Totals:** `Summe`/`Übertrag` rows become `reported_amount` or `subtotal` records.
  - **Numbers:** German number text goes through `german_decimal`, and "12,5 m2" is split into quantity and unit.
  - **Prices:** "nur EP" or "....." in a price column sets `unit_price_only`.
  - **Formulas:** a formula with no cached value is left as None, with an `excel_formula_uncached` warning.
- **Several sheets:** each sheet with a header becomes its own BoQ (`boq_index`); the webapp already loops over BoQs.
- **Flags:** emit `position_type` / `provisional_flag` from a Pos.-Art column, so the adapter derives the total rule (see finding 0.2).

**Wiring:**
- `common.detect_format` learns xlsx/xls/csv, and the shared regexes move to `common.py`, so Excel doesn't import pypdf.
- `ingest.parse_document` gets a parser-version suffix when a mapping override is used.
- The webapp gets `SUPPORTED` entries, a `column_map` form field (validated JSON), the detected mapping in the response, and an updated `accept=` list.
- Requirements: `openpyxl==3.1.5`, `xlrd==2.0.2`.

**Tests:** fixtures are generated with openpyxl at test time, so no binaries or tender content are committed. Cases:
- title block with a header in row 6;
- two-row header;
- numeric OZ;
- German number text;
- continuation rows;
- uncached formula;
- repeated header;
- merged title cell;
- Pos.-Art column;
- two BoQ sheets;
- no header;
- mapping override;
- CSV.

Also a round trip GAEB → xlsx → `excel()`. Ask the organisers for one real AVA Excel export: the heuristics are untested on real files.

## 7. Historical prices and what-if (step 7)

**What the data supports (measured):**
- There are 3 independent priced projects, about 633 reference lines after dedupe:
  - AN24-0305: the D84 has no texts, so texts come from the PDF; 187 usable lines.
  - StBALV23040: the D86 plus `Abgabe LV.pdf`, the same project, deduped.
  - [ORT_024] LV24069.D86.
- **Same project** (a blank tender matched against its own priced file): 90–95% of lines match.
- **Across projects:** 0–2% of lines match.
- **Category medians:** prices spread 60× to 2200× within one category and unit, so they are useless for prices but good for tagging lines in what-if.

Present this honestly. Coverage grows only with organiser data.

**Design** (new `analysis/pricing/`; no DB, no contract change):
- **`refset.py`:** builds references from the priced files.
  - Fields: family, document hash, code, normalised text, canonical unit, unit price, date, tags.
  - Cached in an ignored `.cache/`.
  - A leakage guard drops references from the same document or family, with an explicit `include_same_project` toggle for the re-tender demo.
- **`match.py`:** char n-gram TF-IDF (scikit-learn is installed, but needs adding to the requirements) on the normalised short text.
  - Hard filters: same unit, or the same dimension rescaled through `units.convert`; lump sums only match lump sums.
  - Attribute guard: DN, PN, SDR, concrete class and material must not conflict.
  - The top 5 at similarity ≥ 0.70 give a `ReferenceRange` and a confidence; a single reference caps confidence at 0.6.
  - Rejected: rapidfuzz (an acceptable swap), embeddings, STLB codes (licensed, absent from the priced files), category medians.
- **`suggest.py`:** fills `Line.price` with `source=REFERENCE`, plus citations.
- **Layer 1 additions:**
  - `L1.PRICE.FILE_OUTLIER`: the file's unit price is more than 3× from the median with n ≥ 2.
  - `L1.PRICE.COVERAGE`: one info finding at BoQ level.
  - Stop flooding `NOT_FOUND` errors when there is no match.
- **`escalation.py`:** Destatis Baupreisindex (GENESIS 61261, licence likely dl-de/by-2-0), with values transcribed by hand into `data/baupreisindex.csv`. Never invent the numbers. BKI and SIRADOS are paid sources.
- **`markups.py`:** BGK, AGK and W+G as configurable percentages, applied only when pricing from cost. Bid prices already include them.
- **`whatif.py`:**
  - **Scenario:** a list of adjustments: category price % (applied to a material share), line price, quantity %, select alternative, include optional items, markup, escalate to a date.
  - **Result:** totals before and after by section, line deltas, findings added or resolved (by stable id), risk before and after.
  - **Tagging:** reuse the regexes in `challenge_catalogue.py`, after moving them to a module without psycopg. Today that module imports `store`, which needs psycopg.
- **API and UI:**
  - a `pricing=1` flag on analyze;
  - `POST /api/whatif {input, scenario}`;
  - a What-if tab with adjustment rows, before/after cards, a section delta table and the top line deltas;
  - "Ref. median [min–max] n" columns in Positions.
- **Calibration:** once the organisers provide planned-vs-actual data, use it for references, per-category overrun presets, quantity-growth factors and risk weights.

**Tasks:**
1. Move the category regexes.
2. Reference set.
3. Matching.
4. Leave-one-project-out eval.
5. Suggest prices.
6. Layer 1 price tweaks.
7. Escalation.
8. Markups.
9. What-if engine and risk delta.
10. Webapp.
11. Tests.
12. Docs.
13. Calibration loader once data arrives.

## 8. Decisions the team needs to make

1. **Contract:** add `AnalysisResult.risk` and bump `SCHEMA_VERSION` to 0.2 (risk effort). Add `AnalysisInput.notes` for preamble texts (Vorbemerkungen). Both touch the shared `contracts.py`.
2. **New dependencies:**
   - `openpyxl` and `xlrd` (Excel);
   - `scikit-learn` (prices);
   - `python-docx` (bidder questions);
   - optional `spylls` (typos).
   All are installed locally but none is in a requirements file.
3. **Licences:**
   - The German hunspell dictionary is GPL: load it from a local path only.
   - The lexicon is mined from confidential tenders: can it be committed after review?
   - Dangl and BVBS sample files: put them in the repo, or provide a fetch script with checksums?
   - Destatis index licence.
4. **Ownership of shared code:**
   - `adapter.derive_pricing`: the PDF flag fix; there is uncommitted work in the same function right now.
   - Layer 1 severity changes for PDF quantities (F8).
   - Importer changes (moving the regexes, a lazy psycopg import).
5. **Behaviour:**
   - Should a non-Poppler `pdftotext` be a hard error or a warning?
   - Should the default layer 2 scope be `trade`?
   - Should "interface" dependencies default to info?
   - Should low-weight risk signals be findings (collapsed in the UI) or exist only inside the scorer?
   - Should risk be shown from the bidder's view, the client's, or both? Spekulationsangebote can be excluded from award (BGH X ZR 100/16).
6. **Data from the organisers:**
   - the real faulty BoQ examples;
   - one real Excel export;
   - planned-vs-actual and change-order history for calibration;
   - building-project GAEB files.
7. **Layer 3:** which local model to use? Then measure its precision with `python -m analysis.layer3.eval`. Is the Anthropic API acceptable for the synthetic seed only?
