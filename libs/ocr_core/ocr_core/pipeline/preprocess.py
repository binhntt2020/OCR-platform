from PIL import Image


def preprocess_image(img: Image.Image) -> Image.Image:
    # TODO: deskew/denoise/auto-rotate/normalize DPI if you want
    return img.convert("RGB")
