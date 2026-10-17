// Plugin Video: montaggio video con timeline visuale (WebUI) e progetti JSON modificabili dagli agenti.
// Rendering con MoviePy/ffmpeg (come scripts/video-check.py): libx264 + aac, temp_audiofile_path in cartella sicura.
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import type { Hono } from 'hono';
import { config } from './config.js';
import { HttpError } from './errors.js';
import type { PluginSpec } from './plugins.js';

export interface VideoClip {
  id: string;
  type: 'image' | 'video' | 'title' | 'audio';
  path?: string;
  text?: string;
  color?: string;
  start: number;
  duration: number;
  fadeIn?: number;
  fadeOut?: number;
}
export interface VideoTrack {
  id: string;
  type: 'video' | 'audio';
  name: string;
  clips: VideoClip[];
}
export interface VideoProject {
  version: string;
  title: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
  tracks: VideoTrack[];
}

export function videoDir(): string {
  const base = process.env.VIDEO_PROJECTS_DIR || join(config.projectRoots[0] ?? '/tmp', 'video-projects');
  mkdirSync(base, { recursive: true });
  return base;
}

function safeName(name: string): string {
  const b = basename(name);
  if (!/^[\w\-. ]+\.video\.json$/.test(b)) throw new HttpError(400, 'Nome non valido');
  return b;
}

export function listProjects(): { name: string; title: string }[] {
  const dir = videoDir();
  return readdirSync(dir)
    .filter((f) => f.endsWith('.video.json'))
    .map((f) => {
      let title = f;
      try {
        title = String((JSON.parse(readFileSync(join(dir, f), 'utf8')) as VideoProject).title ?? f);
      } catch { /* titolo = nome file */ }
      return { name: f, title };
    });
}

export function getProject(name: string): VideoProject {
  const p = join(videoDir(), safeName(name));
  if (!existsSync(p)) throw new HttpError(404, 'Progetto video non trovato');
  return JSON.parse(readFileSync(p, 'utf8')) as VideoProject;
}

export function saveProject(name: string, project: VideoProject): void {
  if (!project || typeof project !== 'object' || !Array.isArray((project as VideoProject).tracks)) {
    throw new HttpError(400, 'Progetto video non valido');
  }
  writeFileSync(join(videoDir(), safeName(name)), JSON.stringify(project, null, 2));
}

function checkTools(): Promise<void> {
  return new Promise((resolveP, reject) => {
    execFile('ffmpeg', ['-version'], (e1) => {
      if (e1) return reject(new Error('ffmpeg non trovato sul server'));
      execFile('python3', ['-c', 'import moviepy'], (e2) => {
        if (e2) return reject(new Error('MoviePy non trovato sul server (pip install moviepy)'));
        resolveP();
      });
    });
  });
}

export const MEDIA_EXT = [
  // Immagini
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.bmp', '.tiff', '.avif',
  // Video
  '.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v', '.wmv', '.flv',
  // Audio
  '.mp3', '.wav', '.aac', '.m4a', '.ogg', '.flac', '.opus', '.wma',
];

export function isMedia(name: string): boolean {
  const n = name.toLowerCase();
  return MEDIA_EXT.some((e) => n.endsWith(e));
}

export function probeMedia(filePath: string): Promise<{ type: 'video' | 'audio' | 'image'; duration: number; width?: number; height?: number }> {
  return new Promise((resolveP) => {
    const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
    const isImg = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.bmp', '.tiff', '.avif'].includes(ext);
    const isAud = ['.mp3', '.wav', '.aac', '.m4a', '.ogg', '.flac', '.opus', '.wma'].includes(ext);
    const isVid = ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v', '.wmv', '.flv'].includes(ext);

    execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', filePath], (err, stdout) => {
      if (err || !stdout) {
        return resolveP({
          type: isAud ? 'audio' : isVid ? 'video' : 'image',
          duration: isAud ? 5 : isVid ? 5 : 3,
        });
      }
      try {
        const info = JSON.parse(stdout);
        const streams = Array.isArray(info.streams) ? info.streams : [];
        const vStream = streams.find((s: any) => s.codec_type === 'video');
        const aStream = streams.find((s: any) => s.codec_type === 'audio');
        const dur = parseFloat(info.format?.duration) || (isImg ? 3 : 5);
        if (vStream && !isImg) {
          resolveP({
            type: 'video',
            duration: Math.round(dur * 10) / 10,
            width: vStream.width,
            height: vStream.height,
          });
        } else if (aStream || isAud) {
          resolveP({
            type: 'audio',
            duration: Math.round(dur * 10) / 10,
          });
        } else {
          resolveP({
            type: 'image',
            duration: 3,
            width: vStream?.width,
            height: vStream?.height,
          });
        }
      } catch {
        resolveP({
          type: isAud ? 'audio' : isVid ? 'video' : 'image',
          duration: isAud ? 5 : isVid ? 5 : 3,
        });
      }
    });
  });
}

