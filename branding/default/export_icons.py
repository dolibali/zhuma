#!/usr/bin/env python3
"""Export the approved art with ONLY its exterior background made transparent.

The original PNG is immutable. RGB pixels, Z shape, colors and framing are not
redrawn or retouched. The alpha mask follows the existing luminous perimeter;
the interior dark tile remains opaque. --check verifies committed derivatives.
Maintainer-only export requires Pillow; ordinary builds use committed assets.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageFont
import argparse
import hashlib
import json
import math

ROOT = Path(__file__).resolve().parent
APPROVED_SHA256 = 'e0fd8cc6d4706ad60af35d6ea12415f36582fdd8cae92e0a20d390538475bf00'
SIZES = (16, 24, 32, 34, 48, 64, 68, 72, 96, 102, 128, 256, 512, 1024)
RECIPE = 'approved-perimeter-alpha-v1'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def transparent_master(original):
    """Derive exterior alpha from this fixed artwork, never from its dark interior."""
    width, height = original.size
    px = original.load()
    cx, cy = 625.5, 610.0
    count = 1440
    radii = []
    for step in range(count):
        theta = step * math.tau / count
        ct, st = math.cos(theta), math.sin(theta)
        rs, samples = [], []
        # This outside-only band excludes the ribbon. Not a global black-key filter.
        for half_pixel in range(990, 1440):
            radius = half_pixel / 2
            x, y = round(cx + radius * ct), round(cy + radius * st)
            if 0 <= x < width and 0 <= y < height:
                _, green, blue, _ = px[x, y]
                rs.append(radius)
                samples.append(.3 * green + .7 * blue)
        smoothed = [sum(samples[max(0, i-3):min(len(samples), i+4)]) / 7
                    for i in range(len(samples))]
        edge = max(range(3, len(samples)-3), key=lambda i: smoothed[i]-smoothed[i+3])
        radii.append(rs[edge] - 1.0)
    # Smooth sub-degree sampling steps; keep the original asymmetrical rounded shape.
    smooth = [sum(radii[(i+j) % count] for j in range(-4, 5))/9 for i in range(count)]
    assert 510 <= min(smooth) < max(smooth) < 650, 'Unrecognized outline; refuse to alter the art'
    mask = Image.new('L', (width*2, height*2), 0)
    points = [(2*(cx+r*math.cos(i*math.tau/count)), 2*(cy+r*math.sin(i*math.tau/count)))
              for i, r in enumerate(smooth)]
    ImageDraw.Draw(mask).polygon(points, fill=255)
    mask = mask.resize(original.size, Image.Resampling.LANCZOS).filter(ImageFilter.GaussianBlur(.55))
    result = original.copy()
    result.putalpha(mask)
    assert result.convert('RGB').tobytes() == original.convert('RGB').tobytes(), 'RGB artwork changed'
    assert result.getpixel((626, 610))[3] == 255, 'Do not remove the dark interior'
    assert mask.getextrema() == (0, 255)
    return result


def check_alpha(image):
    alpha = image.getchannel('A')
    w, h = image.size
    assert alpha.getextrema() == (0, 255), 'Transparency was flattened'
    for point in ((0, 0), (w-1, 0), (0, h-1), (w-1, h-1)):
        assert alpha.getpixel(point) == 0, 'Outside corners must be transparent'
    assert alpha.getpixel((w//2, h//2)) == 255, 'The inner tile must remain opaque'


def export(check=False):
    source = ROOT / 'icon-source.png'
    assert sha(source) == APPROVED_SHA256, 'Not the approved original PNG'
    original = Image.open(source)
    original.load()
    assert original.size == (1254, 1254) and original.mode == 'RGBA'
    master = transparent_master(original)
    master_path = ROOT / 'icon-transparent.png'
    if check:
        assert Image.open(master_path).tobytes() == master.tobytes(), 'Alpha master differs from recipe'
    else:
        master.save(master_path, format='PNG', optimize=True)
    icons = ROOT / 'icons'
    icons.mkdir(exist_ok=True)
    outputs = []
    for size in SIZES:
        # Pillow's RGBA resampling respects alpha; transparent exterior is not a matte.
        image = master.resize((size, size), Image.Resampling.LANCZOS)
        # Lanczos can leave 1-5/255 alpha at the remote canvas rim in tiny sizes.
        # The original tile is inset there, so make only that empty outer row transparent.
        alpha = image.getchannel('A')
        ImageDraw.Draw(alpha).rectangle((0, 0, size-1, size-1), outline=0)
        image.putalpha(alpha)
        check_alpha(image)
        target = icons / f'icon-{size}.png'
        if check:
            assert Image.open(target).tobytes() == image.tobytes(), f'Unexpected derivative: {target.name}'
        else:
            image.save(target, format='PNG', optimize=True)
        outputs.append({'path': str(target.relative_to(ROOT)), 'width': size, 'height': size,
                        'sha256': sha(target)})
    if check:
        assert (ROOT / 'icon.png').read_bytes() == (icons / 'icon-1024.png').read_bytes()
        print('PASS: approved original unchanged; derivative RGB unchanged; all sizes preserve exterior alpha.')
        return
    (ROOT / 'icon.png').write_bytes((icons / 'icon-1024.png').read_bytes())
    card = Image.new('RGBA', (1280, 640), (5, 14, 32, 255))
    card.alpha_composite(master.resize((370, 370), Image.Resampling.LANCZOS), (112, 135))
    font = Path('/System/Library/Fonts/Supplemental/Arial.ttf')
    if not font.exists():
        raise RuntimeError('Share-card font unavailable; do not silently replace existing typography')
    draw = ImageDraw.Draw(card)
    draw.text((555, 225), 'Zhuma', font=ImageFont.truetype(str(font), 110), fill=(244, 250, 255))
    draw.text((565, 372), 'AI Development Workbench', font=ImageFont.truetype(str(font), 38), fill=(127, 203, 226))
    card.save(ROOT / 'social-preview.png', format='PNG', optimize=True)
    manifest = {
        'schemaVersion': 2,
        'source': {'path': 'icon-source.png', 'sha256': APPROVED_SHA256, 'width': 1254, 'height': 1254, 'mode': 'RGBA'},
        'master': {'path': 'icon-transparent.png', 'sha256': sha(master_path), 'width': 1254, 'height': 1254,
                   'mode': 'RGBA', 'recipe': RECIPE, 'rgbUnchanged': True, 'alphaRange': [0, 255]},
        'transform': 'Only remove exterior matte using the existing neon tile perimeter, then Lanczos resize. No redraw, recolor, crop, new texture, or opaque flattening.',
        'outputs': outputs,
    }
    (ROOT / 'icon-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    print('Immutable source:', APPROVED_SHA256)
    print('Transparent derivative:', sha(master_path))
    print('Exported', len(outputs), 'sizes; alpha outside the tile is zero, RGB inside is unchanged.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    export(parser.parse_args().check)
