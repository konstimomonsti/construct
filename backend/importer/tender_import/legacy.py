from base64 import b64encode
from collections import Counter, defaultdict
from decimal import Decimal
from itertools import groupby
import re

from .common import Result

# Offsets are zero-based byte ranges. Record body ends before the six-character sequence.
# Keep the complete record and explicitly preserve every slice outside known fields.
_FIELDS = {
    "00": {"phase": (10, 12), "exchange_flag": (12, 13), "reference": (13, 61),
           "number_mask": (61, 70), "edition": (71, 73)},
    "01": {"title": (2, 42), "lv_date": (42, 50), "other_date": (50, 58)},
    "02": {"project_text": (2, 74)},
    "03": {"client_text": (2, 74)},
    "04": {"bidder_text": (2, 74)},
    "06": {"component_count": (2, 3), **{f"component_{i+1}_label": (17+i*14, 31+i*14) for i in range(4)}},
    "07": {"text": (2, 74)},
    "08": {"currency_code": (2, 8), "currency_label": (8, 74)},
    "11": {"number": (2, 11), "kind_flag": (11, 12), "label_type": (16, 74)},
    "12": {"text": (2, 74)},
    "20": {"body": (2, 74)},
    "21": {"number": (2, 11), "position_type": (11, 12), "provisional_flag": (12, 13),
           "extra_type_flag": (13, 14), "quantity": (23, 34), "unit": (34, 38)},
    "22": {"number": (2, 11), "unit_price": (12, 23), "line_amount": (24, 36), "quantity": (37, 48)},
    "23": {"number": (2, 11), "unit_price": (12, 23), "line_amount": (24, 36), "quantity": (37, 48)},
    "24": {"subdescription_number": (2, 5), "quantity": (5, 16), "unit": (16, 20)},
    "25": {"text": (2, 74)},
    "26": {"text": (5, 74), "control": (2, 5)},
    "28": {"body": (2, 74)},
    "30": {f"component_{i+1}_amount": (12+i*10, 22+i*10) for i in range(4)},
    "31": {"number": (2, 11)},
    "32": {"number": (2, 11), "reported_amount": (12, 24), "adjustment_raw": (24, 31)},
    "41": {"body": (2, 74)},
    "42": {"body": (2, 74)},
    "99": {"net_total": (2, 14), "tax_rate_percent": (21, 25), "gross_total": (25, 37),
           "position_count": (69, 74)},
    "T0": {"body": (2, 74)},
    "T1": {"text": (2, 74)},
    "T9": {"body": (2, 74)},
}


def choose_encoding(lines):
    samples = b"\n".join(line[2:74] for line in lines if line[:2] in {b"01", b"12", b"25", b"26", b"T1"})
    if samples.isascii():
        samples = b"\n".join(lines)
    if samples.isascii():
        return "ascii", {}
    scores = {}
    for encoding in ("cp850", "cp1252", "cp437", "iso8859_1"):
        try:
            decoded = samples.decode(encoding)
        except UnicodeDecodeError:
            continue
        german = sum(decoded.count(char) for char in "äöüÄÖÜß²³–°")
        atypical = sum(0x80 <= ord(char) <= 0x9F or 0x2500 <= ord(char) <= 0x259F
                       or char in "¶»¼¾Žž†‡" for char in decoded)
        scores[encoding] = german * 3 - atypical * 4
    return max(scores, key=scores.get), scores


def scaled(raw: str, precision: int) -> str | None:
    value = raw.strip()
    if not re.fullmatch(r"[+-]?\d+", value):
        return None
    return str(Decimal(value).scaleb(-precision))


def legacy_price(raw: str) -> str | None:
    # GAEB 90 has two decimals plus an optional tenth-of-a-cent digit.
    if not raw.strip():
        return None
    return scaled(raw[:10] + (raw[10:11].strip() or "0"), 3)


def legacy_fields(line: str, kind: str):
    spec = _FIELDS.get(kind, {})
    fields = {name: line[start:end] for name, (start, end) in spec.items()}
    spans = sorted(spec.values())
    unassigned = []
    cursor = 2
    for start, end in [*spans, (min(74, len(line)), min(74, len(line)))]:
        if start > cursor:
            unassigned.append({"start_column": cursor + 1, "end_column": start, "raw": line[cursor:start]})
        cursor = max(cursor, end)
    return fields, unassigned


def number_parts(raw: str, mask: str) -> list[str]:
    segments = []
    offset = 0
    for _, group in groupby(mask):
        length = len(list(group))
        part = raw[offset:offset + length].strip()
        if part:
            segments.append(part)
        offset += length
    return segments


def record_view(raw, encoding):
    # GAEB positions are byte offsets. Every candidate encoding is single-byte.
    return raw.decode(encoding, errors="replace").replace("\x00", "␀")


