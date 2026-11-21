"""side-by-side PNGs: original page (left) vs exported page (right). python tests/export-compare.py"""
import pymupdf, os, sys
R = os.path.dirname(os.path.abspath(__file__))
F = os.path.join(R, '..', '..', 'data', 'tenders')
S = os.path.join(R, 'export-shots')
PAIRS = [
    ('A', 'LV_03_Malerarbeiten.pdf', 'A-lv-03-malerarbeiten-pdf.pdf', 2),
    ('A3', 'LV_03_Malerarbeiten.pdf', 'A-lv-03-malerarbeiten-pdf.pdf', 6),
    ('C', 'Angebot AN24-0305.pdf', 'C-angebot-an24-0305-d84.pdf', 2),
    ('CL', 'Angebot AN24-0305.pdf', 'C-angebot-an24-0305-d84.pdf', -1),
    ('C1', 'Angebot AN24-0305.pdf', 'C-angebot-an24-0305-d84.pdf', 1),
    ('D', 'LV-Ausdruck-[PROJEKT_004].pdf', 'D-gaeb-projekt-004-x83.pdf', 6),
    ('B', 'Leistungsverzeichnis.pdf', 'B-8209-003-leistungsverzeichnis-leer-x83.pdf', 2),
    ('E', 'Leistungsverzeichnis_leer.pdf', 'E-nummer-001-leer-x83.pdf', 4),
]
sel = sys.argv[1:] 
for tag, o, e, pn in PAIRS:
    if sel and tag not in sel: continue
    a = pymupdf.open(os.path.join(F, o)); b = pymupdf.open(os.path.join(S, e))
    pa = a[pn-1 if pn>0 else len(a)+pn]; pb = b[min(pn-1, len(b)-1) if pn>0 else len(b)+pn]
    m = pymupdf.Matrix(1.3, 1.3)
    ia = pa.get_pixmap(matrix=m); ib = pb.get_pixmap(matrix=m)
    out = pymupdf.Pixmap(ia.colorspace, pymupdf.IRect(0, 0, ia.width + ib.width + 10, max(ia.height, ib.height)), False)
    out.clear_with(200)
    ia.set_origin(0, 0); ib.set_origin(ia.width + 10, 0)
    out.copy(ia, ia.irect); out.copy(ib, ib.irect)
    out.save(os.path.join(S, f'cmp-{tag}.png'))
    print('saved', tag)
