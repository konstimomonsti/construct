# Analysis phase: what was built (summary for the team)

Date: 21 November 2026. Branch: `main` (everything below is pushed). Detail lives in
[ANALYSIS_LAYERS.md](ANALYSIS_LAYERS.md) (overview of the layers), [ANALYSIS_CONTRACT.md](ANALYSIS_CONTRACT.md)
(data model and layer 1 rules) and [DEPENDENCY_VALIDATOR.md](DEPENDENCY_VALIDATOR.md) (layer 2).

## In one paragraph

The platform receives a client's bill of quantities (GAEB X83/D83/D84/D86, PDF, Word), organizes it, and
prices it. The **analysis phase** then finds the errors and shows them to a person, with an optional
proposed fix. **Nothing is ever changed automatically.** It works in three layers that run in order: layer 1
is plain code (missing quantities, wrong units, wrong sums), layer 2 is a rule base of construction
dependencies (screed needs edge insulation, concrete needs formwork), and layer 3 uses a small LLM for what
needs understanding the text. A minimal web page lets you upload a file and see the report.

```
upload -> importer -> normalized BOM -> (pricing, not built) -> adapter -> layer 1 -> layer 2 -> layer 3
       -> findings -> web report -> human accepts/rejects -> (apply to a new BOM version, not built)
```

## What was done, step by step

### 1. Shared contract (so two people could work in parallel)

- Agreed on **one input object** (`AnalysisInput`) and **one output object** (`Finding`) for every layer,
  documented in `docs/ANALYSIS_CONTRACT.md`.
- `analysis/contracts.py`: Pydantic models. Money and quantities use `Decimal`, and every finding has a
  **stable id** (same problem → same id on every run, so a human decision survives re-analysis).
- `analysis/units.py`: one canonical unit vocabulary (`St`/`Stk` → `ea`, `m2` → `m²`, `psch` → `lump_sum`, …),
  each unit's dimension, and exact conversions.
- `analysis/adapter.py`: builds the input from a **GAEB file directly** (no database needed), from the
  **database**, or from **JSON**. It never drops a line and never repairs data, so the rules can see
  the problems.
- `analysis/registry.py` + `analysis/runner.py`: a `@rule` decorator, layers run in order, a crashing rule
  never stops the others, and findings are merged, de-duplicated and summarized.
- `db/migrations/009_analysis.sql`: tables for the pricing hand-off (`line_pricing`) and for stored results
  (`analysis_run`, `analysis_finding`).
- CLI: `python -m analysis run "Data/file.X83" --layers 1,2,3`.

### 2. Research on typical errors

Before writing layer 1 we looked up common BoQ errors and German award rules. In short: quantity, unit and
description errors are the most frequent; unit price beats line total when they disagree (**VOB/A §16c**);
Wahlpositionen need a Grundposition; Bedarfspositionen are generally not allowed in public tenders; bidder
fields ("Fabrikat: ……", "oder gleichwertig") must be filled in a bid. Sources are listed in the contract doc.
We also mined the real files in `Data/` to see which errors actually occur.

### 3. Layer 1: deterministic checks (34 rules)

`analysis/layer1/`, in four modules:

- **Completeness:** missing, negative or zero quantity, fractional piece counts, missing or unknown unit,
  missing text, missing or duplicate OZ.
- **Consistency:** a unit contradicting "Abrechnung nach …", inconsistent lump sums, empty bidder fields,
  "oder gleichwertig" products, structure problems, suspected duplicates.
- **Arithmetic:** qty × unit price vs line amount, section subtotals, net total.
- **Prices:** missing, zero, unit or currency mismatch, outliers, low confidence, bid price vs ours, stale
  prices.

Severity depends on the document phase: an empty bidder field is *info* in a tender and a *warning* in a bid.

**What it found in the real files:**

| File | Finding |
|---|---|
| `[ORT_024] LV24069.D86` | 38 change-order items priced at 3,279.20 € but with **quantity 0 and no unit**; net total left at 0.00 |
| `StBALV23040.D86` | A damaged OZ puts one item outside every section, so **section 08's subtotal is off by exactly its 982.20 €**. The rule points at that item |
| `Angebot AN24-0305.D84` | 20 bidder fields left empty in the bid |
| `501-24-01_GAEB-XML_sas.x83` | A duplicated item (02.03.0005 / 02.03.0007) |
| Clean tenders | Only informational notes |

### 4. Layer 2: review and fixes (built by a teammate)

