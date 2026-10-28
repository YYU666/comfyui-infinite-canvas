from pathlib import Path
from PIL import Image

source = Path(__file__).with_name("male-realism-01.png")
target = Path(__file__).with_name("male-realism-sheet-input-9x16.png")
with Image.open(source) as image:
    image = image.convert("RGB")
    image.thumbnail((1152, 2048), Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", (1152, 2048), (128, 128, 128))
    canvas.paste(image, ((1152 - image.width) // 2, (2048 - image.height) // 2))
    canvas.save(target)
print(target, canvas.size, target.stat().st_size)
