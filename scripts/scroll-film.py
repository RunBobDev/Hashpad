"""Measures a kymograph from scroll-film.ps1: how the text actually moved on screen.

For each pair of consecutive distinct captures, finds the vertical shift that
best aligns them -- the on-screen movement in that frame. Reports the total
distance travelled and every frame that moved *against* the direction of
travel, which is what a person sees as a stutter.

The search window is wide on purpose. A display frame held for two vsyncs is
followed by a double step, and at ~20 px a frame that step can pass 70 px; a
narrow window mis-fits it as a large step the *other* way, which once read as a
backward jump that was never there.

    python scripts/scroll-film.py split.png [more.png ...]

Needs Pillow.
"""
import sys

from PIL import Image

WINDOW = 130


def columns(path):
    image = Image.open(path).convert('L')
    width, height = image.size
    px = image.load()
    return [[px[x, y] for y in range(height)] for x in range(width)], height


def best_shift(a, b, height):
    """Content moved up by s between the captures: b[y] matches a[y + s]."""
    best = None
    for s in range(-WINDOW, WINDOW + 1):
        y0, y1 = max(0, -s), min(height, height - s)
        if y1 - y0 < height // 2:
            continue
        error = sum(abs(b[y] - a[y + s]) for y in range(y0, y1)) / (y1 - y0)
        if best is None or error < best[1]:
            best = (s, error)
    return best


def main(paths):
    for path in paths:
        cols, height = columns(path)
        steps = [best_shift(a, b, height) for a, b in zip(cols, cols[1:]) if a != b]
        shifts = [s for s, _ in steps]
        travel = sum(shifts)
        sign = 1 if travel >= 0 else -1
        against = [s for s in shifts if s * sign < 0]
        poor = sum(1 for _, e in steps if e > 2)
        print(f'{path}: travelled {travel}px over {len(shifts)} frames; '
              f'against travel {len(against)} {against[:12]}'
              + (f'; {poor} frame(s) matched no shift -- widen WINDOW' if poor else ''))
        print('   per frame:', ' '.join(str(s) for s in shifts))


if __name__ == '__main__':
    main(sys.argv[1:])
