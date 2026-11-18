# 方形原图转 macOS 应用图标：1024 画布，内容 824 圆角矩形（22.5% 圆角），四周透明留白和轻阴影
import subprocess, sys, tempfile
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

src, out = Path(sys.argv[1]), Path(sys.argv[2])
size, body, radius, scale = 1024, 824, 185, 4
art = Image.open(src).convert('RGBA').resize((body, body), Image.LANCZOS)
mask = Image.new('L', (body * scale, body * scale), 0)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, body * scale - 1, body * scale - 1), radius * scale, fill=255)
mask = mask.resize((body, body), Image.LANCZOS)
art.putalpha(mask)
offset = (size - body) // 2
shadow = Image.new('RGBA', (size, size), (0, 0, 0, 0))
shadow.paste((0, 0, 0, 70), (offset, offset + 10), mask)
canvas = shadow.filter(ImageFilter.GaussianBlur(12))
canvas.alpha_composite(art, (offset, offset))
out.mkdir(parents=True, exist_ok=True)
canvas.save(out / 'icon-1024.png')
canvas.resize((512, 512), Image.LANCZOS).save(out / 'icon.png')
for name, px in [('32x32.png', 32), ('64x64.png', 64), ('128x128.png', 128), ('128x128@2x.png', 256)]:
    canvas.resize((px, px), Image.LANCZOS).save(out / name)
canvas.save(out / 'icon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
with tempfile.TemporaryDirectory() as tmp:
    iconset = Path(tmp) / 'icon.iconset'
    iconset.mkdir()
    for base in [16, 32, 128, 256, 512]:
        canvas.resize((base, base), Image.LANCZOS).save(iconset / f'icon_{base}x{base}.png')
        canvas.resize((base * 2, base * 2), Image.LANCZOS).save(iconset / f'icon_{base}x{base}@2x.png')
    subprocess.run(['iconutil', '-c', 'icns', str(iconset), '-o', str(out / 'icon.icns')], check=True)
print('ok')
