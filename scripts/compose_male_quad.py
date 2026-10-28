from pathlib import Path
from PIL import Image, ImageChops

root = Path(__file__).resolve().parents[1]
verification = root / "verification"
panel_paths = [
    verification / "male-10b-short-back-hair.png",
    verification / "male-13a-side-avatar.png",
    verification / "male-13c2-back-body-single.png",
    verification / "male-13b-front-body.png",
]
panels = [Image.open(path).convert("RGB") for path in panel_paths]
sizes = [panel.size for panel in panels]
if len(set(sizes)) != 1:
    raise RuntimeError(f"Panel sizes differ; refusing to resize source pixels: {sizes}")
width, height = sizes[0]
sheet = Image.new("RGB", (width * 2, height * 2))
for panel, position in zip(panels, ((0, 0), (width, 0), (0, height), (width, height))):
    sheet.paste(panel, position)
output = verification / "male-13-model-quad-original-pixels.png"
sheet.save(output, format="PNG", compress_level=6)
sheet.save(verification / "male-13-model-quad-preview.jpg", format="JPEG", quality=88, optimize=True)
if ImageChops.difference(sheet.crop((0, 0, width, height)), panels[0]).getbbox() is not None:
    raise RuntimeError("Approved front avatar pixels changed during composition")
print(f"output={output}")
print(f"panel_size={width}x{height}")
print(f"sheet_size={sheet.width}x{sheet.height}")
print("front_avatar_original_pixels=verified")
