from pathlib import Path
import sys
from PIL import Image

source = Path(sys.argv[1])
target = source.with_name(f"{source.stem}_preview.jpg")
with Image.open(source) as image:
    image = image.convert("RGB")
    image.thumbnail((1400, 2000), Image.Resampling.LANCZOS)
    image.save(target, quality=91, optimize=True)
print(target, target.stat().st_size)
