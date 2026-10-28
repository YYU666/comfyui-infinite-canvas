from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parent
source = root / "neowow-realism-target.png"
target = root / "neowow-realism-target-preview.jpg"
with Image.open(source) as image:
    image = image.convert("RGB")
    image.thumbnail((1800, 1800), Image.Resampling.LANCZOS)
    image.save(target, "JPEG", quality=90, optimize=True)
print(f"{target}: {target.stat().st_size} bytes")
