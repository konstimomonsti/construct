"""Golden calibration on the six reference lists, without network or model calls."""

from decimal import Decimal, ROUND_HALF_UP
from math import floor
from pathlib import Path

import pytest

from analysis import adapter
from analysis.runner import analyze


ROOT = Path(__file__).resolve().parents[3]


@pytest.mark.parametrize("path,score_range,money_range", [
    ("backend/analysis/eval/seeds/building_hall.json", (0, 24), (5000, 20000)),
    ("data/demo/building_hall_planted.X83", (50, 70), (8000, 30000)),
    ("backend/analysis/tests/fixtures/lv11_precast.json", (25, 49), None),
    ("data/tenders/8209.003_Leistungsverzeichnis_leer.X83", (50, 74), None),
    ("data/tenders/StBALV23040.D86", (50, 74), (20000, 70000)),
    ("data/tenders/[ORT_024] LV24069.D86", (75, 90), (20000, 70000)),
])
def test_reference_lists(path, score_range, money_range):
    source = ROOT / path
    analysis_input = adapter.from_json(source) if source.suffix == ".json" else adapter.from_file(source)
    result = analyze(analysis_input, layers=(1, 2))
    assert not result.errors
    risk = result.risk
    assert score_range[0] <= risk.score <= score_range[1]
    assert risk.scale > 40
    assert sum(risk.points.values()) == pytest.approx(sum(row.points for row in risk.by_section))
    points = sum((Decimal(str(p)) for p in risk.points.values()), Decimal(0))
    assert risk.score == int((100 * points / (points + risk.scale)).quantize(Decimal(1), rounding=ROUND_HALF_UP))
    # frontend/src/lib/risk-assessment.ts uses Math.round with the report's scale.
    assert risk.score == floor(100 * float(points) / (float(points) + risk.scale) + 0.5)
    if money_range is None:
        assert risk.money_at_stake is None
    else:
        assert money_range[0] <= risk.money_at_stake <= money_range[1]


def test_planted_list_outscores_clean_seed_by_fifteen():
    clean = analyze(adapter.from_json(ROOT / "backend/analysis/eval/seeds/building_hall.json"),
                    layers=(1, 2)).risk
    planted = analyze(adapter.from_file(ROOT / "data/demo/building_hall_planted.X83"),
                      layers=(1, 2)).risk
    assert clean.score < 25
    assert planted.score - clean.score >= 15
    assert planted.scale == clean.scale
