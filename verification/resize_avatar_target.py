from pathlib import Path
from PIL import Image

source = Path(__file__).with_name('user-avatar-target.png')
target = Path(__file__).with_name('user-avatar-target-preview.jpg')
with Image.open(source) as image:
    image = image.convert('RGB')
    image.thumbnail((1400, 1400), Image.Resampling.LANCZOS)
    image.save(target, quality=88, optimize=True)
print(f'{target.name}: {target.stat().st_size} bytes, {image.width}x{image.height}')
