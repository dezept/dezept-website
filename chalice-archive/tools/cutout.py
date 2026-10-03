#!/usr/bin/env python3
"""Cut a construct out of a screenshot background (only needed while the page uses screenshots).

    pip install onnxruntime pillow numpy
    curl -L -o isnet.onnx https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx
    python3 tools/cutout.py assets/screenshots/front-view.png assets/front --model isnet.onnx

Writes <out>.png (lossless RGBA) and <out>.webp (what build.py embeds), cropped to the object,
upscaled by --scale. This is how assets/front.* and assets/side.* were made (scale 2).
"""
import argparse

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageFilter

ap = argparse.ArgumentParser()
ap.add_argument("input")
ap.add_argument("out", help="output path without extension")
ap.add_argument("--model", default="isnet.onnx")
ap.add_argument("--scale", type=int, default=2)
ap.add_argument("--lo", type=float, default=0.25, help="mask values below this become transparent")
ap.add_argument("--hi", type=float, default=0.70, help="mask values above this become opaque")
args = ap.parse_args()

im = Image.open(args.input).convert("RGB")

# ISNet segmentation (same preprocessing rembg uses for isnet-general-use)
sess = ort.InferenceSession(args.model, providers=["CPUExecutionProvider"])
x = np.array(im.resize((1024, 1024), Image.LANCZOS)).astype(np.float32)
x = (x / max(float(x.max()), 1e-6) - 0.5).transpose(2, 0, 1)[None]
m = sess.run(None, {sess.get_inputs()[0].name: x})[0][0, 0]
m = (m - m.min()) / (m.max() - m.min())
mask = np.array(Image.fromarray((m * 255).astype(np.uint8)).resize(im.size, Image.LANCZOS)).astype(np.float32) / 255

# Tighten the soft mask, erode 1px to drop background fringe, feather slightly
a = np.clip((mask - args.lo) / (args.hi - args.lo), 0, 1)
alpha = Image.fromarray((a * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.6))

w, h = im.size
size = (w * args.scale, h * args.scale)
big = im.resize(size, Image.LANCZOS).filter(ImageFilter.UnsharpMask(radius=1.2, percent=60, threshold=2))
rgba = big.copy()
rgba.putalpha(alpha.resize(size, Image.LANCZOS))
rgba = rgba.crop(rgba.getbbox())
rgba.save(args.out + ".png")
rgba.save(args.out + ".webp", "WEBP", quality=88, method=6)
print("wrote", args.out + ".png", args.out + ".webp", rgba.size)
