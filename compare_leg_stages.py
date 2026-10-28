from pathlib import Path
from PIL import Image, ImageDraw

w, h = 500, 900
canvas = Image.new('RGB', (w * 3, (h + 40) * 2), 'white')
draw = ImageDraw.Draw(canvas)
for row, (panel, mother_box, single_path, hd_path) in enumerate([
    ('正面全身', (1087, 1720, 2160, 3840), 'leg-single-front.png', 'leg-hd-front.png'),
    ('背面全身', (0, 1900, 1074, 3840), 'leg-single-back.png', 'leg-hd-back.png'),
]):
    with Image.open('diagnose-mother.png') as source:
        mother = source.convert('RGB').crop(mother_box)
    with Image.open(single_path) as source:
        single = source.convert('RGB')
    with Image.open(hd_path) as source:
        hd = source.convert('RGB')
    for column, (label, image) in enumerate([('母图', mother), ('千问单图', single), ('SeedVR2高清', hd)]):
        y = row * (h + 40)
        canvas.paste(image.resize((w, h), Image.Resampling.LANCZOS), (column * w, y + 40))
        draw.text((column * w + 12, y + 12), f'{panel} · {label}', fill='black')
canvas.save('leg-stage-comparison.jpg', quality=93, optimize=True)
print(Path('leg-stage-comparison.jpg').stat().st_size)
