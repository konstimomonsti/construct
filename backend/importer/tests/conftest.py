from pathlib import Path
import sys

# Let `pytest importer/tests` find tender_import (and, for the golden tests, the analysis package) on its own.
IMPORTER = Path(__file__).resolve().parents[1]
for path in (IMPORTER.parent, IMPORTER):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))
