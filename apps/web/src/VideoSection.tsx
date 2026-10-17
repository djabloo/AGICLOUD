// Plugin Video: montaggio con timeline visuale multitraccia (video/immagini/titoli + audio).
// Gestione completa di formati audio (MP3, WAV, AAC, M4A, OGG), video (MP4, MOV, WEBM, MKV) e immagini (JPG, PNG, WEBP, GIF).
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { api, type VideoClip, type VideoMediaFile, type VideoProject, type VideoTrack } from './api';
import { useT } from './i18n';

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

function blankProject(title: string): VideoProject {
  return {
    version: '1.0',
    title: title || 'Nuovo video',
    width: 1280,
    height: 720,
    fps: 24,
    duration: 10,
    tracks: [
      { id: uid(), type: 'video', name: 'Traccia Video / Titoli', clips: [] },
      { id: uid(), type: 'audio', name: 'Traccia Audio / Voci', clips: [] },
    ],
  };
}

function demoProject(title: string): VideoProject {
  const vId = uid();
  return {
    version: '1.0',
    title: title || 'Demo AgiCloud',
    width: 1280,
    height: 720,
    fps: 24,
    duration: 9,
    tracks: [
      {
        id: vId,
        type: 'video',
        name: 'Traccia Video / Titoli',
        clips: [
          { id: uid(), type: 'title', text: '1. Benvenuto in AgiCloud', color: '#1e3a8a', start: 0, duration: 3, fadeIn: 0.5, fadeOut: 0.5 },
          { id: uid(), type: 'title', text: '2. Montaggio con gli Agenti', color: '#065f46', start: 3, duration: 3, fadeIn: 0.5, fadeOut: 0.5 },
          { id: uid(), type: 'title', text: '3. Video pronto in MP4', color: '#7c2d12', start: 6, duration: 3, fadeIn: 0.5, fadeOut: 0.5 },
        ],
      },
      { id: uid(), type: 'audio', name: 'Traccia Audio / Voci', clips: [] },
    ],
  };
}

const PX_PER_SEC = 60;

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1);
  return `${m.toString().padStart(2, '0')}:${s.padStart(4, '0')}`;
}

