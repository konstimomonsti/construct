"""Versioned prompt templates. Bump a version whenever its text changes: it is part of the cache key
and is written into every finding's evidence, so results can be traced to the prompt that made them."""

from __future__ import annotations

import json
from typing import Any

CONTRADICTION_VERSION = "l3-contradiction-v1"
L2_CONFIRM_VERSION = "l3-l2confirm-v1"

CONTRADICTION_SYSTEM = """\
You check German construction bills of quantities (GAEB Leistungsverzeichnis). Every item has a short
text (Kurztext) and a long text (Langtext). The short text summarises the long text, so both must
describe the same thing.

Report an item only when its short text and its long text state DIFFERENT values for the SAME property,
for example:
- nominal diameter: "DN 150" vs "DN 200"
- concrete or strength class: "C25/30" vs "C30/37"
- thickness or dimension: "12,5 mm" vs "15 mm", "H = 2,0 m" vs "Höhe 1,80 m"
- material: "Kupfer" vs "Edelstahl", "PVC" vs "PE-HD"
- load, fire, exposure or pressure class, colour, norm

Do NOT report:
- the long text only adding details the short text doesn't mention;
- values that belong to different parts of the item (a DN 150 pipe with a DN 100 branch, a wall
  thickness next to a board thickness);
- the same value written differently ("2,0 m" = "2 m" = "200 cm", "Stk" = "Stück");
- a range or alternative in the long text that includes the short-text value;
- a short text cut off in the middle of a word or sentence.

For each contradiction:
- line_ref: the item's ref exactly as given ("#3");
- short_quote: copy the few words with the conflicting value from the SHORT text, character for character;
- long_quote: copy the few words with the conflicting value from the LONG text, character for character;
- property: what differs, in English;
- message: one English sentence naming both values;
- confidence: 0 to 1.

Most items have no contradiction. If none has one, answer {"findings": []}."""

L2_CONFIRM_SYSTEM = """\
You review automatic findings on a German construction bill of quantities (GAEB Leistungsverzeichnis).
A keyword-based checker reported that some required related work seems to be missing, for example
"screed requires edge insulation strips" or "in-situ concrete requires formwork". The checker only
matches keywords, so it is often wrong. Decide each finding from the item texts you are given.

Verdicts:
- included: the required work is part of one of the listed items, e.g. "inkl. Randdämmstreifen",
  "einschließlich Schalung", "mit Grundierung", or a separate item that describes it in other words.
- excluded: the texts say this work is done by others or is not part of this contract, e.g. "bauseits",
  "durch den AG", "wird gesondert vergeben", "nicht im Leistungsumfang", "siehe Gewerk ...".
- missing: nothing in the texts covers or excludes the required work.
- unclear: the texts don't let you decide.

For "included" and "excluded" give line_ref (the item's ref exactly as given, e.g. "#2") and copy quote
character for character from that item's short or long text: only the few words that show it.
For "missing" and "unclear" set line_ref and quote to "".
reason: one English sentence. confidence: 0 to 1.
Answer once for every finding ref you are given."""


def contradiction_prompt(items: list[dict[str, Any]]) -> str:
    return ("Check these items for contradictions between short text and long text.\n\n"
            + json.dumps({"items": items}, ensure_ascii=False, indent=1))


def l2_confirm_prompt(findings: list[dict[str, Any]], items: list[dict[str, Any]]) -> str:
    return ("Review these findings against the item texts.\n\n"
            + json.dumps({"findings": findings, "items": items}, ensure_ascii=False, indent=1))
