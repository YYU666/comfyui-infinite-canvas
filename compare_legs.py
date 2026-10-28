from pathlib import Path
from PIL import Image, ImageDraw

sources = [('母图', 'diagnose-mother.png'), ('第01套', 'compare-outfit-01.png'), ('第02套', 'outfit-02-complete-quad.png')]
w, h = 500, 900
canvas = Image.new('RGB', (w * 3, (h + 40) * 2), 'white')
draw = ImageDraw.Draw(canvas)
for column, (label, path) in enumerate(sources):
    with Image.open(path) as source:
        source = source.convert('RGB')
        panels = [('正面全身', (1087, 1720, 2160, 3840)), ('背面全身', (0, 1900, 1074, 3840))]
        for row, (panel, box) in enumerate(panels):
            crop = source.crop(box).resize((w, h), Image.Resampling.LANCZOS)
            y = row * (h + 40)
            canvas.paste(crop, (column * w, y + 40))
            draw.text((column * w + 12, y + 12), f'{label} · {panel}', fill='black')
canvas.save('leg-comparison.jpg', quality=93, optimize=True)
print(Path('leg-comparison.jpg').stat().st_size)
