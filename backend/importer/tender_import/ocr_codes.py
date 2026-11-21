"""Recover dotted position numbers directly from an isolated scanned column."""

from collections import defaultdict
from itertools import groupby
import re

from .common import local_name, parse_xml

_DESCRIPTION = "Leistungsbeschreibung"
_PLAIN_CODE = re.compile(r"^ *\d{1,5}[ \t]{2,}\S")
_TRAILING_DIGITS = re.compile(r"\.?\d{1,5}")


def _code_boxes(tsv):
    for row in tsv.decode("utf-8", errors="replace").splitlines():
        fields = row.split("\t")
        if len(fields) == 12 and fields[0] == "5" and _TRAILING_DIGITS.fullmatch(fields[11]):
            yield (*map(int, fields[6:10]), fields[11])


def _has_leading_dot(pixels, width, height, code_box):
    """Look for a separate, compact ink mark at the baseline before the digits."""
    x, y, w, h, _ = code_box
    if not 12 <= h <= 80 or not (0 <= x < x + w <= width and 0 <= y < y + h <= height):
        return False
    left, right = max(0, x - h // 2), min(width, x + w)
    top, bottom = max(0, y - 2), min(height, y + h + 2)
    ink = {}
    for column in range(left, right):
        rows = [row for row in range(top, bottom) if pixels[row * width + column] < 100]
        if rows:
            ink[column] = rows
    groups = [list(columns) for dark, columns in groupby(range(left, right), key=ink.__contains__) if dark]
    if len(groups) < 2:
        return False
    dot, digits = groups[:2]
    dot_rows = [row for column in dot for row in ink[column]]
    dot_width = len(dot)
    dot_height = max(dot_rows) - min(dot_rows) + 1
    digit_top = min(row for column in digits for row in ink[column])
    gap = digits[0] - dot[-1] - 1
    return (2 <= dot_width <= h // 3 and 2 <= dot_height <= h // 3
            and dot_width / 2 <= dot_height <= dot_width * 2
            and digit_top <= y + h * 0.3 and min(dot_rows) >= y + h * 0.62 and max(dot_rows) >= y + h * 0.8
            and 2 <= gap <= h // 2 and len(dot_rows) >= dot_width * dot_height / 2)


def reread_codes(layout, header, boxes, render, recognize, *, dpi, raster_size):
    """Verify both digits and the printed leading dot before attaching an OCR code."""
    lines = layout.splitlines(keepends=True)
    if not header or len([line for line in lines[header[0]:] if _PLAIN_CODE.match(line)]) < 2:
        return layout, []
    header_text = header[1].string
    description = re.search(rf"\b{_DESCRIPTION}\b", header_text, re.I)
    if not description or header[1]["code"].casefold() != "oz":
        return layout, []

    scale = dpi / 72
    words = [(element.text, tuple(round(float(element.get(key, "")) * scale)
                                  for key in ("xMin", "yMin", "xMax", "yMax")))
             for element in parse_xml(boxes(), generated=True).iter()
             if local_name(element) == "word" and element.text]
    headings = [box for word, box in words if word.casefold() == _DESCRIPTION.casefold()]
    if len(headings) != 1:
        return layout, []
    description_x, heading_top, _, heading_bottom = headings[0]
    code_heads = [box for word, box in words if word.casefold() == "oz" and abs(box[1] - heading_top) <= 8]
    if len(code_heads) != 1:
        return layout, []

    text_rows = defaultdict(list)
    for index, line in enumerate(lines[header[0]:], header[0]):
        lead = next((word for word in re.finditer(r"\S+", line)
                     if abs(word.start() - description.start()) <= 2), None)
        if lead and re.fullmatch(r"\.?[\w]{0,5}", line[:lead.start()].strip()):
            text_rows[lead[0]].append((index, lead.start()))
    visual_rows = defaultdict(list)
    for word, bbox in words:
        if abs(bbox[0] - description_x) <= 5 and bbox[1] > heading_bottom:
            visual_rows[word].append(bbox)
    anchors = []
    for word, entries in text_rows.items():
        positions = sorted(visual_rows[word], key=lambda box: box[1])
        if len(entries) == len(positions):
            anchors.extend((bbox, index, start) for (index, start), bbox in zip(entries, positions))

    code_x = code_heads[0][0]
    left = max(0, code_x - 25)
    right = min(description_x - 16, code_x + 70)
    top = max(0, heading_bottom + 8)
    bottom = min(raster_size, max((box[3] for box, _, _ in anchors), default=0) + 6)
    if not (left < right and top < bottom):
        return layout, []
    # Double the render scale to separate very small punctuation from digit strokes.
    image = render((2 * left, 2 * top, 2 * (right - left), 2 * (bottom - top)))
    magic, dimensions, depth, pixels = image.split(b"\n", 3)
    width, height = map(int, dimensions.split())
    if magic != b"P5" or depth != b"255" or len(pixels) != width * height:
        return layout, []
    first, second = (list(_code_boxes(recognize(image, mode))) for mode in ("6", "4"))
    evidence = []
    for reading in first:
        x, y, w, h, token = reading
        digits = token.lstrip(".")
        confirmations = [other[-1] for other in second
                         if other[-1].lstrip(".") == digits and abs(other[1] - y) <= 6]
        if len(confirmations) != 1:
            continue
        if not _has_leading_dot(pixels, width, height, reading):
            continue
        center = top + (y + h / 2) / 2
        matches = [(index, start) for bbox, index, start in anchors if bbox[1] - 4 <= center <= bbox[3] + 7]
        if len(matches) != 1:
            continue
        index, start = matches[0]
        original = lines[index][:start].strip()
        code = f".{digits}"
        if original.startswith(".") or original.isdecimal() and original != digits:
            continue
        indent = header[1]["indent"]
        padding = max(2, start - len(indent) - len(code))
        lines[index] = f'{indent}{code}{" " * padding}{lines[index][start:]}'
        evidence.append({"line": index + 1, "original": original or None, "code": code, "readings": [token, confirmations[0]],
                         "bbox_px": [2 * left + max(0, x - h // 2), 2 * top + max(0, y - 2),
                                     2 * left + x + w, 2 * top + min(height, y + h + 2)],
                         "raster_size": raster_size * 2})
    return "".join(lines), evidence
