// Plugin Video: montaggio video con timeline visuale (WebUI) e progetti JSON modificabili dagli agenti.
// Rendering con MoviePy/ffmpeg (come scripts/video-check.py): libx264 + aac, temp_audiofile_path in cartella sicura.
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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

function runRender(project: VideoProject, outFile: string): Promise<string> {
  const dir = videoDir();
  const out = resolve(dir, basename(outFile.endsWith('.mp4') ? outFile : `${outFile}.mp4`));
  if (!out.startsWith(resolve(dir))) throw new HttpError(400, 'Percorso di uscita non valido');
  const script = join(dir, `.render-${randomBytes(6).toString('hex')}.py`);
  const py = `import json, os
from PIL import Image, ImageDraw, ImageFont
from moviepy import AudioFileClip, CompositeAudioClip, CompositeVideoClip, ImageClip, VideoFileClip, vfx
proj = json.load(open(${JSON.stringify(join(dir, '.proj.json'))}))
p = ${JSON.stringify(project)}
W, H, FPS = int(p.get('width') or 1280), int(p.get('height') or 720), float(p.get('fps') or 24)
def font(sz):
    for f in ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"):
        if os.path.exists(f): return ImageFont.truetype(f, sz)
    return ImageFont.load_default()
ti = [0]
def mkimg(clip, path):
    if clip.get('type') == 'title':
        img = Image.new("RGB", (W, H), clip.get('color') or "#1e293b")
        d = ImageDraw.Draw(img)
        d.text((60, H//2-40), str(clip.get('text') or ''), font=font(64), fill=(255,255,255))
        ti[0] += 1
        path = os.path.join(${JSON.stringify(dir)}, f".title-{ti[0]}.png"); img.save(path)
        return ImageClip(path).with_duration(float(clip['duration']))
    if clip.get('type') == 'video':
        return VideoFileClip(path).with_duration(float(clip['duration']))
    return ImageClip(path).with_duration(float(clip['duration']))
vclips, aclips = [], []
for tr in p.get('tracks') or []:
    for c in tr.get('clips') or []:
        st, du = float(c.get('start') or 0), float(c.get('duration') or 1)
        fx = []
        if c.get('fadeIn'): fx.append(vfx.FadeIn(float(c['fadeIn'])))
        if c.get('fadeOut'): fx.append(vfx.FadeOut(float(c['fadeOut'])))
        if (tr.get('type') or 'video') == 'audio' or c.get('type') == 'audio':
            a = AudioFileClip(c.get('path')).with_duration(du).with_start(st)
            aclips.append(a)
        else:
            v = mkimg(c, c.get('path') or '').with_start(st)
            if fx: v = v.with_effects(fx)
            vclips.append(v)
dur = float(p.get('duration') or 0) or max([(c.get('start') or 0)+(c.get('duration') or 0) for tr in p.get('tracks') or [] for c in tr.get('clips') or []] + [1])
video = CompositeVideoClip(vclips, size=(W, H)).with_duration(dur) if vclips else None
if video is None:
    img = Image.new("RGB", (W, H), "#0f172a"); img.save(${JSON.stringify(join(dir, '.blank.png'))})
    from moviepy import ImageClip as IC
    video = IC(${JSON.stringify(join(dir, '.blank.png'))}).with_duration(dur)
if aclips:
    video = video.with_audio(CompositeAudioClip(aclips).with_duration(dur))
video.write_videofile(${JSON.stringify(out)}, fps=FPS, codec="libx264", audio_codec="aac", temp_audiofile_path=${JSON.stringify(dir)}, logger=None)
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
  app.post('/api/video/render', async (c) => {
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
