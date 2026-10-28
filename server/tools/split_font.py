"""Split the game's embedded pixel font into two web fonts:
   fusion-pixel-12-core.woff2: ASCII, punctuation, GB2312 level-1 hanzi and every character used by our pages;
   fusion-pixel-12-ext.woff2:  everything else, which the browser fetches only if a page actually shows one of those characters.
   Run once whenever the font in index.html changes:  python3 tools/split_font.py   (needs: pip install fonttools brotli)"""
import re, base64, io, json, pathlib
from fontTools.ttLib import TTFont
from fontTools import subset

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / 'server' / 'fonts'
OUT.mkdir(exist_ok=True)
src = (ROOT / 'index.html').read_text(encoding='utf-8')
raw = base64.b64decode(re.search(r'url\(data:font/woff2;base64,([A-Za-z0-9+/=]+)\)', src).group(1))
cmap = TTFont(io.BytesIO(raw)).getBestCmap()

common = set(range(0x20, 0x7f)) | set(range(0xa0, 0x100)) | set(range(0x2000, 0x2070)) | set(range(0x2190, 0x2200)) | set(range(0x2500, 0x2600)) | set(range(0x3000, 0x3040)) | set(range(0xff00, 0xff70))
for hi in range(0xB0, 0xD8):
    for lo in range(0xA1, 0xFF):
        try: common.add(ord(bytes([hi, lo]).decode('gb2312')))
        except UnicodeDecodeError: pass
for p in ['index.html', 'server/login.html', 'server/setup.html']:
    t = re.sub(r'base64,[A-Za-z0-9+/=]+', '', (ROOT / p).read_text(encoding='utf-8'))
    common |= {ord(c) for c in t}
common &= set(cmap)
rest = set(cmap) - common

def build(cps, name):
    o = subset.Options(); o.flavor = 'woff2'; o.layout_features = ['*']; o.name_IDs = ['*']; o.notdef_outline = True; o.hinting = False
    ft = TTFont(io.BytesIO(raw)); s = subset.Subsetter(o); s.populate(unicodes=cps); s.subset(ft)
    ft.flavor = 'woff2'; bio = io.BytesIO(); ft.save(bio); (OUT / name).write_bytes(bio.getvalue())
    return len(bio.getvalue())

def ranges(cps):
    cps = sorted(cps); out = []; a = b = cps[0]
    for c in cps[1:]:
        if c == b + 1: b = c
        else: out.append((a, b)); a = b = c
    out.append((a, b))
    return ', '.join(f'U+{a:X}' if a == b else f'U+{a:X}-{b:X}' for a, b in out)

info = {'core': build(common, 'fusion-pixel-12-core.woff2'), 'ext': build(rest, 'fusion-pixel-12-ext.woff2'), 'full': len(raw), 'coreGlyphs': len(common), 'extGlyphs': len(rest)}
(OUT / 'ranges.json').write_text(json.dumps({'core': ranges(common), 'ext': ranges(rest)}))
print(info)