export async function saveUploadedMedia(file: File) {
  const dir = videoDir();
  let name = basename(file.name).replace(/[^\w.\- ]+/g, '_');
  let target = join(dir, name);
  let count = 1;
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
  const base = ext ? name.slice(0, -ext.length) : name;
  while (existsSync(target)) {
    name = `${base}_${count}${ext}`;
    target = join(dir, name);
    count++;
  }
  const buf = Buffer.from(await file.arrayBuffer());
  writeFileSync(target, buf);
  const probe = await probeMedia(target);
  return {
    path: `video-projects/${name}`,
    name,
    size: buf.length,
    ...probe,
  };
}

function runRender(project: VideoProject, outFile: string): Promise<string> {
  const dir = videoDir();
  const out = resolve(dir, basename(outFile.endsWith('.mp4') ? outFile : `${outFile}.mp4`));
  if (!out.startsWith(resolve(dir))) throw new HttpError(400, 'Percorso di uscita non valido');
  const script = join(dir, `.render-${randomBytes(6).toString('hex')}.py`);
  const roots = JSON.stringify(config.projectRoots);
  const py = `import json, os
from PIL import Image, ImageDraw, ImageFont
from moviepy import AudioFileClip, CompositeAudioClip, CompositeVideoClip, ImageClip, VideoFileClip, vfx
p = ${JSON.stringify(project)}
DIR = ${JSON.stringify(dir)}
ROOTS = ${roots}
W, H, FPS = int(p.get('width') or 1280), int(p.get('height') or 720), float(p.get('fps') or 24)
def font(sz):
    for f in ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"):
        if os.path.exists(f): return ImageFont.truetype(f, sz)
    return ImageFont.load_default()
ti = [0]
def resolve_path(p_in):
    if not p_in: return ""
    if os.path.exists(p_in): return os.path.abspath(p_in)
    b = os.path.basename(p_in)
    cand = os.path.join(DIR, b)
    if os.path.exists(cand): return cand
    cand2 = os.path.join(DIR, p_in)
    if os.path.exists(cand2): return cand2
    for pr in ROOTS:
        cand3 = os.path.join(pr, p_in)
        if os.path.exists(cand3): return cand3
        cand4 = os.path.join(pr, b)
        if os.path.exists(cand4): return cand4
    return p_in

def mkimg(clip, path):
    c_type = clip.get('type')
    dur = float(clip.get('duration') or 3)
    if c_type == 'title':
        img = Image.new("RGB", (W, H), clip.get('color') or "#1e293b")
        d = ImageDraw.Draw(img)
        txt = str(clip.get('text') or '')
        d.text((60, H//2-40), txt, font=font(64), fill=(255,255,255))
        ti[0] += 1
        p_out = os.path.join(DIR, f".title-{ti[0]}.png")
        img.save(p_out)
        return ImageClip(p_out).with_duration(dur)
    real_p = resolve_path(path)
    if c_type == 'video' and os.path.exists(real_p):
        vc = VideoFileClip(real_p)
        if vc.duration > dur:
            vc = vc.subclipped(0, dur)
        scale = min(W / max(1, vc.w), H / max(1, vc.h))
        nw, nh = int(vc.w * scale), int(vc.h * scale)
        nw -= nw % 2
        nh -= nh % 2
        vc_scaled = vc.resized(new_size=(nw, nh)).with_position(((W - nw) // 2, (H - nh) // 2))
        return CompositeVideoClip([vc_scaled], size=(W, H)).with_duration(dur)
    # Immagine (JPG, PNG, WEBP, GIF, etc.) con adattamento e centratura
    if os.path.exists(real_p):
        try:
            im = Image.open(real_p)
            im = im.convert("RGBA")
            im.thumbnail((W, H), Image.Resampling.LANCZOS)
            canvas = Image.new("RGB", (W, H), (15, 23, 42))
            x = (W - im.width) // 2
            y = (H - im.height) // 2
            canvas.paste(im, (x, y), im)
            ti[0] += 1
            p_fitted = os.path.join(DIR, f".img-{ti[0]}.png")
            canvas.save(p_fitted)
            return ImageClip(p_fitted).with_duration(dur)
        except Exception as e:
            print("Errore caricamento immagine:", e)
    # Fallback se file non trovato
    canvas = Image.new("RGB", (W, H), (30, 41, 59))
    d = ImageDraw.Draw(canvas)
    d.text((60, H//2-20), os.path.basename(path), font=font(40), fill=(200,200,200))
    ti[0] += 1
    p_fallback = os.path.join(DIR, f".err-{ti[0]}.png")
    canvas.save(p_fallback)
    return ImageClip(p_fallback).with_duration(dur)

vclips, aclips = [], []
for tr in p.get('tracks') or []:
    for c in tr.get('clips') or []:
        st, du = float(c.get('start') or 0), float(c.get('duration') or 1)
        fx = []
        if c.get('fadeIn'): fx.append(vfx.FadeIn(float(c['fadeIn'])))
        if c.get('fadeOut'): fx.append(vfx.FadeOut(float(c['fadeOut'])))
        if (tr.get('type') or 'video') == 'audio' or c.get('type') == 'audio':
            aud_p = resolve_path(c.get('path'))
            if os.path.exists(aud_p):
                a = AudioFileClip(aud_p).with_duration(du).with_start(st)
                aclips.append(a)
        else:
            v = mkimg(c, c.get('path') or '').with_start(st)
            if fx: v = v.with_effects(fx)
            vclips.append(v)

max_clip_end = max([(c.get('start') or 0) + (c.get('duration') or 0) for tr in p.get('tracks') or [] for c in tr.get('clips') or []] + [0])
dur = max(float(p.get('duration') or 0), max_clip_end, 1.0)
video = CompositeVideoClip(vclips, size=(W, H)).with_duration(dur) if vclips else None
if video is None:
    img = Image.new("RGB", (W, H), "#0f172a"); img.save(os.path.join(DIR, '.blank.png'))
    from moviepy import ImageClip as IC
    video = IC(os.path.join(DIR, '.blank.png')).with_duration(dur)

all_audio = []
if video.audio:
    all_audio.append(video.audio)
if aclips:
    all_audio.extend(aclips)

if all_audio:
    video = video.with_audio(CompositeAudioClip(all_audio).with_duration(dur))

video.write_videofile(${JSON.stringify(out)}, fps=FPS, codec="libx264", audio_codec="aac", temp_audiofile_path=DIR, logger=None)
print("OK " + ${JSON.stringify(out)})
`;
  writeFileSync(join(dir, '.proj.json'), '{}');
  writeFileSync(script, py);
  return new Promise((resolveP, reject) => {
    execFile('python3', [script], { timeout: 10 * 60_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      try { writeFileSync(join(dir, '.render.log'), stdout + '\n' + stderr); } catch { /* log facoltativo */ }
      if (err) return reject(new Error(`Rendering non riuscito: ${String(stderr || err.message).slice(-500)}`));
      resolveP(out);
    });
  });
}

