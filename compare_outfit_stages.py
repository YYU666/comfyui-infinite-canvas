from pathlib import Path
from PIL import Image, ImageDraw

with Image.open('diagnose-mother.png') as mother:
    crop = mother.convert('RGB').crop((0, 0, 1074, 1708))
with Image.open('diagnose-qwen-single.png') as image:
    single = image.convert('RGB')
with Image.open('outfit-02-front-portrait-preview.png') as image:
    hd = image.convert('RGB')

stages = [('母图 TL 裁切', crop), ('千问换装单图', single), ('SeedVR2 高清', hd)]
w, h = 500, 800
canvas = Image.new('RGB', (w * 3, h + 50), 'white')
draw = ImageDraw.Draw(canvas)
for index, (label, image) in enumerate(stages):
    print(label, image.size)
    resized = image.resize((w, h), Image.Resampling.LANCZOS)
    canvas.paste(resized, (index * w, 50))
    draw.text((index * w + 16, 16), label, fill='black')
canvas.save('outfit-stage-comparison.jpg', quality=92, optimize=True)
print(Path('outfit-stage-comparison.jpg').stat().st_size)
