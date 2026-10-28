from pathlib import Path
from PIL import Image

source = Path('outfit-02-complete-quad-v2.png')
target = Path('outfit-02-complete-quad-v2.jpg')
with Image.open(source) as image:
    image.thumbnail((1400, 2100), Image.Resampling.LANCZOS)
    image.convert('RGB').save(target, quality=91, optimize=True)
print(target, target.stat().st_size)
