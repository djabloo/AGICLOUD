// Plugin Video: montaggio con timeline visuale multitraccia (video/titoli + audio).
// Gli stessi progetti (.video.json) li modificano gli agenti via MCP e li renderizza MoviePy/ffmpeg.
import { useEffect, useId, useMemo, useState } from 'react';
import { api, type VideoClip, type VideoProject, type VideoTrack } from './api';
import { useT } from './i18n';

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

function blankProject(title: string): VideoProject {
  return {
    version: '1.0', title, width: 1280, height: 720, fps: 24, duration: 10,
    tracks: [
      { id: uid(), type: 'video', name: '', clips: [] },
      { id: uid(), type: 'audio', name: '', clips: [] },
    ],
  };
}

function demoProject(title: string, newTitle: string): VideoProject {
  const vId = uid();
  return {
    version: '1.0', title: title || 'Demo', width: 1280, height: 720, fps: 24, duration: 9,
    tracks: [
      {
        id: vId, type: 'video', name: '', clips: [
          { id: uid(), type: 'title', text: newTitle || 'Demo', color: '#1e3a8a', start: 0, duration: 3, fadeIn: 0.5, fadeOut: 0.5 },
          { id: uid(), type: 'title', text: 'Slide 2', color: '#065f46', start: 3, duration: 3, fadeIn: 0.5, fadeOut: 0.5 },
          { id: uid(), type: 'title', text: 'Slide 3', color: '#7c2d12', start: 6, duration: 3, fadeIn: 0.5, fadeOut: 0.5 },
        ],
      },
      { id: uid(), type: 'audio', name: '', clips: [] },
    ],
  };
}

const PX_PER_SEC = 60;
const MEDIA_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.mp4', '.mov', '.wav', '.mp3', '.aac'];

function isMedia(name: string): boolean {
  const n = name.toLowerCase();
  return MEDIA_EXT.some((e) => n.endsWith(e));
}

function MediaUrl({ path, kind, alt }: { path: string; kind: 'image' | 'video'; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let live = true;
    let obj = '';
    setUrl(null);
    setErr(false);
    api.fileBlob(path).then(async (b) => {
      if (!live) return;
      obj = URL.createObjectURL(b);
      if (live) setUrl(obj);
    }).catch(() => { if (live) setErr(true); });
    return () => { live = false; if (obj) URL.revokeObjectURL(obj); };
  }, [path]);
  if (err) return <span className="hint">{alt}: {path}</span>;
  if (!url) return <span className="hint" role="status">…</span>;
  if (kind === 'video') return <video src={url} controls style={{ maxWidth: '100%', maxHeight: '100%' }} aria-label={alt} />;
  return <img src={url} alt={alt} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />;
}

