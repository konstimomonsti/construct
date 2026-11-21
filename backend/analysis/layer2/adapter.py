"""JSON input for layer 2. The loader is shared with the rest of the pipeline (analysis/adapter.py)."""

from ..adapter import canonical_hash, from_data, from_json, parse_number

__all__ = ["canonical_hash", "from_data", "from_json", "parse_number"]