def gaeb_1990(data: bytes, *, encoding_override: str | None = None) -> Result:
    # splitlines() would also split on embedded non-record control bytes.
    lines = re.split(rb"\r\n|\n|\r", data)
    if lines and not lines[-1]:
        lines.pop()
    opening = next((line for line in lines if line[:2] == b"00"), None)
    if opening is None:
        raise ValueError("Legacy GAEB file has no opening record")
    encoding, scores = choose_encoding(lines)
    if encoding_override is not None:
        encoding = encoding_override
    header, _ = legacy_fields(record_view(opening, encoding), "00")
    mask = record_view(opening, encoding)[61:71].strip()
    if len(mask) > 9 or not re.fullmatch(r"[1-9]*P+I?", mask):
        mask = "1122PPPPI"
    result = Result("gaeb_1990", "1990", header["phase"].strip())
    result.metadata.update(encoding=encoding, encoding_scores=scores, encoding_override=encoding_override,
                           reference=header["reference"].strip() or None, number_mask=mask)
    known_rows = []
    counts = Counter()
    prices = defaultdict(list)
    for number, raw in enumerate(lines, 1):
        decoded = record_view(raw, encoding)
        kind = decoded[:2]
        counts[kind] += 1
        locator = {"record": number, "sequence": decoded[74:80], "record_type": kind}
        fields, unassigned = legacy_fields(decoded, kind)
        result.add("legacy_record", locator, raw_base64=b64encode(raw).decode("ascii"), decoded=decoded,
                   byte_length=len(raw), fields=fields, unassigned_slices=unassigned,
                   trailing_data=decoded[80:] or None)
        if len(raw) != 80 or not decoded[74:80].isdigit():
            result.warn("malformed_legacy_record", locator, "Record width or six-digit sequence is invalid")
        if "�" in decoded:
            result.warn("legacy_decode_replacement", locator, f"One or more bytes could not be decoded as {encoding}")
        if kind not in _FIELDS:
            result.warn("unmapped_legacy_record_type", locator, f"Record type {kind!r} is preserved with its original payload")
        known_rows.append((kind, locator, fields))
        if kind in {"21", "22", "23"}:
            prefix = fields["number"][:8]
            if not re.fullmatch(r"[ 0-9]+", prefix) or not prefix.strip():
                result.warn("damaged_item_code", locator, f"Cannot normalize source item code {fields['number']!r}")
        if kind in {"22", "23"}:
            price = {"code_parts": number_parts(fields["number"], mask), "code_raw": fields["number"],
                     "unit_price": legacy_price(fields["unit_price"]),
                     "line_amount": scaled(fields["line_amount"], 2),
                     "quantity": scaled(fields["quantity"], 3)}
            for field in ("unit_price", "line_amount", "quantity"):
                if fields[field].strip() and price[field] is None:
                    result.warn("invalid_legacy_decimal", locator, f"Malformed {field}")
            result.add("price", locator, **price)
            prices[fields["number"]].append({"locator": locator, **price})
        elif kind == "01":
            result.metadata["title"] = fields["title"].strip()
        elif kind == "08":
            result.metadata["currency"] = fields["currency_code"].strip()
        elif kind == "99":
            result.add("summary", locator, net_total=scaled(fields["net_total"], 2),
                       gross_total=scaled(fields["gross_total"], 2),
                       tax_rate_percent=scaled(fields["tax_rate_percent"], 2),
                       declared_position_count=scaled(fields["position_count"], 0))
        elif kind == "32":
            result.add("subtotal", locator, code_parts=number_parts(fields["number"], mask),
                       reported_amount=scaled(fields["reported_amount"], 2))

    result.metadata["legacy_record_types"] = dict(counts)
    assemble_legacy_items(result, known_rows, prices, mask)
    return result


def assemble_legacy_items(result, records, prices, mask):
    current = None
    section = None
    note = None
    subdescription = None

    def flush_item():
        if current is None:
            return
        payload = current.copy()
        locator = payload.pop("locator")
        short = payload.pop("short_lines")
        long = payload.pop("long_lines")
        result.add("item", locator, **payload,
                   short_description="\n".join(short) or None, long_description="\n".join(long) or None)

    def flush_note():
        if note is not None:
            result.add("note", note["locator"], text="\n".join(note["lines"]), record_type=note["locator"]["record_type"])

    for kind, locator, fields in records:
        if kind in {"11", "20", "21", "31", "99", "T0", "T9"}:
            flush_item()
            flush_note()
            current, note, subdescription = None, None, None
        if kind == "11":
            section = {"code_parts": number_parts(fields["number"], mask), "locator": locator}
        elif kind == "12":
            result.add("section", locator, label=fields["text"].rstrip(), code_parts=section["code_parts"] if section else [])
        elif kind in {"20", "T0"}:
            note = {"locator": locator, "lines": []}
        elif kind == "21":
            raw_code = fields["number"]
            valid = bool(re.fullmatch(r"[ 0-9]+", raw_code[:8]) and raw_code[:8].strip())
            parts = number_parts(raw_code, mask)
            quantity = scaled(fields["quantity"], 3)
            if fields["quantity"].strip() and quantity is None:
                result.warn("invalid_legacy_decimal", locator, "Malformed quantity")
            current = {
                "locator": locator, "code_raw": raw_code, "code_parts": parts,
                "code": ".".join(parts) if valid else None, "quantity": quantity,
                "unit": fields["unit"].strip() or None, "flags": {name: fields[name] for name in
                    ("position_type", "provisional_flag", "extra_type_flag")},
                "price_records": prices.get(raw_code, []), "short_lines": [], "long_lines": [],
                "subdescriptions": [], "price_components": [],
            }
        elif kind == "24" and current is not None:
            subdescription = {"locator": locator, "number_raw": fields["subdescription_number"],
                              "quantity": scaled(fields["quantity"], 3), "unit": fields["unit"].strip() or None,
                              "short_lines": [], "long_lines": []}
            current["subdescriptions"].append(subdescription)
        elif kind in {"25", "26", "T1"}:
            line = fields["text"].rstrip()
            if current is not None:
                target = subdescription if subdescription is not None else current
                target["short_lines" if kind == "25" else "long_lines"].append(line)
            elif note is not None:
                note["lines"].append(line)
        elif kind == "30" and current is not None:
            current["price_components"].append({"locator": locator,
                                                 **{key: scaled(raw, 2) for key, raw in fields.items()}})
    flush_item()
    flush_note()
