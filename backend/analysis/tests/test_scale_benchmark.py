"""Scale benchmark for 1k and 10k lines with nested sections.

Records:
- Elapsed time per stage (validation, Layer 1, Layer 2, risk scoring, overall)
- Peak memory usage
- Stage timings breakdown
"""

from decimal import Decimal
import time
import tracemalloc
import pytest

from analysis.contracts import AnalysisInput, Line, PriceInfo, Section
from analysis.graph import validate_graph
from analysis import layer1, layer2
from analysis.risk.score import assess


def generate_nested_lv(num_lines: int) -> AnalysisInput:
    """Generate a realistic BoQ with multi-level nested sections and priced positions."""
    num_top = 5
    num_sub = 20
    sections = []

    # Top-level sections (e.g. 01 Rohbau, 02 Ausbau...)
    for i in range(num_top):
        sections.append(Section(id=f"sec_{i}", parent_id=None, code=f"{i+1:02d}", title=f"Trade {i+1}", sort_order=i * 100))

    # Nested sub-sections (e.g. 01.01 Erdarbeiten, 01.02 Betonarbeiten...)
    for j in range(num_sub):
        parent = f"sec_{j % num_top}"
        sections.append(Section(id=f"subsec_{j}", parent_id=parent, code=f"{(j%num_top)+1:02d}.{(j//num_top)+1:02d}", title=f"Sub-trade {j+1}", sort_order=j * 10))

    lines = []
    trades = [
        ("Ortbeton C25/30 für Bodenplatte", "m³", Decimal("150.00"), Decimal("220.00")),
        ("Schalung für Fundamente und Wände", "m²", Decimal("350.00"), Decimal("45.00")),
        ("Betonstahl B500B liefern und verlegen", "kg", Decimal("12000.00"), Decimal("1.85")),
        ("PVC-Rohr DN 150 im Erdreich verlegen", "m", Decimal("80.00"), Decimal("65.00")),
        ("Erdaushub Baugrube Bodenklasse 3-4", "m³", Decimal("500.00"), Decimal("28.00")),
    ]

    for k in range(num_lines):
        desc, unit, qty, up = trades[k % len(trades)]
        sec_id = f"subsec_{k % num_sub}"
        lines.append(Line(
            id=f"line_{k}",
            code=f"{(k//100)+1:02d}.{(k%100)+1:04d}",
            section_id=sec_id,
            sort_order=k,
            short_text=f"{desc} #{k+1}",
            long_text=f"Ausführliche Beschreibung für {desc} Pos {k+1}. DIN 1045 konform.",
            quantity=qty,
            unit=unit,
            price=PriceInfo(unit_price=up, line_amount=qty * up),
        ))

    return AnalysisInput(sections=sections, lines=lines).with_hash()


def benchmark_boq(num_lines: int) -> dict:
    inp = generate_nested_lv(num_lines)

    tracemalloc.start()
    t_start = time.perf_counter()

    # Stage 1: Graph validation
    t0 = time.perf_counter()
    graph_res = validate_graph(inp)
    t_val = time.perf_counter() - t0
    assert graph_res.is_valid, f"Graph validation failed: {graph_res.errors}"

    # Stage 2: Layer 1 deterministic checks
    t0 = time.perf_counter()
    l1_findings = layer1.run(inp, [], [])
    t_l1 = time.perf_counter() - t0

    # Stage 3: Layer 2 dependency checks
    t0 = time.perf_counter()
    l2_findings = layer2.run(inp, l1_findings)
    t_l2 = time.perf_counter() - t0

    # Stage 4: Risk scoring
    t0 = time.perf_counter()
    all_findings = l1_findings + l2_findings
    risk_assessment = assess(inp, all_findings)
    t_risk = time.perf_counter() - t0

    total_time = time.perf_counter() - t_start
    current_mem, peak_mem = tracemalloc.get_traced_memory()
    tracemalloc.stop()

    results = {
        "lines": num_lines,
        "sections": len(inp.sections),
        "validation_time_s": round(t_val, 4),
        "layer1_time_s": round(t_l1, 4),
        "layer2_time_s": round(t_l2, 4),
        "risk_time_s": round(t_risk, 4),
        "total_time_s": round(total_time, 4),
        "peak_memory_mb": round(peak_mem / (1024 * 1024), 2),
        "l1_findings_count": len(l1_findings),
        "l2_findings_count": len(l2_findings),
        "risk_score": risk_assessment.score,
    }
    return results


def test_scale_benchmark_1k_lines():
    res = benchmark_boq(1_000)
    print(f"\n--- 1K Line Benchmark ---")
    print(f"Total time: {res['total_time_s']}s (Val: {res['validation_time_s']}s, L1: {res['layer1_time_s']}s, L2: {res['layer2_time_s']}s, Risk: {res['risk_time_s']}s)")
    print(f"Peak memory: {res['peak_memory_mb']} MB")
    print(f"Findings: {res['l1_findings_count']} L1, {res['l2_findings_count']} L2, Score: {res['risk_score']}")

    assert res["lines"] == 1_000


def test_scale_benchmark_10k_lines():
    res = benchmark_boq(10_000)
    print(f"\n--- 10K Line Benchmark ---")
    print(f"Total time: {res['total_time_s']}s (Val: {res['validation_time_s']}s, L1: {res['layer1_time_s']}s, L2: {res['layer2_time_s']}s, Risk: {res['risk_time_s']}s)")
    print(f"Peak memory: {res['peak_memory_mb']} MB")
    print(f"Findings: {res['l1_findings_count']} L1, {res['l2_findings_count']} L2, Score: {res['risk_score']}")

    assert res["lines"] == 10_000
