import argparse
from pathlib import Path

from PIL import Image

parser = argparse.ArgumentParser(description="生成写实参考图的预览 JPEG")
parser.add_argument("source", type=Path, help="原始参考图路径")
parser.add_argument("target", type=Path, nargs="?", help="可选预览图输出路径")
args = parser.parse_args()
target = args.target or args.source.with_name(f"{args.source.stem}-preview.jpg")
with Image.open(args.source) as image:
    image = image.convert("RGB")
    image.thumbnail((1800, 1800), Image.Resampling.LANCZOS)
    image.save(target, "JPEG", quality=90, optimize=True)
print(f"{target}: {target.stat().st_size} bytes")
