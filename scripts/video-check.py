#!/usr/bin/env python3
"""Prova degli strumenti video (ffmpeg + Pillow + MoviePy) e esempio per gli agenti.

Fa un mini filmato: tre diapositive (immagini) con dissolvenze e un dialogo a due voci finto (due toni), e lo
controlla con ffprobe. Uso:  python3 scripts/video-check.py [cartella-di-uscita]
Con immagini e voci vere (per esempio quelle create da agy) basta sostituire i file in `slides` e `voices`.
"""
import json, os, subprocess, sys, tempfile
from PIL import Image, ImageDraw, ImageFont

out = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="video-check-")
os.makedirs(out, exist_ok=True)

def font(size):
    for f in ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"):
        if os.path.exists(f):
            return ImageFont.truetype(f, size)
    return ImageFont.load_default()

# 1) Tre diapositive 1280x720
slides = []
for i, (title, color) in enumerate([("Uno: l'idea", (30, 60, 120)), ("Due: il montaggio", (20, 100, 80)), ("Tre: il risultato", (120, 50, 60))], 1):
    img = Image.new("RGB", (1280, 720), color)
    d = ImageDraw.Draw(img)
    d.text((80, 300), title, font=font(90), fill=(255, 255, 255))
    p = os.path.join(out, f"slide{i}.png")
    img.save(p)
    slides.append(p)

# 2) Due "voci" (due toni diversi) di 3 secondi, una dopo l'altra: stand-in di un dialogo a due voci
voices = []
for i, freq in enumerate((220, 330), 1):
    p = os.path.join(out, f"voce{i}.wav")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", f"sine=frequency={freq}:duration=3", p], check=True)
    voices.append(p)

# 3) Montaggio con MoviePy: immagini di 2 s con dissolvenza, audio delle due voci in sequenza
from moviepy import AudioFileClip, ImageClip, concatenate_audioclips, concatenate_videoclips, vfx

clips = [ImageClip(p).with_duration(2.0).with_effects([vfx.FadeIn(0.5), vfx.FadeOut(0.5)]) for p in slides]
video = concatenate_videoclips(clips)
audio = concatenate_audioclips([AudioFileClip(v) for v in voices])
final = video.with_audio(audio.with_duration(video.duration))
target = os.path.join(out, "prova.mp4")
# MoviePy scrive un file audio temporaneo nella cartella corrente: lo si indirizza in una cartella sicura (utile dove la cartella corrente e' in sola lettura)
final.write_videofile(target, fps=24, codec="libx264", audio_codec="aac", temp_audiofile_path=out, logger=None)

# 4) Controllo con ffprobe
info = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height:format=duration", "-of", "json", target]))
streams = {s["codec_type"]: s for s in info["streams"]}
assert streams["video"]["width"] == 1280 and streams["video"]["height"] == 720, "video"
assert "audio" in streams, "audio"
dur = float(info["format"]["duration"])
assert 5.5 < dur < 6.5, f"durata {dur}"
print(f"OK: {target} ({dur:.1f} s, {streams['video']['codec_name']} + {streams['audio']['codec_name']})")
