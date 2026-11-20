import os
import sys
import re
import pdfplumber
import pandas as pd

# Regex patterns tailored to German LV format and resilient to spacing/kerning
OZ_PATTERN = re.compile(
    r"(?m)^\s*(\.\s*\d+(?:\s*\d+)*|\d+\.\d+\.(?:\s*\d+\.?)*)\s+"
)
QTY_UNIT_PATTERN = re.compile(
    r"(\d+(?:\s*\d+)*(?:\.\d{3})*,\d{3})\s*(m²|m|St|Set|Psch|psch|Satz|h)(?!\w)"
)
NUR_EINH_PR_PATTERN = re.compile(r"N\s*ur\s*Einh\s*\.\s*-\s*Pr\s*\.", re.IGNORECASE)

NOISE_PATTERNS = [
    r"(?i)Übertrag:.*",
    r"(?i)Ü\s*bertrag:.*",
    r"(?i)Druckdatum:.*",
    r"(?i)Seite:\s*\d+.*",
    r"(?i)S\s*umme\s+LV.*",
    r"(?i)OZ\s+L\s*eistungsbeschreibung.*",
    r"(?i)i\s*n\s+EUR\s+in\s+EUR.*",
    r"(?i)Z\s*uzüglich der gesetzlichen Mehrwertsteuer.*",
    r"(?i)i\s*n\s+Höhe von.*",
    r"(?i)\(O\s*rt\)\s*\(.*Datum\).*",
    r"(?i)Das LV besteht aus den Seiten.*",
    r"(?m)^\s*[\.\s]{3,}\s*EUR.*",
]


def extract_clean_text(pdf_path: str, top_margin: int = 145, bottom_margin: int = 810) -> str:
    """
    Extracts text from all pages while cropping out repeating headers and footers.
    Adjust top_margin and bottom_margin (in PDF points) if your template differs.
    """
    pages_text = []
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            # Crop box: (x0, top, x1, bottom) - using 145/810 to keep positions clean
            bbox = (0, top_margin, page.width, min(bottom_margin, page.height))
            cropped = page.crop(bbox)
            text = cropped.extract_text(layout=False) or ""
            pages_text.append(text)

    full_text = "\n".join(pages_text)

    # Remove repeating table noise like "Übertrag:" and header/footer debris
    for pattern in NOISE_PATTERNS:
        full_text = re.sub(pattern, "", full_text)

    return full_text


def parse_german_float(num_str: str) -> float:
    """Converts '3.300,000' or '9 4,000' -> 3300.0 / 94.0"""
    cleaned = re.sub(r"\s+", "", num_str)
    return float(cleaned.replace(".", "").replace(",", "."))


def parse_lv_positions(full_text: str) -> pd.DataFrame:
    """Splits continuous LV text into structured rows per OZ."""
    matches = list(OZ_PATTERN.finditer(full_text))
    records = []

    for i, match in enumerate(matches):
        oz_raw = match.group(1)
        oz = re.sub(r"\s+", "", oz_raw)
        start = match.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(full_text)
        block = full_text[start:end].strip()

        # Detect position type flags
        pos_type = "Normalposition"
        if "Wahlposition" in block:
            pos_type = "Wahlposition"
        elif "Bedarfsposition" in block:
            pos_type = "Bedarfsposition"
        elif "Grundposition" in block:
            pos_type = "Grundposition"

        only_unit_price = bool(NUR_EINH_PR_PATTERN.search(block))

        # Extract Quantity and Unit (ME)
        qty_match = QTY_UNIT_PATTERN.search(block)
        quantity = parse_german_float(qty_match.group(1)) if qty_match else None
        unit = qty_match.group(2) if qty_match else None

        # Clean up lines to separate Short Text (title) from Long Text (description)
        lines = [line.strip() for line in block.splitlines() if line.strip()]
        title_idx = 1 if lines and ("position" in lines[0].lower()) else 0
        short_text = lines[title_idx] if len(lines) > title_idx else ""
        long_text = "\n".join(lines[title_idx + 1 :]).strip()

        records.append({
            "oz": oz,
            "position_type": pos_type,
            "short_text": short_text,
            "long_text": long_text,
            "quantity": quantity,
            "unit": unit,
            "only_unit_price": only_unit_price,
        })

    return pd.DataFrame(records)


if __name__ == "__main__":
    pdf_path = sys.argv[1] if len(sys.argv) > 1 else "LV_14a_Betonkernaktivierung.pdf"
    if not os.path.exists(pdf_path):
        candidates = [
            os.path.join("..", "Data", pdf_path),
            os.path.join("Data", pdf_path),
            os.path.join(os.path.dirname(__file__), "..", "Data", pdf_path),
        ]
        for candidate in candidates:
            if os.path.exists(candidate):
                pdf_path = candidate
                break

    print(f"Processing PDF: {pdf_path}")
    raw_text = extract_clean_text(pdf_path)
    df = parse_lv_positions(raw_text)

    # Export to structured formats
    df.to_csv("lv_structured.csv", index=False, encoding="utf-8-sig")
    df.to_json("lv_structured.json", orient="records", force_ascii=False, indent=2)
    print(f"Extracted {len(df)} positions:")
    print(df[["oz", "position_type", "short_text", "quantity", "unit", "only_unit_price"]].head(10))
