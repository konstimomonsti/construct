#!/usr/bin/env python
"""
Extracts the *visible* layout of the source PDFs (PyMuPDF) for the PDF exporter:

  public/data/layout/<listId>.json
    {
      "furniture": { "size": [w, h], "items": [ {x, y, t, f, s, b?, i?, c?} ... ] },   # header/footer spans of page 2
      "positions": { "<oz>": { "short": [str], "lines": [ {t, b?, i?, x?, segs?} ] } }  # styled long-text lines
    }

* lines keep the ORIGINAL line breaks, bold/italic flags and indentation (x = pt relative to the text column)
* blank lines (paragraph gaps) are {t: ""}
* a position only gets `lines` when they reproduce Position.long exactly (whitespace-insensitive),
  otherwise the exporter falls back to the plain text of the position.

Run:  python scripts/pdf-layout.py
"""
import glob
import json
import os
import re
import statistics
import sys

import pymupdf

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LISTS = os.path.join(ROOT, 'public', 'data', 'lists')
FILES = os.path.join(ROOT, 'public', 'files')
OUT = os.path.join(ROOT, 'public', 'data', 'layout')

HEADER_END = 152.0  # template A: everything above is page furniture
FOOTER_START = 800.0
TEXT_X = 124.8  # text column of template A
OZ_RE = re.compile(r'^\.?\d+(?:\.\d+)*\.?$')
QTY_RE = re.compile(r'^[\d.]*\d,\d+\s+\S+')


def norm(s):
    return re.sub(r'\s+', '', s or '')


def style_of(span):
    fl = span['flags']
    return bool(fl & 16), bool(fl & 2)


def page_lines(page):
    """merge all visible spans of a page into baseline lines"""
    spans = []
    for b in page.get_text('dict')['blocks']:
        for l in b.get('lines', []):
            for s in l['spans']:
                if not s['text'].strip():
                    continue
                spans.append(s)
    spans.sort(key=lambda s: (round(s['origin'][1], 1), s['origin'][0]))
    lines = []
    for s in spans:
        y = s['origin'][1]
        if lines and abs(lines[-1]['y'] - y) < 1.3:
            lines[-1]['spans'].append(s)
        else:
            lines.append({'y': y, 'spans': [s]})
    for ln in lines:
        ln['spans'].sort(key=lambda s: s['origin'][0])
    return lines


def line_text(spans):
    out = ''
    px = None
    for s in spans:
        t = s['text'].strip()
        if px is not None and s['origin'][0] - px > 1.2:
            out += ' '
        out += t
        px = s['bbox'][2]
    return out


def dominant_style(spans):
    best = max(spans, key=lambda s: len(s['text'].strip()))
    return style_of(best)


def seg_split(spans):
    """split into segments at big horizontal gaps (value columns inside long texts)"""
    segs = []
    cur = [spans[0]]
    for s in spans[1:]:
        if s['origin'][0] - cur[-1]['bbox'][2] > 25:
            segs.append(cur)
            cur = [s]
        else:
            cur.append(s)
    segs.append(cur)
    return segs


def furniture(doc):
    page = doc[1] if len(doc) > 1 else doc[0]
    items = []
    for b in page.get_text('dict')['blocks']:
        for l in b.get('lines', []):
            for s in l['spans']:
                t = s['text'].strip()
                y = s['origin'][1]
                if not t or not (y < HEADER_END or y > FOOTER_START):
                    continue
                bold, ital = style_of(s)
                it = {'x': round(s['origin'][0], 1), 'y': round(y, 1), 't': t, 'f': 'courier' if 'ourier' in s['font'] else 'sans', 's': round(s['size'], 1)}
                if bold:
                    it['b'] = 1
                if ital:
                    it['i'] = 1
                if s['color']:
                    it['c'] = '%06x' % s['color']
                items.append(it)
    # page number / date tokens
    for it in items:
        it['t'] = re.sub(r'(Seite:?\s*)(\d+)(\s+von\s+)(\d+)', r'\1{page}\3{pages}', it['t'])
        it['t'] = re.sub(r'^(Seite:?\s*)(\d+)$', r'\1{page}', it['t'])
        it['t'] = re.sub(r'^(Druckdatum:\s*)(\S+)$', r'\1{date}', it['t'])
    return {'size': [round(page.rect.width, 1), round(page.rect.height, 1)], 'items': items}


