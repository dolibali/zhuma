#!/usr/bin/env python3
"""Export sizes from the approved PNG. Never draw, crop, recolor, or mask the mark.

Maintainer-only regeneration requires Pillow. Normal builds use committed PNGs.
The original bytes are preserved in icon-source.png and verified before export.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import hashlib
import json

ROOT = Path(__file__).resolve().parent
APPROVED_SHA256 = 'e0fd8cc6d4706ad60af35d6ea12415f36582fdd8cae92e0a20d390538475bf00'
SIZES = (16, 24, 32, 34, 48, 64, 68, 72, 96, 102, 128, 256, 512, 1024)
source = ROOT / 'icon-source.png'
assert hashlib.sha256(source.read_bytes()).hexdigest() == APPROVED_SHA256, 'Not the approved original PNG'
original = Image.open(source)
original.load()
assert original.size == (1254, 1254) and original.mode == 'RGBA'
icons = ROOT / 'icons'
icons.mkdir(exist_ok=True)
outputs = []
for size in SIZES:
    image = original.resize((size, size), Image.Resampling.LANCZOS)
    target = icons / f'icon-{size}.png'
    image.save(target, format='PNG', optimize=True)
    outputs.append({'path': str(target.relative_to(ROOT)), 'width': size, 'height': size,
                    'sha256': hashlib.sha256(target.read_bytes()).hexdigest()})
# README and macOS high-resolution input use the same exported file, not JPEG.
(ROOT / 'icon.png').write_bytes((icons / 'icon-1024.png').read_bytes())
# Keep the existing share-card layout; the logo is ONLY a resize of this original.
card = Image.new('RGBA', (1280, 640), (5, 14, 32, 255))
card.alpha_composite(original.resize((370, 370), Image.Resampling.LANCZOS), (112, 135))
draw = ImageDraw.Draw(card)
font = '/System/Library/Fonts/Supplemental/Arial.ttf'
if Path(font).exists():
    draw.text((555, 225), 'Zhuma', font=ImageFont.truetype(font, 110), fill=(244, 250, 255))
    draw.text((565, 372), 'AI Development Workbench', font=ImageFont.truetype(font, 38), fill=(127, 203, 226))
else:
    raise RuntimeError('Share-card font unavailable; keep the existing card rather than silently replacing typography')
card.save(ROOT / 'social-preview.png', format='PNG', optimize=True)
manifest = {
    'schemaVersion': 1,
    'source': {'path': 'icon-source.png', 'sha256': APPROVED_SHA256, 'width': 1254, 'height': 1254, 'mode': 'RGBA'},
    'transform': 'Resize from original with Lanczos, PNG lossless encoding. No redraw, crop, tint, texture, or mask.',
    'outputs': outputs,
}
(ROOT / 'icon-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
print('Approved source unchanged:', APPROVED_SHA256)
print('Exported', len(outputs), 'PNG sizes; updated README icon and share card from original.')
