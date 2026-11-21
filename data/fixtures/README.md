# Test data: public GAEB files

Real GAEB bills of quantities (Leistungsverzeichnisse) from trusted public sources, used to test the importer (`backend/importer/tender_import`) and the analysis checks (`backend/analysis/`). They complement the project's own dataset in `data/tenders/`.

- **What's here:** 54 GAEB files and 4 companion PDFs, all downloaded on 21 November 2026 from the original publishers listed below.
- **Unchanged contents:** only file names were changed, to remove spaces and add missing extensions.
- **Checksums:** `MANIFEST.sha256` lists a SHA-256 for every file.
- **Exact bytes:** `.gitattributes` turns off line-ending conversion. GAEB 90 files are fixed-width CP437/Latin-1 records with CRLF line endings, so changing a byte breaks them.

> **Internal use only.** Most of these files have no open licence (see [Licences and terms](#licences-and-terms)). Keep them in this private repository and don't publish or redistribute them.

## Layout

| Folder | Publisher | What it is | Formats and phases |
|---|---|---|---|
| `bvbs/` | [BVBS](https://www.bvbs.de/zertifizierungen/) (Bundesverband Bausoftware) | Official test files used to certify AVA software for GAEB. Small but full of edge cases: index letters on item numbers (`0010 A`), surcharge items (`MarkupItem`), optional items, bidder text fields, section discounts and lump-sum sections. | DA XML 3.2: tender X83 and bid X84. DA XML 3.3: tender X83. |
| `dangl/` | [Dangl IT, Dangl.AVA.Examples](https://github.com/GeorgDangl/Dangl.AVA.Examples/tree/master/GaebFiles) | One small priced project ("Neubau Sportheim") in three GAEB generations, in German and English. Known totals: **57,550.00 € net**, 6 items, 4 sections. | GAEB 90 D86, GAEB 2000 P86, DA XML 3.2 X86 |
| `dbinfrago/` | [DB InfraGO, Muster-LVs](https://www.dbinfrago.com/web/schienennetz/dienstleistende/informationen-fuer-planer-und-bauunternehmer/muster-lvs-14048928) | Full-size template tenders from Deutsche Bahn's infrastructure company. Each folder holds the **same LV as GAEB 90 and as GAEB XML**, which makes them ideal for parser parity tests. The trades are infrastructure: earthworks, bridges, cable trenches, track, overhead lines, disposal. | D83 + X83 (tender); `80_oberleitungsanlagen` is D81 + X81 (exchange); `61_…` is X83 only |
| `gaeb.de/musterdateien-3.1/` | [GAEB](https://www.gaeb.de/de/service/downloads/gaeb-datenaustausch/) (Gemeinsamer Ausschuss Elektronik im Bauwesen) | Official sample files for DA XML 3.1. LV 001 is in every phase (X81, X83, X84, X86). LV 003 is a large stress test (2,560 items, 682 sections). The PDFs are GAEB's printouts of LVs 001, 002 and 004, plus an overview of the sample set (`Musterdatei_3.1_Umfang_Pruefdateien.pdf`). | X81, X83, X84, X86 + PDF |
| `gaeb.de/zeitvertrag-3.2/` | GAEB | Sample files for framework contracts (Zeitvertrag) in DA XML 3.2. | X83Z, X84Z, X86ZE, X86ZR |

### DB InfraGO template LVs

| Folder | LV | Items (D83 / X83) |
|---|---|---|
| `00_allgemeine-leistungen-infrastruktur` | General infrastructure items (ALI) | 110 / 110 |
| `10_massivbruecke` | Solid bridge | 223 / 223 |
| `20_kabeltiefbau` | Cable trench works | 1,122 / 1,076 |
| `30_laermschutzwaende` | Noise barriers | 349 / 349 |
| `40_fahrleitungsanlage-s-bahn-berlin` | Overhead contact line, S-Bahn Berlin (March 2023) | 1,793 / 1,793 |
| `40.1_gleiserneuerung-flv` | Track renewal, FLV method, without supply and disposal | 154 / 154 |
| `41.1_gleiserneuerung-konventionell` | Track renewal, conventional, without supply and disposal | 156 / 156 |
| `42.1_weichenerneuerung` | Switch renewal, without supply and disposal | 166 / 166 |
| `43.1_brueckenschwellenwechsel` | Bridge sleeper replacement, without supply and disposal | 153 / 153 |
| `50_entsorgung` | Disposal | 137 / 137 |
| `53_entsorgung-bayern` | Disposal, Bavaria | 106 / 106 |
| `60_sicherung-einzelausschreibung` | Safety and related services, single tender (08/21) | 128 / 128 |
| `61_sicherung-verbundvergabe` | Safety and related services, combined award | – / 28 |
| `70_weichenheizanlagen` | Electric switch heating | 133 / 133 |
| `80_oberleitungsanlagen` | Overhead line systems (D81 / X81) | 963 / 963 |
| `100_erdbau` | Earthworks | 323 / 323 |
| `spgk` | SPGK | 12 / 12 |

## Using the files

- **In the web UI:** import a supported GAEB file into a BillBuild folder and open the resulting list to view its risk assessment.
- **From Python:** `analysis.adapter.from_file("data/fixtures/dangl/GAEBXML_DE.X86")` builds the analysis input directly. `python -m analysis run --help` shows how to run the checks from the command line.
- **As golden files:** the Dangl project must come out at 57,550.00 € net in every format. Each DB InfraGO pair should give the same items from the D83 and the X83.

## Results with the current code (21 November 2026)

All 48 GAEB XML and GAEB 90 files parse without errors. Points to know when you use them as tests:

- **Not supported yet:** GAEB 2000 (`dangl/*.P86`) and the Zeitvertrag variants (`gaeb.de/zeitvertrag-3.2/*.X8?Z*`) are rejected as unsupported file types.
- **Parity gap:** `dbinfrago/20_kabeltiefbau` gives 1,122 items from the D83 but 1,076 from the X83. One of the two parsers is missing or adding items.
- **GAEB 90 warnings:** the D83 files in `40.1`, `41.1`, `42.1` and `43.1` produce over 600 import warnings each, plus about 30–40 lump-sum findings that their X83 twins don't have. The GAEB 90 parser doesn't decode some of their record types yet.
- **Bids need their tender:** `bvbs/…AVA_84.X84` (and the identical `Musterdatei_3.1_2008-001.X84`) still show 3 section total mismatches. The excluded items are probably optional or alternative, which only the matching X83 says. Checking a bid together with its tender is not implemented yet.
- **Empty tenders:** most DB InfraGO tenders leave quantities at 0 for the planner to fill in, so `L1.QTY.ZERO` fires on most items. That's expected for template LVs.

## Licences and terms

| Source | Terms |
|---|---|
| BVBS | No licence stated on the download page. Published for certifying AVA software. |
| GAEB | Copyright GAEB / DIN. Published as reference material for the standard. |
| DB InfraGO | No licence stated. Published as templates for planners and contractors. |
| Dangl IT | The GitHub repository has no licence file. |

None of these grants a right to redistribute. Use the files for internal testing only, and check the publisher's terms before sharing them outside this repository.

## Adding files

Add a new source as its own folder, with the publisher, the URL and the download date in the table above. Append its checksums to `MANIFEST.sha256` (`sha256sum <files> >> MANIFEST.sha256` from this folder). Only add files from the original publisher, never from mirrors.
