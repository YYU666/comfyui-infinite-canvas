from pathlib import Path
from PIL import Image

root = Path(__file__).parent
source = root / "H3_OutfitHD_bl_00004_.png"
target = root / "H3_OutfitHD_bl_00004_preview.jpg"
with Image.open(source) as image:
    image = image.convert("RGB")
    image.thumbnail((1000, 1800), Image.Resampling.LANCZOS)
    image.save(target, quality=90, optimize=True)
print(target, target.stat().st_size)