export const videoPlugin: PluginSpec = {
  id: 'video',
  name: 'Video',
  version: '1.0.0',
  description: "Monta video da una timeline visuale nel browser o da un progetto JSON: immagini, video, titoli e audio con dissolvenze, poi rendering in MP4 con MoviePy e ffmpeg. Gli agenti usano gli stessi progetti con gli strumenti video_list_projects, video_get_project, video_save_project e video_render_project.",
  section: { id: 'video', label: 'Video' },
  routes: ['/api/video', '/video-api'],
  source: 'builtin',
  health: async () => {
    try { await checkTools(); return { ok: true, detail: 'ffmpeg e MoviePy pronti' }; }
    catch (err) { return { ok: false, detail: err instanceof Error ? err.message : String(err) }; }
  },
};

const AGENT_TOKEN = randomBytes(24).toString('hex');
const MCP_SCRIPT = new URL('./video-mcp.ts', import.meta.url).pathname;
const TSX = import.meta.resolve('tsx');

export function videoMcpServer(): acp.McpServer {
  return {
    name: 'video',
    command: process.execPath,
    args: ['--import', TSX, MCP_SCRIPT],
    env: [
      { name: 'AGICLOUD_VIDEO_URL', value: `http://127.0.0.1:${config.port}/video-api` },
      { name: 'AGICLOUD_VIDEO_TOKEN', value: AGENT_TOKEN },
    ],
  };
}

