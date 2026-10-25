"""Draws the app icon: build/icon.png (512px) and build/icon.ico (16-256px). Requires Pillow."""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "build"
S = 1024  # draw large, downscale for smooth edges


def draw() -> Image.Image:
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((32, 32, S - 32, S - 32), radius=200, fill=(30, 30, 30, 255))
    d.rounded_rectangle((32, 32, S - 32, S - 32), radius=200, outline=(55, 148, 255, 255), width=28)

    # Two document panes, like the diff view.
    left = (170, 220, 490, 804)
    right = (534, 220, 854, 804)
    for box in (left, right):
        d.rounded_rectangle(box, radius=40, fill=(45, 45, 48, 255), outline=(110, 110, 120, 255), width=14)

    # Code lines: removed (red) on the left, added (green) on the right.
    for i, y in enumerate(range(300, 760, 90)):
        lx0, rx0 = left[0] + 50, right[0] + 50
        width = [200, 150, 220, 120, 180, 160][i % 6]
        if i == 2:
            d.rounded_rectangle((left[0] + 20, y - 26, left[2] - 20, y + 26), radius=12, fill=(248, 81, 73, 110))
            d.rounded_rectangle((right[0] + 20, y - 26, right[2] - 20, y + 26), radius=12, fill=(63, 185, 80, 110))
        d.rounded_rectangle((lx0, y - 14, lx0 + width, y + 14), radius=14, fill=(212, 212, 212, 255))
        d.rounded_rectangle((rx0, y - 14, rx0 + width, y + 14), radius=14, fill=(212, 212, 212, 255))
    return img


def main() -> None:
    OUT.mkdir(exist_ok=True)
    img = draw()
    img.resize((512, 512), Image.LANCZOS).save(OUT / "icon.png")
    img.resize((256, 256), Image.LANCZOS).save(
        OUT / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    )
    print("wrote", OUT / "icon.png", OUT / "icon.ico")


if __name__ == "__main__":
    main()