def extract(doc, item_ozs, positions):
    """one block per OZ heading: styled lines with exact baseline gaps (g) so the exporter can reproduce the vertical rhythm"""
    blocks = []
    cur = None
    pitches = []
    for pno, page in enumerate(doc):
        prev_y = None
        for ln in page_lines(page):
            y = ln['y']
            spans = ln['spans']
            if y < HEADER_END or y > FOOTER_START:
                continue
            x0 = spans[0]['origin'][0]
            text = line_text(spans)
            if 'Übertrag' in text and x0 > 380:
                prev_y = y if prev_y is None else prev_y
                continue
            first = spans[0]
            bold, _ = style_of(first)
            if first['text'].strip() == 'Summe' or text.startswith('Zuzüglich der gesetzlichen') or text.startswith('Das LV besteht'):
                cur = None
                continue
            # quantity / price row of the position (right hand columns only)
            if cur is not None and x0 >= 300 and (QTY_RE.match(text) or re.fullmatch(r'[.\s]+', text)):
                if cur['kind'] == 'i' and 'qg' not in cur and cur['page'] == pno:
                    cur['qg'] = round(y - (cur['ylast']), 1)
                    cur['qy'] = y
                    cur['ylast'] = y
                prev_y = y
                continue
            if x0 < 70 and OZ_RE.match(first['text'].strip()) and first['size'] < 9.5 and bold:
                tok = first['text'].strip()
                oz = tok.strip('.')
                kind = 'i' if oz in item_ozs else 'c'
                cur = {'oz': oz, 'tok': tok, 'kind': kind, 'page': pno, 'y0': y, 'ylast': y, 'lines': []}
                rest = [s for s in spans[1:] if s['origin'][0] >= 100]
                if rest:
                    b, i = dominant_style(rest)
                    e = {'t': line_text(rest), 's': 1}
                    if b:
                        e['b'] = 1
                    cur['lines'].append(e)
                blocks.append(cur)
                prev_y = y
                continue
            if cur is None:
                prev_y = y
                continue
            size = max(s['size'] for s in spans)
            g = None
            if prev_y is not None and cur['lines'] and y - prev_y > 0:
                g = round(y - prev_y, 1)
                if y - prev_y < 20:
                    pitches.append(y - prev_y)
            elif prev_y is not None and not cur['lines']:
                g = round(y - prev_y, 1)
            prev_y = y
            cur['ylast'] = y
            b, i = dominant_style(spans)
            segs = seg_split(spans)
            entry = {'t': line_text(spans) if len(segs) == 1 else '   '.join(line_text(g2) for g2 in segs)}
            if cur['kind'] == 'i' and b and all(l.get('s') for l in cur['lines']) and cur['lines'] and g is not None and g < 14:
                entry['s'] = 1
            if b:
                entry['b'] = 1
            if i:
                entry['i'] = 1
            off = round(x0 - TEXT_X, 1)
            if abs(off) > 1.0:
                entry['x'] = off
            if g is not None and abs(g - 1.14 * size) > 0.3:
                entry['g'] = g
            if len(segs) > 1:
                entry['segs'] = [{'t': line_text(g2), 'x': round(g2[0]['origin'][0] - TEXT_X, 1)} for g2 in segs]
            cur['lines'].append(entry)
    # gap from the last element of a block to the next OZ line (same page only)
    for k, bl in enumerate(blocks):
        if k + 1 < len(blocks) and blocks[k + 1]['page'] == bl['page']:
            bl['eg'] = round(blocks[k + 1]['y0'] - bl['ylast'], 1)
    out = {}
    stats = {'items': 0, 'long_ok': 0, 'short_ok': 0}
    for bl in blocks:
        p = positions.get(bl['oz'])
        e = {'lines': bl['lines']}
        if bl['tok'] != bl['oz'] + '.':
            e['tok'] = bl['tok']
        if bl['kind'] == 'c':
            e['k'] = 'c'
        if 'qg' in bl:
            e['qg'] = bl['qg']
        if 'eg' in bl:
            e['eg'] = bl['eg']
        if bl['kind'] == 'i' and p:
            stats['items'] += 1
            short = ''.join(l['t'] for l in bl['lines'] if l.get('s'))
            body = ''.join(l['t'] for l in bl['lines'] if not l.get('s'))
            if norm(short) == norm(p.get('short')):
                stats['short_ok'] += 1
                e['ok'] = 1
                if norm(body) == norm(p.get('long')):
                    stats['long_ok'] += 1
                    e['ok'] = 2
        if bl['oz'] not in out:
            out[bl['oz']] = e
    return out, stats, (statistics.median(pitches) if pitches else 0)


def main():
    os.makedirs(OUT, exist_ok=True)
    total = {'items': 0, 'long_ok': 0, 'short_ok': 0}
    for f in sorted(glob.glob(os.path.join(LISTS, '*.json'))):
        d = json.load(open(f, encoding='utf8'))
        fn = d.get('fileName', '')
        if not fn.lower().endswith('.pdf'):
            continue
        src = os.path.join(FILES, fn)
        if not os.path.exists(src):
            print('missing', src)
            continue
        doc = pymupdf.open(src)
        positions = {p['oz']: p for p in d['positions']}
        item_ozs = set(positions)
        pos, stats, pitch = extract(doc, item_ozs, positions)
        layout = {'furniture': furniture(doc), 'positions': pos}
        with open(os.path.join(OUT, d['id'] + '.json'), 'w', encoding='utf8') as fh:
            json.dump(layout, fh, ensure_ascii=False, separators=(',', ':'))
        print('%-52s items %3d  long-ok %3d  short-ok %3d  pitch %.2f' % (d['id'], stats['items'], stats['long_ok'], stats['short_ok'], pitch))
        for k in total:
            total[k] += stats[k]
    print('TOTAL', total, 'of', 'positions')


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf8')
    main()