export function VideoSection() {
  const t = useT();
  const id = useId();
  const [names, setNames] = useState<{ name: string; title: string }[]>([]);
  const [current, setCurrent] = useState<string>('');
  const [project, setProject] = useState<VideoProject>(() => blankProject('Nuovo video'));
  const [playhead, setPlayhead] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [output, setOutput] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ trackId: string; clip: VideoClip } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [media, setMedia] = useState<string[]>([]);
  const [mediaBusy, setMediaBusy] = useState(false);

  const refresh = async () => {
    try { setNames(await api.video.list()); } catch { /* plugin spento */ }
  };
  useEffect(() => { void refresh(); }, []);

  const total = useMemo(() => {
    const end = Math.max(0, ...project.tracks.flatMap((tr) => tr.clips.map((c) => c.start + c.duration)));
    return Math.max(project.duration, end, 5);
  }, [project]);

  const load = async (name: string) => {
    setBusy(true);
    try {
      setProject(await api.video.get(name));
      setCurrent(name);
      setOutput(null);
      setMsg(null);
    } catch (err) { setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) }); }
    finally { setBusy(false); }
  };

  const save = async () => {
    setBusy(true);
    try {
      const name = current || `${project.title.replace(/[^\w\-. ]+/g, '_') || 'video'}.video.json`;
      await api.video.save(name, project);
      setCurrent(name);
      setMsg({ ok: true, text: t('video.saved') });
      await refresh();
    } catch (err) { setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) }); }
    finally { setBusy(false); }
  };

  const render = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.video.render(current ? { name: current, project } : { project });
      setOutput(r.name);
      setMsg({ ok: true, text: t('video.rendered', { f: r.name }) });
    } catch (err) { setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) }); }
    finally { setBusy(false); }
  };

  const patch = (fn: (p: VideoProject) => VideoProject) => setProject((p) => fn(structuredClone(p)));

  const addTrack = (type: 'video' | 'audio') =>
    patch((p) => ({ ...p, tracks: [...p.tracks, { id: uid(), type, name: '', clips: [] }] }));

  const addClip = (track: VideoTrack) => {
    const end = Math.max(0, ...track.clips.map((c) => c.start + c.duration));
    const clip: VideoClip =
      track.type === 'audio'
        ? { id: uid(), type: 'audio', path: '', start: end, duration: 3 }
        : { id: uid(), type: 'title', text: t('video.newTitle'), color: '#1e293b', start: end, duration: 2, fadeIn: 0.5, fadeOut: 0.5 };
    patch((p) => ({
      ...p,
      tracks: p.tracks.map((tr) => (tr.id === track.id ? { ...tr, clips: [...tr.clips, clip] } : tr)),
    }));
    setEditing({ trackId: track.id, clip });
  };

  const saveClip = () => {
    if (!editing) return;
    const { trackId, clip } = editing;
    patch((p) => ({
      ...p,
      tracks: p.tracks.map((tr) =>
        tr.id === trackId
          ? { ...tr, clips: tr.clips.some((c) => c.id === clip.id) ? tr.clips.map((c) => (c.id === clip.id ? clip : c)) : [...tr.clips, clip] }
          : tr,
      ),
    }));
    setEditing(null);
  };

  const delClip = (trackId: string, clipId: string) =>
    patch((p) => ({ ...p, tracks: p.tracks.map((tr) => (tr.id === trackId ? { ...tr, clips: tr.clips.filter((c) => c.id !== clipId) } : tr)) }));

  const clipAt = (track: VideoTrack) => track.clips.find((c) => playhead >= c.start && playhead < c.start + c.duration);

  const onUpload = async (file: File | undefined) => {
    if (!file || !editing) return;
    setUploading(true);
    try {
      const entries = await api.uploadFiles('video-projects', [file]);
      const name = entries[0]?.path ?? `video-projects/${file.name}`;
      setEditing({ ...editing, clip: { ...editing.clip, path: name } });
      setMsg({ ok: true, text: t('video.uploaded', { f: name }) });
    } catch (err) { setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) }); }
    finally { setUploading(false); }
  };

  const openBrowser = async () => {
    setBrowserOpen(true);
    setMediaBusy(true);
    try {
      const l = await api.listFiles('video-projects');
      setMedia(l.entries.filter((e) => e.type === 'file' && isMedia(e.name)).map((e) => e.path));
    } catch { setMedia([]); }
    finally { setMediaBusy(false); }
  };

  const pickMedia = (path: string) => {
    if (editing) setEditing({ ...editing, clip: { ...editing.clip, path } });
    setBrowserOpen(false);
  };

  const loadDemo = () => {
    setProject(demoProject(t('video.demoTitle'), t('video.newTitle')));
    setCurrent('');
    setOutput(null);
    setPlayhead(0);
    setMsg({ ok: true, text: t('video.demoLoaded') });
  };

  const activeClip = (() => {
    const v = project.tracks.find((tr) => tr.type === 'video' && clipAt(tr));
    return v ? clipAt(v) ?? null : null;
  })();

  return (
    <section className="video" aria-labelledby={`${id}-title`}>
      <header className="chat-header">
        <div className="chat-heading">
          <h1 id={`${id}-title`}>Video</h1>
          <p className="chat-meta">{t('video.subtitle')}</p>
        </div>
        <div className="agent-actions">
          <select aria-label={t('video.project')} value={current} onChange={(e) => e.target.value && void load(e.target.value)}>
            <option value="">{t('video.choose')}</option>
            {names.map((n) => <option key={n.name} value={n.name}>{n.title}</option>)}
          </select>
          <button type="button" className="btn" onClick={() => { setProject(blankProject(t('video.newTitle'))); setCurrent(''); setOutput(null); }}>{t('video.new')}</button>
          <button type="button" className="btn" onClick={loadDemo} aria-label={t('video.demo')}>{t('video.demo')}</button>
          <button type="button" className="btn" disabled={busy} onClick={() => void save()}>{t('video.save')}</button>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void render()}>{busy ? t('video.rendering') : t('video.render')}</button>
        </div>
      </header>

      <div className="pii-body">
        {msg && <p className={`pii-msg ${msg.ok ? '' : 'pii-msg-err'}`} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}

        <div className="pii-card">
          <label htmlFor={`${id}-title-input`}>{t('video.title')}</label>
          <input id={`${id}-title-input`} value={project.title} onChange={(e) => patch((p) => ({ ...p, title: e.target.value }))} />
          <div className="secret-row">
            <label>{t('video.size')} <input type="number" value={project.width} min={160} max={3840} onChange={(e) => patch((p) => ({ ...p, width: Number(e.target.value) }))} style={{ width: 90 }} /></label>
            <label>× <input type="number" value={project.height} min={90} max={2160} onChange={(e) => patch((p) => ({ ...p, height: Number(e.target.value) }))} style={{ width: 90 }} /></label>
            <label>{t('video.fps')} <input type="number" value={project.fps} min={1} max={60} onChange={(e) => patch((p) => ({ ...p, fps: Number(e.target.value) }))} style={{ width: 70 }} /></label>
            <label>{t('video.duration')} <input type="number" value={project.duration} min={1} max={3600} step={0.5} onChange={(e) => patch((p) => ({ ...p, duration: Number(e.target.value) }))} style={{ width: 80 }} /></label>
          </div>
        </div>

        <div className="pii-card" aria-label={t('video.preview')}>
          <div className="video-preview" style={{ aspectRatio: `${project.width}/${project.height}` }}>
            {(() => {
              const c = activeClip;
              if (!c) return <span className="hint">{t('video.noClip', { s: playhead.toFixed(1) })}</span>;
              if (c.type === 'title') return <span className="video-title" style={{ background: c.color ?? '#1e293b' }}>{c.text}</span>;
              if (c.type === 'image' && c.path) return <MediaUrl path={c.path} kind="image" alt={t('video.previewImageAlt')} />;
              if (c.type === 'video' && c.path) return <MediaUrl path={c.path} kind="video" alt={t('video.previewVideo')} />;
              return <span className="hint">{c.type}: {c.path || '—'} ({c.start.toFixed(1)}s → {(c.start + c.duration).toFixed(1)}s)</span>;
            })()}
          </div>
          <label>{t('video.playhead')}: {playhead.toFixed(1)}s
            <input type="range" min={0} max={total} step={0.1} value={playhead} aria-label={t('video.playhead')} onChange={(e) => setPlayhead(Number(e.target.value))} style={{ width: '100%' }} />
          </label>
        </div>

        <div className="pii-card">
          <h2 className="mini-title">{t('video.timeline')}</h2>
          <div className="video-ruler">
            {Array.from({ length: Math.ceil(total) + 1 }, (_, s) => (
              <span key={s} style={{ left: s * PX_PER_SEC }}>{s}s</span>
            ))}
          </div>
          {project.tracks.map((tr) => (
            <div key={tr.id} className={`video-track video-track-${tr.type}`}>
              <div className="video-track-head">
                <span>{tr.type === 'video' ? t('video.videoTrack') : t('video.audioTrack')}</span>
                <button type="button" className="btn small-btn" onClick={() => addClip(tr)}>+ {t('video.addClip')}</button>
              </div>
              <div className="video-lane" style={{ width: total * PX_PER_SEC }} onClick={(e) => {
                const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                setPlayhead(Math.min(total, Math.max(0, (e.clientX - r.left) / PX_PER_SEC)));
              }}>
                <span className="video-playhead" style={{ left: playhead * PX_PER_SEC }} aria-hidden="true" />
                {tr.clips.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className={`video-clip video-clip-${c.type}`}
                    style={{ left: c.start * PX_PER_SEC, width: Math.max(24, c.duration * PX_PER_SEC) }}
                    onClick={(e) => { e.stopPropagation(); setEditing({ trackId: tr.id, clip: { ...c } }); }}
                    aria-label={`${c.type} ${c.start}s ${c.duration}s`}
                  >
                    {c.type === 'title' ? c.text : (c.path?.split('/').pop() || c.type)}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <div className="agent-actions">
            <button type="button" className="btn small-btn" onClick={() => addTrack('video')}>+ {t('video.videoTrack')}</button>
            <button type="button" className="btn small-btn" onClick={() => addTrack('audio')}>+ {t('video.audioTrack')}</button>
          </div>
        </div>

        {editing && (
          <div className="pii-card" role="dialog" aria-modal="true" aria-label={t('video.editClip')}>
            <h2 className="mini-title">{t('video.editClip')}</h2>
            <div className="secret-row">
              <label>{t('video.clipType')}
                <select value={editing.clip.type} onChange={(e) => setEditing({ ...editing, clip: { ...editing.clip, type: e.target.value as VideoClip['type'] } })}>
                  <option value="image">image</option>
                  <option value="video">video</option>
                  <option value="title">title</option>
                  <option value="audio">audio</option>
                </select>
              </label>
              <label>{t('video.start')} <input type="number" step={0.1} min={0} value={editing.clip.start} onChange={(e) => setEditing({ ...editing, clip: { ...editing.clip, start: Number(e.target.value) } })} /></label>
              <label>{t('video.clipDuration')} <input type="number" step={0.1} min={0.1} value={editing.clip.duration} onChange={(e) => setEditing({ ...editing, clip: { ...editing.clip, duration: Number(e.target.value) } })} /></label>
            </div>
            {(editing.clip.type === 'image' || editing.clip.type === 'video' || editing.clip.type === 'audio') && (
              <>
                <label>{t('video.path')}
                  <input value={editing.clip.path ?? ''} placeholder={t('video.pathPlaceholder')} aria-label={t('video.path')} onChange={(e) => setEditing({ ...editing, clip: { ...editing.clip, path: e.target.value } })} />
                </label>
                <div className="agent-actions">
                  <label className="btn small-btn" aria-label={t('video.upload')}>
                    {uploading ? t('video.uploading') : t('video.upload')}
                    <input type="file" hidden accept="image/*,video/*,audio/*" onChange={(e) => void onUpload(e.target.files?.[0])} />
                  </label>
                  <button type="button" className="btn small-btn" onClick={() => void openBrowser()}>{t('video.browse')}</button>
                </div>
              </>
            )}
            {editing.clip.type === 'title' && (
              <div className="secret-row">
                <label>{t('video.text')} <input value={editing.clip.text ?? ''} onChange={(e) => setEditing({ ...editing, clip: { ...editing.clip, text: e.target.value } })} /></label>
                <label>{t('video.color')} <input type="color" value={editing.clip.color ?? '#1e293b'} onChange={(e) => setEditing({ ...editing, clip: { ...editing.clip, color: e.target.value } })} /></label>
              </div>
            )}
            <div className="secret-row">
              <label>{t('video.fadeIn')} <input type="number" step={0.1} min={0} value={editing.clip.fadeIn ?? 0} onChange={(e) => setEditing({ ...editing, clip: { ...editing.clip, fadeIn: Number(e.target.value) } })} /></label>
              <label>{t('video.fadeOut')} <input type="number" step={0.1} min={0} value={editing.clip.fadeOut ?? 0} onChange={(e) => setEditing({ ...editing, clip: { ...editing.clip, fadeOut: Number(e.target.value) } })} /></label>
            </div>
            <div className="agent-actions">
              <button type="button" className="btn primary" onClick={saveClip}>{t('video.ok')}</button>
              <button type="button" className="btn" onClick={() => setEditing(null)}>{t('video.cancel')}</button>
              <button type="button" className="btn" onClick={() => { delClip(editing.trackId, editing.clip.id); setEditing(null); }}>{t('video.delete')}</button>
            </div>
          </div>
        )}

        {browserOpen && (
          <div className="pii-card" role="dialog" aria-modal="true" aria-label={t('video.mediaTitle')}>
            <h2 className="mini-title">{t('video.mediaTitle')}</h2>
            {mediaBusy && <p className="hint" role="status">…</p>}
            {!mediaBusy && media.length === 0 && <p className="hint">{t('video.mediaEmpty')}</p>}
            <ul>
              {media.map((m) => (
                <li key={m}>
                  <button type="button" className="btn small-btn" onClick={() => pickMedia(m)} aria-label={`${t('video.mediaChoose')}: ${m}`}>{m.split('/').pop()}</button>
                </li>
              ))}
            </ul>
            <div className="agent-actions">
              <button type="button" className="btn" onClick={() => setBrowserOpen(false)}>{t('video.mediaClose')}</button>
            </div>
          </div>
        )}

        {output && (
          <div className="pii-card">
            <h2 className="mini-title">{t('video.result')}</h2>
            <p className="hint">{output}</p>
            <a className="btn" href={`/api/files/raw?path=${encodeURIComponent(output)}`} download>{t('video.download')}</a>
          </div>
        )}
      </div>
    </section>
  );
}