export function VideoSection() {
  const t = useT();
  const id = useId();
  const [names, setNames] = useState<{ name: string; title: string }[]>([]);
  const [current, setCurrent] = useState<string>('');
  const [project, setProject] = useState<VideoProject>(() => blankProject(t('video.newTitle')));
  const [playhead, setPlayhead] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [output, setOutput] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ trackId: string; clip: VideoClip } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [mediaList, setMediaList] = useState<VideoMediaFile[]>([]);
  const [mediaBusy, setMediaBusy] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const previewAudioRef = useRef<HTMLAudioElement>(null);

  const refreshProjects = async () => {
    try { setNames(await api.video.list()); } catch { /* plugin spento */ }
  };

  const refreshMedia = async () => {
    setMediaBusy(true);
    try {
      const m = await api.video.media();
      setMediaList(m);
    } catch {
      setMediaList([]);
    } finally {
      setMediaBusy(false);
    }
  };

  useEffect(() => {
    void refreshProjects();
    void refreshMedia();
  }, []);

  const total = useMemo(() => {
    const end = Math.max(0, ...project.tracks.flatMap((tr) => tr.clips.map((c) => c.start + c.duration)));
    return Math.max(project.duration, end, 5);
  }, [project]);

  const clipAt = (track: VideoTrack) =>
    track.clips.find((c) => playhead >= c.start && playhead < c.start + c.duration);

  const activeVClip = useMemo(() => {
    const v = project.tracks.find((tr) => tr.type === 'video' && clipAt(tr));
    return v ? clipAt(v) ?? null : null;
  }, [project, playhead]);

  const activeAClip = useMemo(() => {
    const a = project.tracks.find((tr) => tr.type === 'audio' && clipAt(tr));
    return a ? clipAt(a) ?? null : null;
  }, [project, playhead]);

  // Synchronize active video currentTime when seeking or scrubbing
  useEffect(() => {
    if (activeVClip?.type === 'video' && previewVideoRef.current && activeVClip.path) {
      const targetTime = Math.max(0, playhead - activeVClip.start);
      if (Math.abs(previewVideoRef.current.currentTime - targetTime) > 0.4) {
        previewVideoRef.current.currentTime = targetTime;
      }
    }
  }, [playhead, activeVClip]);

  // Synchronize active audio currentTime when seeking or scrubbing
  useEffect(() => {
    if (activeAClip && previewAudioRef.current && activeAClip.path) {
      const targetTime = Math.max(0, playhead - activeAClip.start);
      if (Math.abs(previewAudioRef.current.currentTime - targetTime) > 0.4) {
        previewAudioRef.current.currentTime = targetTime;
      }
    }
  }, [playhead, activeAClip]);

  // Live playhead playback ticker and media synchronization
  useEffect(() => {
    if (!isPlaying) {
      if (previewVideoRef.current && !previewVideoRef.current.paused) {
        previewVideoRef.current.pause();
      }
      if (previewAudioRef.current && !previewAudioRef.current.paused) {
        previewAudioRef.current.pause();
      }
      return;
    }

    if (previewVideoRef.current) {
      previewVideoRef.current.play().catch(() => {});
    }
    if (previewAudioRef.current) {
      previewAudioRef.current.play().catch(() => {});
    }

    const interval = setInterval(() => {
      setPlayhead((p) => {
        if (p >= total) {
          setIsPlaying(false);
          return 0;
        }
        return Math.min(total, Math.round((p + 0.1) * 10) / 10);
      });
    }, 100);

    return () => clearInterval(interval);
  }, [isPlaying, total, activeVClip?.id, activeAClip?.id]);

  const load = async (name: string) => {
    setBusy(true);
    try {
      setProject(await api.video.get(name));
      setCurrent(name);
      setOutput(null);
      setEditing(null);
      setMsg(null);
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      const maxClip = Math.max(0, ...project.tracks.flatMap((tr) => tr.clips.map((c) => c.start + c.duration)));
      const toSave = { ...project, duration: Math.max(project.duration, maxClip) };
      const name = current || `${project.title.replace(/[^\w\-. ]+/g, '_') || 'video'}.video.json`;
      await api.video.save(name, toSave);
      setProject(toSave);
      setCurrent(name);
      setMsg({ ok: true, text: t('video.saved') });
      await refreshProjects();
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const render = async () => {
    setBusy(true);
    setIsPlaying(false);
    setMsg(null);
    try {
      const maxClip = Math.max(0, ...project.tracks.flatMap((tr) => tr.clips.map((c) => c.start + c.duration)));
      const projToRender = { ...project, duration: Math.max(project.duration, maxClip) };
      const r = await api.video.render(current ? { name: current, project: projToRender } : { project: projToRender });
      setOutput(r.path || r.file || r.name);
      setMsg({ ok: true, text: t('video.rendered', { f: r.name }) });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const patch = (fn: (p: VideoProject) => VideoProject) => setProject((p) => fn(structuredClone(p)));

  const addTrack = (type: 'video' | 'audio') =>
    patch((p) => ({
      ...p,
      tracks: [
        ...p.tracks,
        { id: uid(), type, name: type === 'video' ? t('video.videoTrack') : t('video.audioTrack'), clips: [] },
      ],
    }));

  const addTitleClip = (trackId?: string) => {
    let tId = trackId;
    if (!tId) {
      const vTrack = project.tracks.find((tr) => tr.type === 'video');
      tId = vTrack ? vTrack.id : uid();
    }
    patch((p) => {
      let tracks = [...p.tracks];
      let tr = tracks.find((t) => t.id === tId);
      if (!tr) {
        tr = { id: tId!, type: 'video', name: t('video.videoTrack'), clips: [] };
        tracks.push(tr);
      }
      const end = Math.max(0, ...tr.clips.map((c) => c.start + c.duration));
      const clip: VideoClip = {
        id: uid(),
        type: 'title',
        text: t('video.newTitle'),
        color: '#1e3a8a',
        start: end,
        duration: 3,
        fadeIn: 0.5,
        fadeOut: 0.5,
      };
      setPlayhead(end);
      setEditing({ trackId: tr.id, clip });
      return {
        ...p,
        tracks: tracks.map((t) => (t.id === tr!.id ? { ...t, clips: [...t.clips, clip] } : t)),
      };
    });
  };

  const addMediaToTimeline = (media: { path: string; name: string; type: 'video' | 'image' | 'audio'; duration?: number }, targetTrackId?: string) => {
    const isAudio = media.type === 'audio';
    const targetType = isAudio ? 'audio' : 'video';
    const dur = Math.max(0.5, Number(media.duration || (isAudio ? 5 : 3)));

    patch((p) => {
      let tracks = [...p.tracks];
      let tr = targetTrackId ? tracks.find((t) => t.id === targetTrackId) : tracks.find((t) => t.type === targetType);
      if (!tr) {
        tr = { id: uid(), type: targetType, name: targetType === 'video' ? t('video.videoTrack') : t('video.audioTrack'), clips: [] };
        tracks.push(tr);
      }
      const end = Math.max(0, ...tr.clips.map((c) => c.start + c.duration));
      const newClip: VideoClip = {
        id: uid(),
        type: media.type,
        path: media.path,
        start: end,
        duration: dur,
        fadeIn: 0.5,
        fadeOut: 0.5,
      };
      setPlayhead(end);
      return {
        ...p,
        duration: Math.max(p.duration, end + dur),
        tracks: tracks.map((t) => (t.id === tr!.id ? { ...t, clips: [...t.clips, newClip] } : t)),
      };
    });
    setMsg({ ok: true, text: `Inserito ${media.name} (${dur}s) nella timeline` });
  };

  const handleUploadFiles = async (files: FileList | File[] | null, targetTrackId?: string) => {
    if (!files || !files.length) return;
    setUploading(true);
    setMsg(null);
    try {
      const fileArr = Array.from(files);
      const saved = await api.video.upload(fileArr);
      await refreshMedia();
      for (const item of saved) {
        addMediaToTimeline(item, targetTrackId);
      }
      setMsg({ ok: true, text: `Caricati ${saved.length} file multimediali e aggiunti alla timeline!` });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setUploading(false);
    }
  };

  const saveClip = () => {
    if (!editing) return;
    const { trackId, clip } = editing;
    patch((p) => ({
      ...p,
      tracks: p.tracks.map((tr) =>
        tr.id === trackId
          ? {
              ...tr,
              clips: tr.clips.some((c) => c.id === clip.id)
                ? tr.clips.map((c) => (c.id === clip.id ? clip : c))
                : [...tr.clips, clip],
            }
          : tr,
      ),
    }));
    setEditing(null);
  };

  const delClip = (trackId: string, clipId: string) => {
    patch((p) => ({
      ...p,
      tracks: p.tracks.map((tr) =>
        tr.id === trackId ? { ...tr, clips: tr.clips.filter((c) => c.id !== clipId) } : tr,
      ),
    }));
    if (editing?.clip.id === clipId) setEditing(null);
  };

  const loadDemo = () => {
    setProject(demoProject(t('video.demoTitle')));
    setCurrent('');
    setOutput(null);
    setPlayhead(0);
    setIsPlaying(false);
    setEditing(null);
    setMsg({ ok: true, text: t('video.demoLoaded') });
  };

  return (
    <section
      className="video"
      aria-labelledby={`${id}-title`}
      onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
      onDragLeave={() => setDragActive(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragActive(false);
        void handleUploadFiles(e.dataTransfer.files);
      }}
    >
      <header className="chat-header">
        <div className="chat-heading">
          <h1 id={`${id}-title`}>Video Editor</h1>
          <p className="chat-meta">{t('video.subtitle')}</p>
        </div>
        <div className="agent-actions" style={{ flexWrap: 'wrap' }}>
          <select aria-label={t('video.project')} value={current} onChange={(e) => e.target.value && void load(e.target.value)}>
            <option value="">{t('video.choose')}</option>
            {names.map((n) => <option key={n.name} value={n.name}>{n.title}</option>)}
          </select>
          <button type="button" className="btn" onClick={() => { setProject(blankProject(t('video.newTitle'))); setCurrent(''); setOutput(null); }}>
            {t('video.new')}
          </button>
          <button type="button" className="btn" onClick={loadDemo} aria-label={t('video.demo')}>
            {t('video.demo')}
          </button>
          <label className="btn primary" style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}>
            {uploading ? t('video.uploading') : `+ ${t('video.upload')}`}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              accept="image/*,video/*,audio/*,.mp4,.mov,.webm,.mkv,.avi,.mp3,.wav,.aac,.m4a,.ogg,.flac,.opus,.jpg,.jpeg,.png,.webp,.gif"
              onChange={(e) => void handleUploadFiles(e.target.files)}
            />
          </label>
          <button type="button" className="btn" disabled={busy} onClick={() => void save()}>
            {t('video.save')}
          </button>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void render()}>
            {busy ? t('video.rendering') : t('video.render')}
          </button>
        </div>
      </header>

      <div className="pii-body">
        {msg && <p className={`pii-msg ${msg.ok ? '' : 'pii-msg-err'}`} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}

        {/* 1. Project metadata bar */}
        <div className="pii-card" style={{ display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: '200px' }}>
            <label htmlFor={`${id}-title-input`}>{t('video.title')}</label>
            <input id={`${id}-title-input`} value={project.title} onChange={(e) => patch((p) => ({ ...p, title: e.target.value }))} />
          </div>
          <div className="secret-row" style={{ alignItems: 'flex-end' }}>
            <label>{t('video.size')} <input type="number" value={project.width} min={160} max={3840} onChange={(e) => patch((p) => ({ ...p, width: Number(e.target.value) }))} style={{ width: 85 }} /></label>
            <label>× <input type="number" value={project.height} min={90} max={2160} onChange={(e) => patch((p) => ({ ...p, height: Number(e.target.value) }))} style={{ width: 85 }} /></label>
            <label>{t('video.fps')} <input type="number" value={project.fps} min={1} max={60} onChange={(e) => patch((p) => ({ ...p, fps: Number(e.target.value) }))} style={{ width: 65 }} /></label>
            <label>{t('video.duration')} <input type="number" value={project.duration} min={1} max={3600} step={0.5} onChange={(e) => patch((p) => ({ ...p, duration: Number(e.target.value) }))} style={{ width: 75 }} /></label>
          </div>
        </div>

        {/* 2. Cinema Preview Player */}
        <div className="pii-card" aria-label={t('video.preview')}>
          {output ? (
            <div style={{ position: 'relative' }}>
              <div className="video-preview" style={{ aspectRatio: `${project.width}/${project.height}`, maxHeight: '440px', margin: '0 auto' }}>
                <video
                  src={api.video.mediaUrl(output)}
                  controls
                  autoPlay
                  playsInline
                  style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                />
              </div>
              <div style={{ marginTop: '10px', display: 'flex', gap: '10px', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
                <button type="button" className="btn small-btn" onClick={() => setOutput(null)}>
                  ✏ Torna all'anteprima timeline
                </button>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <span className="hint">Video renderizzato pronto!</span>
                  <a className="btn small-btn primary" href={api.video.mediaUrl(output) + '&download=1'} download>
                    📥 {t('video.download')}
                  </a>
                </div>
              </div>
            </div>
          ) : (
            <>
              <div
                className="video-preview"
                style={{
                  aspectRatio: `${project.width}/${project.height}`,
                  maxHeight: '420px',
                  margin: '0 auto',
                  position: 'relative',
                  overflow: 'hidden',
                  background: '#090d16',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {activeAClip?.path && (
                  <audio
                    ref={previewAudioRef}
                    key={`audio-${activeAClip.id}`}
                    src={api.video.mediaUrl(activeAClip.path)}
                    muted={muted}
                  />
                )}
                {!activeVClip ? (
                  <div style={{ textAlign: 'center', padding: '24px' }}>
                    <span style={{ fontSize: '2rem', display: 'block', marginBottom: '8px' }}>🎬</span>
                    <span className="hint">{t('video.noClip', { s: playhead.toFixed(1) })}</span>
                  </div>
                ) : activeVClip.type === 'title' ? (
                  <span className="video-title" style={{ background: activeVClip.color ?? '#1e293b' }}>
                    {activeVClip.text}
                  </span>
                ) : activeVClip.type === 'image' && activeVClip.path ? (
                  <img
                    key={`img-${activeVClip.id}`}
                    src={api.video.mediaUrl(activeVClip.path)}
                    alt={activeVClip.path}
                    style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                  />
                ) : activeVClip.type === 'video' && activeVClip.path ? (
                  <video
                    ref={previewVideoRef}
                    key={`vid-${activeVClip.id}`}
                    src={api.video.mediaUrl(activeVClip.path)}
                    playsInline
                    muted={muted}
                    style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                  />
                ) : (
                  <span className="hint">{activeVClip.type}: {activeVClip.path || '—'}</span>
                )}
              </div>

              {/* Transport Controls */}
              <div className="video-transport">
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <button type="button" className="btn small-btn" onClick={() => { setIsPlaying(false); setPlayhead(0); }} title="Torna all'inizio">⏮</button>
                  <button
                    type="button"
                    className={`btn small-btn ${isPlaying ? 'primary' : ''}`}
                    onClick={() => setIsPlaying(!isPlaying)}
                    style={{ minWidth: '80px', fontWeight: 600 }}
                  >
                    {isPlaying ? '⏸ Pausa' : '▶ Play'}
                  </button>
                  <button type="button" className="btn small-btn" onClick={() => { setIsPlaying(false); setPlayhead(total); }} title="Vai alla fine">⏭</button>
                  <button
                    type="button"
                    className="btn small-btn"
                    onClick={() => setMuted(!muted)}
                    title={muted ? 'Riattiva audio' : 'Muta audio'}
                  >
                    {muted ? '🔇 Muto' : '🔊 Audio'}
                  </button>
                </div>
                <div className="video-timecode">
                  {formatTime(playhead)} <span style={{ opacity: 0.6 }}>/ {formatTime(total)}</span>
                </div>
              </div>
              <input
                type="range"
                min={0}
                max={total}
                step={0.1}
                value={playhead}
                aria-label={t('video.playhead')}
                onChange={(e) => {
                  setIsPlaying(false);
                  setPlayhead(Number(e.target.value));
                }}
                style={{ width: '100%', marginTop: '8px' }}
              />
            </>
          )}
        </div>

        {/* 3. Media Library / Dropzone */}
        <div className="pii-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px', flexWrap: 'wrap', gap: '8px' }}>
            <h2 className="mini-title" style={{ margin: 0 }}>Libreria Media & File Caricati</h2>
            <div style={{ display: 'flex', gap: '8px' }}>
              <label className="btn small-btn primary" style={{ cursor: 'pointer' }}>
                {uploading ? t('video.uploading') : `+ Carica Media`}
                <input
                  type="file"
                  multiple
                  hidden
                  accept="image/*,video/*,audio/*,.mp4,.mov,.webm,.mkv,.avi,.mp3,.wav,.aac,.m4a,.ogg,.flac,.opus,.jpg,.jpeg,.png,.webp,.gif"
                  onChange={(e) => void handleUploadFiles(e.target.files)}
                />
              </label>
              <button type="button" className="btn small-btn" onClick={() => void refreshMedia()}>Aggiorna</button>
            </div>
          </div>

          <div
            className={`video-dropzone ${dragActive ? 'drag-active' : ''}`}
            onClick={() => fileInputRef.current?.click()}
          >
            <p style={{ margin: 0, fontWeight: 500 }}>
              📁 Trascina qui qualsiasi file (Video MP4/MOV, Audio MP3/WAV, Immagini JPG/PNG) o clicca per caricare
            </p>
            <p className="hint" style={{ margin: '4px 0 0 0', fontSize: '0.75rem' }}>
              I file caricati vengono inseriti automaticamente nel progetto e restano disponibili anche per gli agenti.
            </p>
          </div>

          {mediaBusy && <p className="hint">Caricamento libreria…</p>}
          {!mediaBusy && mediaList.length > 0 && (
            <div className="video-media-grid">
              {mediaList.map((m) => (
                <div key={m.path} className="video-media-card">
                  <div className="video-media-thumb">
                    {m.type === 'audio' ? (
                      <span style={{ fontSize: '1.8rem' }}>🎵</span>
                    ) : m.type === 'image' ? (
                      <img
                        src={api.video.mediaUrl(m.path)}
                        alt={m.name}
                        loading="lazy"
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                      />
                    ) : (
                      <video
                        src={api.video.mediaUrl(m.path)}
                        muted
                        playsInline
                        preload="metadata"
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                      />
                    )}
                  </div>
                  <div className="video-media-name" title={m.name}>{m.name}</div>
                  <div className="video-media-meta">
                    {m.type === 'video' && `Video · ${m.duration ? m.duration + 's' : ''}${m.width ? ` · ${m.width}x${m.height}` : ''}`}
                    {m.type === 'audio' && `Audio · ${m.duration ? m.duration + 's' : ''}`}
                    {m.type === 'image' && `Immagine${m.width ? ` · ${m.width}x${m.height}` : ''}`}
                  </div>
                  <button
                    type="button"
                    className="btn small-btn"
                    style={{ marginTop: 'auto', padding: '2px 4px', fontSize: '0.7rem' }}
                    onClick={() => addMediaToTimeline(m)}
                  >
                    + Aggiungi
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 4. Timeline multitraccia */}
        <div className="pii-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px', flexWrap: 'wrap', gap: '8px' }}>
            <h2 className="mini-title" style={{ margin: 0 }}>Timeline Montaggio</h2>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button type="button" className="btn small-btn" onClick={() => addTitleClip()}>+ Aggiungi Titolo</button>
              <button type="button" className="btn small-btn" onClick={() => addTrack('video')}>+ Traccia Video</button>
              <button type="button" className="btn small-btn" onClick={() => addTrack('audio')}>+ Traccia Audio</button>
            </div>
          </div>

          <div className="video-ruler">
            {Array.from({ length: Math.ceil(total) + 1 }, (_, s) => (
              <span key={s} style={{ left: s * PX_PER_SEC }}>{s}s</span>
            ))}
          </div>

          {project.tracks.map((tr) => (
            <div key={tr.id} className={`video-track video-track-${tr.type}`}>
              <div className="video-track-head">
                <span style={{ fontWeight: 600 }}>{tr.type === 'video' ? '🎬 Video & Titoli' : '🎵 Audio & Voci'}</span>
                <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                  <label className="btn small-btn primary" style={{ cursor: 'pointer', padding: '2px 6px', fontSize: '0.75rem' }}>
                    + Carica
                    <input
                      type="file"
                      hidden
                      accept={tr.type === 'video' ? 'image/*,video/*' : 'audio/*'}
                      onChange={(e) => void handleUploadFiles(e.target.files, tr.id)}
                    />
                  </label>
                  {tr.type === 'video' && (
                    <button type="button" className="btn small-btn" style={{ padding: '2px 6px', fontSize: '0.75rem' }} onClick={() => addTitleClip(tr.id)}>
                      + Titolo
                    </button>
                  )}
                </div>
              </div>
              <div
                className="video-lane"
                style={{ width: total * PX_PER_SEC }}
                onClick={(e) => {
                  const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                  setIsPlaying(false);
                  setPlayhead(Math.min(total, Math.max(0, (e.clientX - r.left) / PX_PER_SEC)));
                }}
              >
                <span className="video-playhead" style={{ left: playhead * PX_PER_SEC }} aria-hidden="true" />
                {tr.clips.map((c) => {
                  const isSel = editing?.clip.id === c.id;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      className={`video-clip video-clip-${c.type} ${isSel ? 'is-selected' : ''}`}
                      style={{ left: c.start * PX_PER_SEC, width: Math.max(30, c.duration * PX_PER_SEC) }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditing({ trackId: tr.id, clip: { ...c } });
                        setPlayhead(c.start);
                      }}
                      aria-label={`${c.type} ${c.start}s ${c.duration}s`}
                    >
                      <span>{c.type === 'title' ? c.text : (c.path?.split('/').pop() || c.type)}</span>
                      <span style={{ opacity: 0.8, fontSize: '0.7rem', marginLeft: '4px' }}>({c.duration.toFixed(1)}s)</span>
                      <span
                        className="video-clip-del"
                        onClick={(e) => {
                          e.stopPropagation();
                          delClip(tr.id, c.id);
                        }}
                        title="Elimina clip"
                      >
                        ×
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {/* 5. Clip Inspector / Edit Dialog */}
        {editing && (
          <div className="pii-card" role="dialog" aria-modal="true" aria-label={t('video.editClip')} style={{ border: '1px solid var(--primary, #3b82f6)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <h2 className="mini-title" style={{ margin: 0 }}>Modifica Clip: {editing.clip.type}</h2>
              <button type="button" className="btn small-btn" onClick={() => setEditing(null)}>Chiudi</button>
            </div>

            <div className="secret-row">
              <label>
                {t('video.clipType')}
                <select
                  value={editing.clip.type}
                  onChange={(e) => setEditing({ ...editing, clip: { ...editing.clip, type: e.target.value as VideoClip['type'] } })}
                >
                  <option value="image">Immagine (foto/slide)</option>
                  <option value="video">Video (clip MP4/MOV)</option>
                  <option value="title">Titolo (schermata testo)</option>
                  <option value="audio">Audio (voce/musica)</option>
                </select>
              </label>
              <label>
                {t('video.start')}
                <input
                  type="number"
                  step={0.1}
                  min={0}
                  value={editing.clip.start}
                  onChange={(e) => setEditing({ ...editing, clip: { ...editing.clip, start: Number(e.target.value) } })}
                />
              </label>
              <label>
                {t('video.clipDuration')}
                <input
                  type="number"
                  step={0.1}
                  min={0.1}
                  value={editing.clip.duration}
                  onChange={(e) => setEditing({ ...editing, clip: { ...editing.clip, duration: Number(e.target.value) } })}
                />
              </label>
            </div>

            {(editing.clip.type === 'image' || editing.clip.type === 'video' || editing.clip.type === 'audio') && (
              <div style={{ marginTop: '8px' }}>
                <label>
                  {t('video.path')}
                  <input
                    value={editing.clip.path ?? ''}
                    placeholder="video-projects/nome-file.ext"
                    onChange={(e) => setEditing({ ...editing, clip: { ...editing.clip, path: e.target.value } })}
                  />
                </label>
              </div>
            )}

            {editing.clip.type === 'title' && (
              <div className="secret-row" style={{ marginTop: '8px' }}>
                <label style={{ flex: 1 }}>
                  {t('video.text')}
                  <input
                    value={editing.clip.text ?? ''}
                    onChange={(e) => setEditing({ ...editing, clip: { ...editing.clip, text: e.target.value } })}
                  />
                </label>
                <label>
                  {t('video.color')}
                  <input
                    type="color"
                    value={editing.clip.color ?? '#1e293b'}
                    onChange={(e) => setEditing({ ...editing, clip: { ...editing.clip, color: e.target.value } })}
                  />
                </label>
              </div>
            )}

            <div className="secret-row" style={{ marginTop: '8px' }}>
              <label>
                {t('video.fadeIn')}
                <input
                  type="number"
                  step={0.1}
                  min={0}
                  max={5}
                  value={editing.clip.fadeIn ?? 0}
                  onChange={(e) => setEditing({ ...editing, clip: { ...editing.clip, fadeIn: Number(e.target.value) } })}
                />
              </label>
              <label>
                {t('video.fadeOut')}
                <input
                  type="number"
                  step={0.1}
                  min={0}
                  max={5}
                  value={editing.clip.fadeOut ?? 0}
                  onChange={(e) => setEditing({ ...editing, clip: { ...editing.clip, fadeOut: Number(e.target.value) } })}
                />
              </label>
            </div>

            <div className="agent-actions" style={{ marginTop: '14px' }}>
              <button type="button" className="btn primary" onClick={saveClip}>{t('video.ok')}</button>
              <button type="button" className="btn" onClick={() => setEditing(null)}>{t('video.cancel')}</button>
              <button type="button" className="btn" onClick={() => delClip(editing.trackId, editing.clip.id)}>{t('video.delete')}</button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
