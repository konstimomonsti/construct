<img src="assets/icon.svg" width="64" height="64" alt="">

# ConstructionHackathon

Feature List: 
- Dashboard with general overview
- Categorization by type, cost, dependencys of the items(what do the items require?, like chairs for a table)
- risk assesment, relationships between things/ Fancy mind map
- importing from different file typed -> edeting the list -> exporting to different file types, also the stuped construction one




Baseline project:

# 🏗️ [Project Name]

> **AI-powered risk and error detection for German Bills of Quantities (*Leistungsverzeichnisse*).**  
> Built in 48 hours for the **TUM.ai Construction Hackathon** — *Beyond the Line Item* challenge (in partnership with the Bayerischer Bauindustrieverband).

![Status](https://img.shields.io/badge/Status-Hackathon%20MVP-orange)
![License](https://img.shields.io/badge/License-MIT-blue)
![Stack](https://img.shields.io/badge/Tech-Python%20%7C%20FastAPI%20%7C%20Next.js%20%7C%20LLMs-green)

---

## 📌 The Problem

Estimators (*Kalkulatoren*) in the German construction industry regularly review 500+ page Bills of Quantities (*Leistungsverzeichnisse*, or LVs) in GAEB or PDF format under tight tender deadlines. 

Standard text search and naive RAG pipelines fail on these documents because **context is strictly hierarchical**: a single line item (*Position*) cannot be evaluated without its parent section (*Titel*) and the general notes (*Vorbemerkungen*) buried pages earlier. Missing a single contradiction, unit mismatch, or hidden VOB/B risk clause can turn a profitable bid into a major financial loss.

## 💡 Our Solution

**[Project Name]** parses tender documents into their native hierarchical structure and runs context-aware AI analysis across every line item. Instead of generating generic summaries or noisy alerts, it surfaces high-impact financial, technical, and legal risks—and turns them directly into actionable bidder clarification questions (*Bieterfragen*).

### Key Features
* **Structure-Aware Parsing:** Ingests GAEB (`.x83` / `.d83`) and PDF LVs while preserving the exact `Document → Vorbemerkungen → Titel → Position (OZ)` hierarchy.
* **Cross-Document Contradiction Detection:** Flags mismatches between general notes, referenced DIN norms, and individual line items (e.g., conflicting concrete exposure classes).
* **Risk & Anomaly Classification:** Categorizes issues by type (*Missing Dependencies*, *Unit/Quantity Anomalies*, *VOB/B Contractual Traps*, *Vague Specs*) and severity to eliminate alert fatigue.
* **Full Traceability:** Every flag links directly to the exact *Ordnungszahl* (OZ) with side-by-side citations of the conflicting text.
* **Actionable Output:** One-click drafting of formal *Bieterfragen* (for the client) and internal *Nachtragspotenzial* notes (for the estimating team).

---

## 🧠 Architecture

```mermaid
flowchart LR
    A[GAEB XML / PDF LV] --> B[Hierarchical Parser]
    B --> C[Tree Structure: Vorbemerkungen + Titel + OZ]
    C --> D[Context Injection Engine]
    D --> E[Rule-Based Checks + LLM Risk Agents]
    E --> F[Severity Scoring & Deduplication]
    F --> G[Estimator Dashboard + Bieterfragen Export]
