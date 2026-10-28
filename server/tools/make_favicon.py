"""Draw the Agent Farm favicon as 16x16 pixel art and export it.
   Outputs (server/icons/): favicon.svg (crisp at any size), favicon.ico (16/32/48), apple-touch-icon.png (180), icon-512.png.
   Run: python3 tools/make_favicon.py   (needs Pillow)"""
import pathlib, sys
from PIL import Image

PAL = {
    'O': '#20141c',  # outline
    'N': '#241c3e', 'M': '#2e2450',  # night sky, slightly lighter lower sky
    'W': '#fff6c8', 'Y': '#f2c14e',  # star
    'H': '#b4d872', 'L': '#7fb450', 'D': '#56943f', 'G': '#3b7438',  # leaves and stem
    'T': '#86583a', 'S': '#553426', 'K': '#3b241f',  # soil: top, body, furrows
}
ROWS = [
    "..OOOOOOOOOOOO..",
    ".ONNNNNNNNNNNNO.",
    "ONNNNNNNNNNNNWNO",
    "ONNNNNNNNNNNWYWO",
    "ONNHHNNNNNNNNWNO",
    "ONHLLLNNNNNHHNNO",
    "OMLLLDDNNNHLLLMO",
    "OMMDDDGGNNLLLDMO",
    "OMMMMMMGGDDDDMMO",
    "OMMMMMMGGMMMMMMO",
    "OMMMMMMGGMMMMMMO",
    "OMMMMTTGGTTMMMMO",
    "OTTTTSSSSSSTTTTO",
    "OSSKSSKSSKSSKSSO",
    ".OSSSSSSSSSSSSO.",
    "..OOOOOOOOOOOO..",
]
assert len(ROWS) == 16 and all(len(r) == 16 for r in ROWS)

def image(scale):
    im = Image.new('RGBA', (16, 16), (0, 0, 0, 0)); px = im.load()
    for y, row in enumerate(ROWS):
        for x, ch in enumerate(row):
            if ch != '.': h = PAL[ch]; px[x, y] = (int(h[1:3], 16), int(h[3:5], 16), int(h[5:7], 16), 255)
    return im.resize((16 * scale, 16 * scale), Image.NEAREST)

def svg():
    rects = []
    for y, row in enumerate(ROWS):  # merge horizontal runs of one colour into a single rect
        x = 0
        while x < 16:
            ch = row[x]; x2 = x
            while x2 < 16 and row[x2] == ch: x2 += 1
            if ch != '.': rects.append(f'<rect x="{x}" y="{y}" width="{x2 - x}" height="1" fill="{PAL[ch]}"/>')
            x = x2
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges">{"".join(rects)}</svg>\n'

out = pathlib.Path(__file__).resolve().parents[1] / 'icons'
out.mkdir(exist_ok=True)
(out / 'favicon.svg').write_text(svg())
image(3).save(out / 'favicon.ico', sizes=[(16, 16), (32, 32), (48, 48)], append_images=[image(1), image(2)])  # each size is drawn pixel-exact, not resampled
# the touch icon gets an opaque square background (iOS fills transparency with black) and a 2px margin
touch = Image.new('RGBA', (180, 180), PAL['N']); touch.alpha_composite(image(10), (10, 10)); touch.convert('RGB').save(out / 'apple-touch-icon.png')
big = Image.new('RGBA', (512, 512), PAL['N']); big.alpha_composite(image(30), (16, 16)); big.convert('RGB').save(out / 'icon-512.png')
if '--preview' in sys.argv: image(24).save(sys.argv[-1])
print('icons written to', out)