The teammate built the dependency checker (5 trade groups, 16 checks, with scoping by trade, section or room).
The review found that **on the real files every layer 2 warning was a false positive**: "EPDM" pipe seals
triggered flat-roof checks, and "Beton" in demolition, precast, temporary and core-drilling items triggered
concrete checks. Fixes made:

- Triggers now match the **short text** (long texts mention materials in passing), and each rule can
  **exclude** lines (demolition, precast, pipes, temporary items, work on existing concrete). Reinforcement is
  only required for reinforced elements.
- Real files now give 0 false warnings, and real cases (a reinforced concrete wall, an EPDM roof membrane) still
  trigger.
- Clean-up: one shared unit table and one JSON loader instead of duplicates; the layer 2 CLI moved into
  `analysis/layer2/`; proposals now carry a unit; all tests live in `analysis/tests/`; `pyproject.toml` and
  `.gitignore` were fixed.

### 4b. Layer 2: every dependency rule explained (15 trades, 46 checks)

Layer 2 now covers **15 trades with 46 checks**: the 5 original trades (16 checks) plus 10 new ones from the
implementation plan, §2.4 (30 checks). The rules are in `analysis/layer2/rules.json`; adding a trade needs
no code.

**How a check works, in plain words.** Some items in a bill of quantities can't be built on their own.
A WC needs a seat; a fire door needs a door closer. Layer 2 looks for the main item (the *trigger*) in the
short text of each position. When it finds one, it looks through the whole BoQ for the items that must go
with it. If one is missing, it raises a finding and suggests a new position for a person to accept or
reject. Some checks also compare amounts: 12 WCs need 12 seats, and 288 m of pipe needs about 288 m of
insulation.

**Two kinds of result:**

- **Warning:** the companion item normally belongs in the same package, so it is probably a real gap.
- **Info (a question):** the item is often tendered in a *different* package (for example by another
  trade), so the right question for the client is "is this included somewhere else, or provided by
  others?".

#### All 46 dependencies, trade by trade

German terms in brackets are what the rules search for. "Compared in m²" (or metres, or pieces) means the
companion items must add up to at least the trigger's amount, with 10% tolerance unless stated otherwise;
if they fall short, the finding says by how much.

##### The five original trades (built by the teammate, reviewed and adjusted here)

**Floor screed**: triggered by screed and raised floors (*Estrich, Hohlraumboden, Doppelboden*, or a
screed code such as "CT, 65mm"). Moisture measurements, recesses and surcharges don't count as screed.

| Needs | Why | Result if missing |
|---|---|---|
| Edge insulation strip (*Randdämmstreifen*) | A strip along the walls lets the screed expand and stops footstep noise passing into the walls | Warning |
| Underlay or insulation (*Trittschalldämmung, EPS, XPS*) | The insulation layer under the screed, for sound and heat | Warning |
| Primer or levelling compound (*Grundierung, Spachtelmasse, Ausgleichsmasse*), compared in m² | Prepares the screed surface for the floor covering. Not asked for a floating screed laid on insulation | Warning, or a shortfall |
| Floor covering (*PVC, Vinyl, Kautschuk, Laminat, Teppich, Bodenfliesen, Naturstein*), compared in m² | A screed is normally covered by a finished floor | Info (usually another trade) |
| Skirting (*Sockelleiste*) | Covers the joint between floor and wall | Info (usually another trade) |

**In-situ concrete**: triggered by cast concrete (*Beton, Ortbeton, Stahlbeton, Bodenplatte,
Fundamentplatte, Streifenfundament*). Not triggered by precast parts, kerbs, paving, pipes, manholes,
blinding concrete, temporary works, core drilling, repairs or painting on concrete.

| Needs | Why | Result if missing |
|---|---|---|
| Formwork (*Schalung*) | The mould that holds the wet concrete in shape | Warning |
| Reinforcement steel (*Betonstahl, Bewehrung, Matten, BSt 500*) | Reinforced concrete needs steel bars. Only asked for reinforced elements, not for unreinforced concrete (*unbewehrt*, C8/10, C12/15) | Warning |
| Blinding layer or PE sheet (*Sauberkeitsschicht, PE-Folie*) | A thin clean layer under a floor slab, so the slab isn't cast on dirt. Only asked for floor slabs | Warning |

**Drywall partitions**: triggered by stud walls and plasterboard (*Metallständerwand, GKB, GKF,
Trockenbauwand, Vorsatzschale*). Concrete facing shells and surcharges don't count.

