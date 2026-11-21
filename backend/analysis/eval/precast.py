"""Planted cases for the precast-sandwich scope in LV_11."""

from decimal import Decimal

from .catalogue import Plan, clone_line, label, line_target, set_op


def plans(doc):
    lines = {line["code"]: line for line in doc["lines"]}

    def changed(name, code, description, field, value, expect, *, also=(), control=False, raw=False):
        line = lines[code]
        op = set_op(line, field, value)
        if raw:
            op["op"] = "raw_text"
        expected = label(target=line_target(line), expect=expect, match="none" if control else "line",
                         also=also, control=control)
        return Plan(name, name, description, [op], expected, {"position": code}, whitespace_only=raw)

    strength = changed("PRECAST-STRENGTH", "3.2.20", "C20/25 stated with XF4", "long_text",
                       lines["3.2.20"]["long_text"].replace("C35/45", "C20/25"), ["L1.DIN.EXPOSURE_STRENGTH"])
    strength.ops.append(set_op(lines["3.2.20"], "short_text", lines["3.2.20"]["short_text"].replace("C35/45", "C20/25")))

    return [
        strength,
        changed("PRECAST-LAYER-SUM", "3.2.30", "Dämmstoffdicke 10 cm gives a 32 cm layer sum", "long_text",
                lines["3.2.30"]["long_text"].replace("Dämmstoffdicke: 8 cm", "Dämmstoffdicke: 10 cm"),
                ["L1.PRECAST.LAYER_SUM"]),
        changed("PRECAST-UNIT", "3.2.80", "Zulage measured in metres rather than pieces", "unit", "m",
                ["L1.UNIT.TRADE_MISMATCH", "L1.UNIT.TEXT_MISMATCH"]),
        changed("PRECAST-PLACEHOLDER", "3.2.90", "Product type replaced by [FIRMA_123]", "long_text",
                lines["3.2.90"]["long_text"].replace("Typ S150", "[FIRMA_123]"),
                ["L1.TEXT.SPEC_PLACEHOLDER"]),
        changed("PRECAST-TEXT-CONFLICT", "3.2.50", "Short description states a different concrete class", "short_text",
                lines["3.2.50"]["short_text"].replace("C35/45", "C30/37"),
                ["L1.TEXT.VALUE_CONFLICT", "L3.TEXT.SHORT_LONG_CONTRADICTION"]),
        Plan("PRECAST-MISSING-DRAWINGS", "PRECAST-MISSING-DRAWINGS", "Remove the workshop drawings position",
             [{"op": "remove", "id": lines["3.2.10"]["id"]}],
             label(target={"trigger_codes": ["3.2.20", "3.2.30", "3.2.40", "3.2.50", "3.2.60"]},
                   expect=["L2.PRECAST.*"], match="dependency"), {"position": "3.2.10"}),
        changed("PRECAST-MISSING-SPEC", "3.2.40", "Remove height and colour of through-coloured precast concrete",
                "long_text", lines["3.2.40"]["long_text"].replace("Höhe 60 cm, ", "").replace(" in RAL 7032", ""),
                ["L3.PRECAST.MISSING_SPEC"],
                also=["L1.TEXT.SPEC_ATTRIBUTE_MISSING", "L1.PRECAST.MISSING_SPEC", "L2.PRECAST.*"]),
        rebar_plan(lines["3.2.70"]),
        changed("PRECAST-CTRL-WHITESPACE", "3.2.20", "Extra spaces in the short description", "short_text",
                "  " + lines["3.2.20"]["short_text"] + "  ", [], control=True, raw=True),
        Plan("PRECAST-CTRL-REORDER", "PRECAST-CTRL-REORDER", "Swap the order of two elements",
             [{"op": "swap", "a": lines["3.2.20"]["id"], "b": lines["3.2.30"]["id"]}],
             label(target={}, expect=[], match="none", control=True)),
        changed("PRECAST-CTRL-PLUS5", "3.2.110", "Unrelated traffic-control quantity increases by 5%",
                "quantity", Decimal("21"), [], control=True),
    ]


def rebar_plan(source):
    position = clone_line(source, "3.2.75", "lv11-3.2.75")
    position.update(short_text="Betonstahl B500B",
                    long_text="Betonstahl B500B liefern, schneiden, biegen und verlegen.")
    return Plan("PRECAST-REBAR-SCOPE", "PRECAST-REBAR-SCOPE", "Rebar supply without factory or site assignment",
                [{"op": "insert_after", "after_id": source["id"], "line": position}],
                label(target=line_target(position), expect=["L3.SCOPE.REBAR_AMBIGUOUS"], match="line"),
                {"position": position["code"]})
