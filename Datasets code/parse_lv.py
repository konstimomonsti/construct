import re
import pdfplumber
import pandas as pd

# Regex patterns tailored to this LV format
OZ_PATTERN = re.compile(r"(?m)^(\.\d+)\s+")
QTY_UNIT_PATTERN = re.compile(
    r"(\d{1,3}(?:\.\d{3})*,\d{3})\s+(m²|m|St|Set|Psch|psch|Satz|h)\b"
)
NOISE_PATTERNS = [
    r"Übertrag:.*",
    r"Druckdatum:.*",
    r"Seite:\s*\d+",
    r"Summe LV.*",
]


def extract_clean_text(pdf_path: str, top_margin: int = 120, bottom_margin: int = 750) -> str:
    """
    Extracts text from all pages while cropping out repeating headers and footers.
    Adjust top_margin and bottom_margin (in PDF points) if your template differs.
    """
    pages_text = []
    with pdfplumber.open(pdf_path) as pdf:
        # Skip the final summary/signature page if needed, or parse all pages
        for page in pdf.pages:
            # Crop box: (x0, top, x1, bottom)
            bbox = (0, top_margin, page.width, min(bottom_margin, page.height))
            cropped = page.crop(bbox)
            text = cropped.extract_text(layout=False) or ""
            pages_text.append(text)

    full_text = "\n".join(pages_text)

    # Remove repeating table noise like "Übertrag:"
    for pattern in NOISE_PATTERNS:
        full_text = re.sub(pattern, "", full_text)

    return full_text


def parse_german_float(num_str: str) -> float:
    """Converts '3.300,000' -> 3300.0"""
    return float(num_str.replace(".", "").replace(",", "."))


def parse_lv_positions(full_text: str) -> pd.DataFrame:
    """Splits continuous LV text into structured rows per OZ."""
    # Find all OZ markers (e.g., .2, .3, ... .36)
    matches = list(OZ_PATTERN.finditer(full_text))
    records = []

    for i, match in enumerate(matches):
        oz = match.group(1)
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

        only_unit_price = "Nur Einh.-Pr." in block

        # Extract Quantity and Unit (ME)
        qty_match = QTY_UNIT_PATTERN.search(block)
        quantity = parse_german_float(qty_match.group(1)) if qty_match else None
        unit = qty_match.group(2) if qty_match else None

        # Clean up lines to separate Short Text (title) from Long Text (description)
        lines = [line.strip() for line in block.splitlines() if line.strip()]
        # Skip flag lines like "*** Bedarfsposition ohne GB" for the title
        title_idx = 1 if lines and ("position" in lines[0].lower()) else 0
        short_text = lines[title_idx] if len(lines) > title_idx else ""
        long_text = "\n".join(lines[title_idx + 1 :])

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
    raw_text = extract_clean_text("LV_14a_Betonkernaktivierung.pdf")
    df = parse_lv_positions(raw_text)

    # Export to structured formats
    df.to_csv("lv_structured.csv", index=False, encoding="utf-8-sig")
    df.to_json("lv_structured.json", orient="records", force_ascii=False, indent=2)
    print(df[["oz", "position_type", "short_text", "quantity", "unit"]].head(10))