| Needs | Why | Result if missing |
|---|---|---|
| Insulation (*Mineralwolle, Trennwandplatte, Dämmung*), compared in m² | Mineral wool inside the wall for sound and fire protection | Warning, or a shortfall |
| Joint filling (*Spachtelung, Fugen, verspachtelt*), compared in m² | The joints between boards must be filled before painting | Warning, or a shortfall |
| Corner protection (*Eckschutzschiene, Kantenschutz*) | Metal profiles that protect the outside corners from knocks | Warning |

**Painting**: triggered by paint and coatings (*Dispersionsfarbe, Anstrich, Lackierung, Silikatfarbe*).

| Needs | Why | Result if missing |
|---|---|---|
| Masking and protection (*Abdecken, Abkleben, Schutzfolie*) | Floors, windows and fittings must be covered before painting | Warning |
| Primer (*Tiefengrund, Haftgrund, Grundierung*), compared in m² | Makes the paint stick and absorb evenly | Warning, or a shortfall |

**Flat roof waterproofing**: triggered by roof membranes (*Dachabdichtung, Dachbahn, Dachfolie,
Flachdach*, FPO/EPDM/PVC/TPO membranes). Pipe seals and couplings made of EPDM don't count.

| Needs | Why | Result if missing |
|---|---|---|
| Vapour barrier (*Dampfsperre, Dampfbremse*), compared in m² | Stops moisture from inside the building soaking the roof insulation | Warning, or a shortfall |
| Thermal insulation (*Wärmedämmung, Gefälledämmung, EPS, PUR*), compared in m² | Insulates the roof and often gives it the slope for drainage | Warning, or a shortfall |
| Roof drainage (*Dachgully, Notüberlauf, Speier*) | Water must leave the roof, with an emergency overflow if the outlet blocks | Warning |

##### The ten new trades

**Electrical installation**: triggered by sockets, light switches, push buttons and motion or presence
detectors (*Steckdose, Schalter, Taster, Bewegungsmelder*).

| Needs | Why | Result if missing |
|---|---|---|
| Installation cable (*NYM, Mantelleitung*) | Sockets and switches are useless without the wiring to them | Warning |
| Device boxes (*Gerätedose, Schalterdose*) | The box in the wall that the socket or switch is mounted in | Warning |
| RCD protection (*FI-Schutzschalter, Fehlerstrom*) | Required for socket circuits for safety; usually sits in the distribution board, which may be another package | Info |
| Initial verification (*Erstprüfung VDE 0100-600, Mess- und Prüfarbeiten*) | Every new installation must be tested and documented before handover | Warning |
| As-built documents (*Revisionsunterlagen*) | Drawings of what was really installed, needed for handover and maintenance | Warning |

**Lighting**: triggered by luminaires and light strips (*Leuchte, Lichtband, Flutlicht*).

| Needs | Why | Result if missing |
|---|---|---|
| Emergency lighting (*Sicherheitsbeleuchtung, Notleuchte, Rettungszeichen*) | Public buildings need lit escape routes when the power fails. Only checked for indoor luminaires | Info |
| Lighting control (*Schalter, Präsenzmelder, DALI, KNX*) | Lights need something to switch them on and off | Warning |

**Power cables**: triggered by power cables (*Energiekabel, NYM, NYY, NYCWY*).

| Needs | Why | Result if missing |
|---|---|---|
| Cable trays or conduits (*Kabelrinne, Leerrohr, Installationskanal*) | Cables must be carried and protected. Not checked for cables pulled into existing ducts or buried in the ground | Warning |
| Cable connection (*Anschluss, Endverschluss*) | Someone has to connect both ends; often included in the cable item | Info |

**Lightning protection**: triggered by the air-termination system on the roof (*Fangstange,
Fangleitung, Blitzschutz-Stahlband*).

| Needs | Why | Result if missing |
|---|---|---|
| Earthing (*Fundamenterder, Ringerder, Trennstelle*) | The lightning current must be led into the ground | Warning |
| Equipotential bonding (*Potentialausgleich*) | Connects metal parts so no dangerous voltage builds up between them | Warning |
| Acceptance inspection (*Prüfung Blitzschutzanlage, DIN EN 62305*) | The system must be inspected by an expert before use | Warning |

**WCs**: triggered by toilets (*Tiefspül-WC, Wand-WC*). These checks **count pieces**, with no tolerance:
each WC needs one of each.

