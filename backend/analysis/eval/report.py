"""The results tables: recall per mutation type, controls, precision per rule, gaps and misses.

Recall of a type = caught / (labels - not run). A gap counts against recall: it is an error the tool does not
find today. The "excluding gaps" line shows how the existing rules do on the errors they are meant to find.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from pathlib import Path

from . import catalogue
from .harness import Evaluation, LabelOutcome


def pct(part: int, whole: int) -> str:
    return f"{100 * part / whole:.0f}%" if whole else "n/a"


def table(headers: list[str], rows: list[list], align: str | None = None) -> str:
    align = align or "l" + "r" * (len(headers) - 1)
    lines = ["| " + " | ".join(headers) + " |",
             "|" + "|".join(":---" if a == "l" else "---:" for a in align) + "|"]
    lines += ["| " + " | ".join(str(cell) for cell in row) + " |" for row in rows]
    return "\n".join(lines)


def _tally(outcomes: list[LabelOutcome]) -> Counter:
    return Counter(o.outcome for o in outcomes)


def recall_rows(evaluation: Evaluation) -> tuple[list[list], Counter, Counter]:
    planted = [o for o in evaluation.outcomes if o.suite == "catalogue" and not o.label.get("control")]
    by_type: dict[str, list[LabelOutcome]] = defaultdict(list)
    for outcome in planted:
        by_type[outcome.label["mutation_type"]].append(outcome)
    rows = []
    total, detectable = Counter(), Counter()
    order = list(catalogue.TYPES_BY_NAME) + sorted(set(by_type) - catalogue.TYPES_BY_NAME.keys())
    for name in order:
        outcomes = by_type.get(name)
        if not outcomes:
            continue
        mutation_type = catalogue.TYPES_BY_NAME.get(name)
        label = outcomes[0].label
        title = mutation_type.title if mutation_type else label["description"]
        expected = mutation_type.expect if mutation_type else " / ".join(label["expect"])
        gap = bool(label.get("gap"))
        tally = _tally(outcomes)
        denominator = len(outcomes) - tally["not_run"]
        rows.append([title + (" (gap)" if gap else ""), f"`{expected}`",
                     len(outcomes), tally["caught"], tally["missed"], tally["gap"], tally["not_run"],
                     pct(tally["caught"], denominator)])
        total.update(tally)
        total["n"] += len(outcomes)
        if not gap:
            detectable.update(tally)
            detectable["n"] += len(outcomes)
    return rows, total, detectable


def control_rows(evaluation: Evaluation) -> list[list]:
    controls = [o for o in evaluation.outcomes if o.label.get("control")]
    by_type: dict[str, list[LabelOutcome]] = defaultdict(list)
    for outcome in controls:
        by_type[outcome.label["mutation_type"]].append(outcome)
    rows = []
    order = ["CTRL-CLEAN"] + [t.name for t in catalogue.TYPES if t.control]
    for mutation_type in order + sorted(set(by_type) - set(order)):
        outcomes = by_type.get(mutation_type)
        if not outcomes:
            continue
        title = (catalogue.TYPES_BY_NAME[mutation_type].title if mutation_type in catalogue.TYPES_BY_NAME
                 else outcomes[0].label["description"])
        bad = sum(1 for o in outcomes if o.outcome == "false_alarm")
        rows.append([title, len(outcomes), len(outcomes) - bad, bad])
    return rows


def precision_rows(evaluation: Evaluation) -> list[list]:
    rows = []
    for rule_id, counts in sorted(evaluation.per_rule.items()):
        tp, fp, other = counts["tp"], counts["fp"], counts["acceptable"]
        rows.append([f"`{rule_id}`", tp, fp, other, pct(tp, tp + fp)])
    return rows


def guidance_rows(evaluation: Evaluation) -> list[list]:
    by_layer: dict[int, Counter] = defaultdict(Counter)
    for outcome in evaluation.outcomes:
        if outcome.suite != "catalogue" or outcome.outcome != "caught":
            continue
        for finding in outcome.matched:
            by_layer[finding["layer"]][finding.get("guidance", "unknown")] += 1
    return [[layer, counts["patch"], counts["bidder_question"], counts["review"], counts["none"], counts["unknown"]]
            for layer, counts in sorted(by_layer.items())]


def format_report(evaluation: Evaluation, *, seed_info: str = "") -> str:
    out: list[str] = []
    ran = [layer for layer in evaluation.layers_requested if layer not in evaluation.layers_not_run]
    out.append(f"Evaluated {evaluation.files} files. {seed_info}".strip())
    out.append(f"Layers run: {', '.join(map(str, ran)) or 'none'}"
               + (f". Not run: {', '.join(map(str, sorted(evaluation.layers_not_run)))} "
                  f"(labels that only layer {', '.join(map(str, sorted(evaluation.layers_not_run)))} can catch count as "
                  f"\"not run\", not as missed)." if evaluation.layers_not_run else "."))

    rows, total, detectable = recall_rows(evaluation)
    out.append("\n### Recall per mutation type\n")
    footer = [
        ["**All planted errors**", "", total["n"], total["caught"], total["missed"], total["gap"], total["not_run"],
         pct(total["caught"], total["n"] - total["not_run"])],
        ["**Excluding the known gaps**", "", detectable["n"], detectable["caught"], detectable["missed"],
         detectable["gap"], detectable["not_run"], pct(detectable["caught"], detectable["n"] - detectable["not_run"])],
    ]
    out.append(table(["Mutation", "Expected", "n", "Caught", "Missed", "Gap", "Not run", "Recall"], rows + footer,
                     "llrrrrrr"))
    backends = sorted({o.backend for o in evaluation.outcomes})
    out.append(f"\n*n counts files: each error is written once per format ({', '.join(backends)}).*")

    out.append("\n### Controls (nothing may be reported)\n")
    out.append(table(["Control", "Files", "Clean", "False alarms"], control_rows(evaluation)))

    out.append("\n### Precision per rule (new findings on the mutated files)\n")
    out.append(table(["Rule", "Correct", "False alarm", "Consequence", "Precision"], precision_rows(evaluation)))
    out.append("\n*Consequence*: a finding the label lists as an acceptable result of the change (for example a "
               "subtotal that no longer matches a changed line amount). It is neither correct nor false.")

    out.append("\n### Corrective guidance on matched findings\n")
    out.append(table(["Layer", "Patch", "Bidder question", "Review guidance", "None", "Unavailable"],
                     guidance_rows(evaluation)))
    out.append("\nA proposed patch takes precedence over a bidder question or review guidance. "
               "These counts measure presence. The proposed corrections still need review. "
               "Unavailable means the stored run predates guidance scoring.")

    missed = [o for o in evaluation.outcomes if o.outcome == "missed"]
    if missed:
        out.append("\n### Missed\n")
        out += [f"- `{o.file}`: {o.label['description']} (expected {', '.join(o.label['expect'])})" for o in missed]
    gaps = [o for o in evaluation.outcomes if o.outcome == "gap"]
    if gaps:
        out.append("\n### Known gaps (planted, not detected)\n")
        seen = defaultdict(list)
        for o in gaps:
            seen[o.label["mutation_type"]].append(o)
        for mutation_type, outcomes in seen.items():
            note = outcomes[0].label.get("note") or ""
            out.append(f"- **{mutation_type}** ({len(outcomes)} files), should be caught by "
                       f"`{' / '.join(outcomes[0].label['expect'])}`. {note}")
    if evaluation.false_alarms:
        out.append("\n### False alarms (new findings nobody planted)\n")
        out += [f"- `{file}`: `{finding['rule_id']}` on {finding['line_code'] or finding['section_code'] or 'the BoQ'}: "
                f"{finding['title']}" for file, finding in evaluation.false_alarms[:40]]
        if len(evaluation.false_alarms) > 40:
            out.append(f"- ... and {len(evaluation.false_alarms) - 40} more")

    demo = [o for o in evaluation.outcomes if o.suite == "demo"]
    if demo:
        out.append("\n### Presenter files\n")
        out += [f"- {o.label['description']} ({o.backend}): **{o.outcome}**" for o in demo]
    return "\n".join(out) + "\n"


def write_report(text: str, path: str | Path) -> None:
    Path(path).write_text(text, encoding="utf-8", newline="\n")