export function registerVideo(app: Hono<any>): void {
  app.get('/api/video/projects', (c) => c.json(listProjects()));
  app.get('/api/video/projects/:name', (c) => c.json(getProject(c.req.param('name'))));
  app.put('/api/video/projects/:name', async (c) => {
    const body = (await c.req.json().catch(() => null)) as VideoProject | null;
    if (!body) throw new HttpError(400, 'Progetto video non valido');
    saveProject(c.req.param('name'), body);
    return c.json({ ok: true });
  });
  app.get('/api/video/media', async (c) => {
    const dir = videoDir();
    const entries = readdirSync(dir).filter((f) => !f.startsWith('.') && !f.endsWith('.video.json') && isMedia(f));
    const list = await Promise.all(
      entries.map(async (name) => {
        const full = join(dir, name);
        const s = statSync(full);
        const probe = await probeMedia(full);
        return {
          path: `video-projects/${name}`,
          name,
          size: s.size,
          mtime: s.mtimeMs,
          ...probe,
        };
      }),
    );
    return c.json(list);
  });
  app.post('/api/video/upload', async (c) => {
    const form = await c.req.parseBody({ all: true });
    const raw = form.files ?? form.file;
    const files = (Array.isArray(raw) ? raw : [raw]).filter((f): f is File => f instanceof File);
    if (!files.length) throw new HttpError(400, 'Nessun file');
    const out = [];
    for (const f of files) {
      out.push(await saveUploadedMedia(f));
    }
    return c.json({ ok: true, files: out }, 201);
  });
  app.post('/api/video/render', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { project?: VideoProject; name?: string; out?: string };
    const project = body.project ?? (body.name ? getProject(String(body.name)) : null);
    if (!project) throw new HttpError(400, 'Progetto video non valido');
    await checkTools().catch((err) => { throw new HttpError(409, err instanceof Error ? err.message : String(err)); });
    const base = body.name ? String(body.name).replace(/\.video\.json$/, '') : (project.title || 'video').replace(/[^\w\-. ]+/g, '_');
    const out = await runRender(project, body.out || `${base}.mp4`).catch((err) => {
      throw new HttpError(409, err instanceof Error ? err.message : String(err));
    });
    return c.json({ file: out, name: basename(out), path: `video-projects/${basename(out)}` });
  });
  // API interna per gli strumenti MCP degli agenti
  const guard = (c: { req: { header: (n: string) => string | undefined } }) => {
    if (c.req.header('x-video-token') !== AGENT_TOKEN) throw new HttpError(404, 'Token non valido');
  };
  app.get('/video-api/projects', (c) => { guard(c); return c.json(listProjects()); });
  app.get('/video-api/projects/:name', (c) => { guard(c); return c.json(getProject(c.req.param('name'))); });
  app.put('/video-api/projects/:name', async (c) => {
    guard(c);
    const body = (await c.req.json().catch(() => null)) as VideoProject | null;
    if (!body) throw new HttpError(400, 'Progetto video non valido');
    saveProject(c.req.param('name'), body);
    return c.json({ ok: true });
  });
  app.post('/video-api/render', async (c) => {
    guard(c);
    const body = (await c.req.json().catch(() => ({}))) as { project?: VideoProject; name?: string; out?: string };
    const project = body.project ?? (body.name ? getProject(String(body.name)) : null);
    if (!project) throw new HttpError(400, 'Progetto video non valido');
    await checkTools().catch((err) => { throw new HttpError(409, err instanceof Error ? err.message : String(err)); });
    const base = body.name ? String(body.name).replace(/\.video\.json$/, '') : (project.title || 'video').replace(/[^\w\-. ]+/g, '_');
    const out = await runRender(project, body.out || `${base}.mp4`).catch((err) => {
      throw new HttpError(409, err instanceof Error ? err.message : String(err));
    });
    return c.json({ file: out, name: basename(out) });
  });
}
