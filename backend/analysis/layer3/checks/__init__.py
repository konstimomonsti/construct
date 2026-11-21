"""Layer 3 check modules. Each registers its rules on import.

The import order is the run order, and so the order in which the call budget is spent: the precast
extraction and scope audit (P0) first, then the general text, review and quantity checks.
"""

from . import precast, scope, overlap, contradictions, l2_confirm, underspecified, quantities  # noqa: F401
