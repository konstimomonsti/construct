"""Proof on bills of quantities with known, planted errors.

A clean synthetic seed is mutated one error at a time; every mutated file gets a label file that says
what a correct analysis must report. `python -m analysis.eval` runs the analysis on the mutated files
and measures what it caught, missed and falsely raised. See docs/EVALUATION.md.
"""

from pathlib import Path

EVAL_DIR = Path(__file__).resolve().parent
SEED_PATH = EVAL_DIR / "seeds" / "building_hall.json"
DEFAULT_OUT = Path("eval_out")