| Needs | Why | Result if missing or short |
|---|---|---|
| WC seat (*WC-Sitz*) | Toilets are usually sold without a seat | Warning |
| Flush plate (*Betätigungsplatte*) | The button that flushes a concealed cistern | Warning |
| Mounting frame (*Installationselement, UP-Spülkasten*) | A wall-hung WC needs a frame with the cistern inside the wall. Not checked for floor-standing WCs | Warning |

**Drinking water pipes**: triggered by drinking-water pipework (*TW-Rohr, Trinkwasserleitung*).

| Needs | Why | Result if missing |
|---|---|---|
| Pipe insulation (*Isolierung TW-Rohr, Rohrdämmung*), compared **in metres** | Required by the energy code and to keep cold water cold (hygiene) | Warning, or a shortfall with the missing metres |
| Pressure test (*Druckprüfung*) | Proves the pipes don't leak before the walls are closed | Warning |
| Flushing and disinfection (*Spülen, Desinfizieren*) | New pipes must be flushed clean before people drink from them | Warning |
| Water sampling (*Wasseranalyse, Probenahme*) | A lab test of water quality before use; sometimes ordered separately | Info |

**Tiling**: triggered by tiles, porcelain stoneware, mosaic and natural stone (*Fliesen, Feinsteinzeug,
Naturstein*).

| Needs | Why | Result if missing |
|---|---|---|
| Primer (*Tiefgrund, Grundierung*), compared **in m²** | Prepares the surface so the tile adhesive holds | Warning, or a shortfall |
| Waterproofing (*Abdichtung, Dichtschlämme*) | Showers and wet rooms must be sealed under the tiles. Only checked when the text says shower, wet room or bathroom | Warning |
| Elastic joints (*dauerelastische Verfugung, Silikon*) | Corners and edges move, so they are sealed with silicone, not grout | Warning |
| Skirting or edge profiles (*Sockel, Abschlussprofil, Eckschutzprofil*) | Finishes the edges of the tiled area | Warning |

**Steel and fire doors**: triggered by steel, fire and smoke doors (*Stahltür, T30, RS*).

| Needs | Why | Result if missing |
|---|---|---|
| Door closer (*Türschließer, OTS*) | Fire and smoke doors must close on their own. Only checked for fire- or smoke-rated doors | Warning |
| Lock cylinder (*Profilzylinder*) | A door "prepared for a cylinder" (*PZ-vorgerichtet*) still has no cylinder; often part of a separate locking-system package | Info |
| Door hardware (*Drücker, Beschlag, Türgriff*) | Handles and fittings | Warning |

**Industrial doors**: triggered by sectional, roller and high-speed doors (*Sektionaltor, Rolltor*).

| Needs | Why | Result if missing |
|---|---|---|
| Safety edge or light barrier (*Schließkantensicherung, Lichtschranke*) | A motorised door must stop if someone is underneath it. Only checked for powered doors | Warning |
| Power supply to the motor (*Zuleitung, Elektroanschluss*) | The electrician has to bring power to the door drive; usually in the electrical package | Info |

**Windows**: triggered by windows and window doors (*Fenster, Fenstertür*). Tested on sample files only,
because our building has no window package.

| Needs | Why | Result if missing |
|---|---|---|
| Window sills (*Fensterbank*) | Inside and outside sills; often by another trade | Info |
| Sealing of the installation joint (*Kompriband, Anschlussfolie, RAL-Montage*) | The gap between window and wall must be sealed against air and rain | Warning |

#### Changes to how the checks work

- **Info results** (above), so the report separates probable gaps from questions to the client.
- **Different units are kept apart.** Insulation in pieces is not added to insulation in metres. Lines
  measured in another unit type are now skipped and listed, instead of blocking the whole comparison.
- **Optional items don't count.** In PDFs, "Bedarfsposition" and "Wahlposition" items are optional or
  alternatives, so they neither trigger a check nor count as the missing item.
- **Screed rules (old) adjusted:** floor covering and skirting are now *info* (another trade does them),
  a floating screed on insulation no longer asks for primer, and screeds are recognised by their standard
  code ("CT, 65mm") when the product name is anonymised.

#### Tested on a real building

`Data/` holds a real building (a training centre and offices) split into one PDF per trade (`LV_00` to
`LV_23`). On it, layer 2 finds:

