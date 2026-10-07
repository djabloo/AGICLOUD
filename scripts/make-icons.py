# Icone di AgiCloud (PWA): quadrato scuro, "A" bianca, accento azzurro. Rigenerabili con: python3 scripts/make-icons.py
from PIL import Image, ImageDraw, ImageFont
import os
OUT = 'apps/web/public'
FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'

def icon(size, maskable=False):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    radius = 0 if maskable else size // 5
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=(11, 15, 23, 255))
    # le icone "maskable" vengono ritagliate dal telefono: il disegno sta nell'80% centrale
    scale = 0.62 if maskable else 0.78
    font = ImageFont.truetype(FONT, int(size * scale * 0.82))
    text = 'A'
    box = d.textbbox((0, 0), text, font=font)
    w, h = box[2] - box[0], box[3] - box[1]
    x, y = (size - w) / 2 - box[0], (size - h) / 2 - box[1] - size * 0.03
    d.text((x, y), text, font=font, fill=(232, 236, 243, 255))
    # trattino azzurro sotto la lettera
    bw, bh = size * scale * 0.5, max(2, size * 0.045)
    by = y + box[3] + size * 0.05
    d.rounded_rectangle([(size - bw) / 2, by, (size + bw) / 2, by + bh], radius=bh / 2, fill=(92, 177, 255, 255))
    return img

os.makedirs(OUT, exist_ok=True)
icon(192).save(f'{OUT}/icon-192.png')
icon(512).save(f'{OUT}/icon-512.png')
icon(512, maskable=True).save(f'{OUT}/icon-maskable-512.png')
icon(180).convert('RGB').save(f'{OUT}/apple-touch-icon.png')
icon(32).save(f'{OUT}/favicon.png')
print('ok')
