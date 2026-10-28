from pathlib import Path
from PIL import Image, ImageDraw

items = [
    ('01 accepted baseline', 'qwen-white-back-baseline.png'),
    ('02 auto workflow', 'qwen-pink-back-auto.png'),
    ('02 controlled Qwen only', 'qwen-pink-back-no-hd.png'),
]
width, height, heading = 420, 900, 46
sheet = Image.new('RGB', (width * len(items), height + heading), 'white')
draw = ImageDraw.Draw(sheet)
for index, (label, filename) in enumerate(items):
    with Image.open(filename) as source:
        image = source.convert('RGB')
        print(label, image.size)
        w, h = image.size
        crop = image.crop((round(w * 0.20), round(h * 0.36), round(w * 0.80), round(h * 0.92)))
        crop.thumbnail((width, height), Image.Resampling.LANCZOS)
        x = index * width + (width - crop.width) // 2
        sheet.paste(crop, (x, heading))
    draw.text((index * width + 14, 16), label, fill='black')
sheet.save('qwen-leg-control-comparison.jpg', quality=94, optimize=True)
print(Path('qwen-leg-control-comparison.jpg').stat().st_size)