| File | Finding |
|---|---|
| `LV_13_ELT` (electrical) | No RCD protection and no emergency lighting anywhere: questions for the client (info) |
| `LV_19` (doors) | Steel doors "prepared for a cylinder" but no cylinder, and a motorised gate with no power supply (info) |
| `LV_17` (drywall) | 100 m² of shaft wall with no insulation mentioned (warning) |
| `LV_18` (screed) | Skirting is in another package (info) |
| `LV_14` (sanitary), `LV_08` (tiling) | Nothing, correctly: 12 WCs with 12 seats, frames and flush plates; 288 m of pipe with 288 m of insulation |

Getting there meant removing false alarms found on the real texts: "screed moisture measurement" looked like
screed, painting on concrete looked like concrete work, a "thermal socket" for concrete core heating looked
like an electrical socket, slope paving in natural stone looked like tiling, and the frame "for a wall WC"
was counted as a WC. Each case now has a test.

**Decision to note:** the plan suggested checking each top-level section separately (`trade` scope). We
kept checking the whole file, because in `LV_14` the pipes and their insulation are in different
top-level sections and `trade` scope gave a false "no pipe insulation". Changing it is still an open team
decision (§8 of the plan).

### 5. Layer 3: LLM checks (first version, built in a separate session)

`analysis/layer3/`, with two checks:

- **`L3.TEXT.SHORT_LONG_CONTRADICTION`:** short and long text state different values (DN 100 vs DN 150).
- **`L3.REVIEW.L2_CONFIRM`:** re-reads each layer 2 "missing" finding and says whether the dependency is in fact
  included elsewhere, excluded ("bauseits"), or really missing.

Safety by design: the provider is pluggable (**local Ollama by default**, the Anthropic API opt-in, a fake
for tests). Answers must be structured JSON, the quoted text is checked word for word against the line,
confidence is capped at 0.7, answers are cached, there's a call budget per run, and a model failure never
stops layers 1 and 2. **Precision has not been measured yet**: run `python -m analysis.layer3.eval` with the
chosen model first.

### 6. Minimal web app (built in a separate session)

`webapp/`: a FastAPI app (`python -m webapp`). Upload a GAEB, PDF or Word file, or pick a sample from `Data/`.
It runs the layers and shows a one-page report: counts by severity, filters, each finding with its evidence,
proposed fix and source text, a table of positions, and a JSON download. It also fixed the adapter so PDF items
land in their sections.

### 7. Documentation

- `docs/ANALYSIS_LAYERS.md`: start here; what each layer does, the status, and the design rules for layer 3.
- `docs/ANALYSIS_CONTRACT.md`: data model, layer 1 rule catalogue, sources.
- `docs/DEPENDENCY_VALIDATOR.md`: layer 2 rules (technical detail of every trigger and exclusion) and how to
  extend them.
- `docs/PUBLIC_DATA_SOURCES.md`: public GAEB test files, tender portals and price data we could use.

## Current state

| Part | State |
|---|---|
| Contract, adapter, runner, CLI | Done |
| Layer 1 (34 rules) | Done, tested on the real files |
| Layer 2 (15 trades, 46 checks) | Done for these trades. Tested on the `LV_xx` building PDFs in `Data/` (the earlier "no building projects" note was wrong); windows only on sample files |
| Layer 3 (2 checks) | First version; precision not measured yet |
| Web report | Minimal version works |
| Tests | 165 passing (`python -m pytest`) |
| `from_db` + migration 009 | Written, **never run against PostgreSQL** |
| Pricing phase | Not built; price rules tested only on synthetic data |
| Accept/reject in the UI, apply fixes to a new BOM version | Not built |

## Suggested next steps

1. Measure layer 3 precision with the chosen model (`python -m analysis.layer3.eval`).
2. Layer 2: fix the PDF item flags in the shared adapter (plan §0.2) so layer 2 no longer needs its own
   workaround; decide the default scope (plan §8); add more trades (heating, ventilation, facades) and the
   `Ratio` check type (plan §3), testing each on the `LV_xx` files first.
3. Run migration 009 and `from_db` against the database.
4. Add accept/reject to the web report and apply accepted fixes to a new BOM version.
5. Connect the pricing phase through `line_pricing` so the price rules get real data.

## How to try it

```
pip install -r webapp/requirements.txt     # includes the analysis requirements
python -m analysis run "Data/StBALV23040.D86" --layers 1,2
python -m webapp                           # then open http://127.0.0.1:8000
python -m pytest                           # all analysis tests
```

Working agreements: `contracts.py`, `units.py`, `registry.py` and `runner.py` are shared, so agree before
changing them; the next migration number is `010`; tests go in `analysis/tests/`.
