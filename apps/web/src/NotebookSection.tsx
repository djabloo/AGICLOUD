// Sezione Notebook: notebook di ricerca con fonti (testo, pagine web, YouTube, file),
// chat vincolata alle fonti e Studio (Overview Audio, Video narrato, Presentazione,
// Report, Infografica, Quiz, Flashcard, Mappa mentale, Tabella dati).
//
// Il backend e' /api/notebook (plugin nativo): ogni richiesta porta il progetto scelto
// ("wspath") cosi' il notebook segue lo switch ambiente invece di restare fisso.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  api,
  ApiError,
  type NotebookChatMessage,
  type NotebookMeta,
  type NotebookSettings,
  type NotebookSource,
  type NotebookStudioItem,
  type NotebookVoice,
} from './api';
import { Markdown } from './markdown';
import { useT } from './i18n';

const PROJECT_KEY = 'agicloud_notebook_project';

const STUDIO_TYPES: { kind: string; labelKey: string; icon: NbIconName }[] = [
  { kind: 'audio_overview', labelKey: 'studioAudioOverview', icon: 'mic' },
  { kind: 'video_presentation', labelKey: 'studioVideo', icon: 'video' },
  { kind: 'presentation', labelKey: 'studioPresentation', icon: 'presentation' },
  { kind: 'report', labelKey: 'studioReport', icon: 'doc' },
  { kind: 'infographic', labelKey: 'studioInfographic', icon: 'infographic' },
  { kind: 'quiz', labelKey: 'studioQuiz', icon: 'quiz' },
  { kind: 'flashcards', labelKey: 'studioFlashcards', icon: 'cards' },
  { kind: 'mindmap', labelKey: 'studioMindmap', icon: 'map' },
  { kind: 'datatable', labelKey: 'studioDatatable', icon: 'table' },
];

// ── icone locali (il set condiviso copre solo quelle comuni) ──────────────────
const NB_ICONS = {
  notebook: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5V4.5A2.5 2.5 0 0 1 6.5 2M9 7h7M9 11h5',
  plus: 'M12 5v14M5 12h14',
  close: 'M6 6l12 12M18 6 6 18',
  link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  upload: 'M12 15V3M7 8l5-5 5 5M5 21h14',
  doc: 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7ZM14 2v4a2 2 0 0 0 2 2h4',
  send: 'M22 2 11 13M22 2l-7 20-4-9-9-4Z',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  external: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3',
  trash: 'M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
  loader: 'M21 12a9 9 0 1 1-6.219-8.56',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  settings:
    'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z',
  mic: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3M19 10v2a7 7 0 0 1-14 0v-2M12 19v3',
  video: 'M22 8l-6 4 6 4V8ZM14 6H4a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2z',
  presentation: 'M2 3h20v14H2zM8 21h8M12 17v4',
  infographic: 'M3 3h18v18H3zM7 16V8M12 16v-4M17 16v-7',
  quiz: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01',
  cards: 'M3 6h18v12H3zM3 10h18',
  map: 'M12 3.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5M5 13.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5M19 13.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5M12 8.5v3M9.5 14 11 10M14.5 14 13 10',
  table: 'M3 3h18v18H3zM3 9h18M9 3v18',
  flip: 'M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16M16 16h5v5',
} as const;
type NbIconName = keyof typeof NB_ICONS;

function NbIcon({ name, className }: { name: NbIconName; className?: string }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={NB_ICONS[name]} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Spinner() {
  return <NbIcon name="loader" className="agynb-spin" />;
}

// ── flashcard: parser del markdown prodotto da agy ───────────────────────────
interface Flashcard {
  front: string;
  back: string;
}
function parseFlashcards(content: string): Flashcard[] {
  const cards: Flashcard[] = [];
  let curF: string | null = null;
  let curB: string | null = null;
  let target: 'front' | 'back' | null = null;
  for (const rawLine of (content || '').split('\n')) {
    const l = rawLine.trim();
    const fMatch = l.match(/^(?:\*\*Fronte:\*\*|Fronte:|Front:|\*\*Front:\*\*)\s*(.*)/i);
    const rMatch = l.match(/^(?:\*\*Retro:\*\*|Retro:|Back:|\*\*Back:\*\*)\s*(.*)/i);
    if (fMatch) {
      if (curF && curB) cards.push({ front: curF.trim(), back: curB.trim() });
      curF = fMatch[1] ?? '';
      curB = null;
      target = 'front';
    } else if (rMatch) {
      curB = rMatch[1] ?? '';
      target = 'back';
    } else if (l) {
      if (target === 'front' && curF !== null) curF += '\n' + l;
      else if (target === 'back' && curB !== null) curB += '\n' + l;
    }
  }
  if (curF && curB) cards.push({ front: curF.trim(), back: curB.trim() });
  return cards;
}

function Flashcards({ content }: { content: string }) {
  const t = useT();
  const cards = useMemo(() => parseFlashcards(content), [content]);
  const [idx, setIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [mode, setMode] = useState<'deck' | 'list'>('deck');

  useEffect(() => {
    if (mode !== 'deck') return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        setFlipped((f) => !f);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setIdx((i) => Math.min(i + 1, cards.length - 1));
        setFlipped(false);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setIdx((i) => Math.max(i - 1, 0));
        setFlipped(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, cards.length]);

  if (!cards.length) return <Markdown text={content} />;
  const card = cards[Math.min(idx, cards.length - 1)]!;
  const pct = Math.round(((idx + 1) / cards.length) * 100);

  return (
    <div className="agynb-fc-wrap">
      <div className="agynb-fc-topbar">
        <span className="agynb-fc-counter">
          {mode === 'list' ? t('notebook.fcCreate', { n: cards.length, count: cards.length }) : t('notebook.fcCartaDi', { i: idx + 1, n: cards.length })}
        </span>
        {mode === 'deck' && (
          <div className="agynb-fc-progress-wrap">
            <div className="agynb-fc-progress-bar" style={{ width: `${pct}%` }} />
          </div>
        )}
        <div className="agynb-fc-viewmode">
          <button type="button" className={mode === 'deck' ? 'active' : ''} onClick={() => setMode('deck')}>
            {t('notebook.fcDeck')}
          </button>
          <button type="button" className={mode === 'list' ? 'active' : ''} onClick={() => setMode('list')}>
            {t('notebook.fcElenco')}
          </button>
        </div>
      </div>

      {mode === 'list' ? (
        <div className="agynb-fc-listview">
          {cards.map((c, i) => (
            <div className="agynb-fc-item" key={i}>
              <div className="agynb-fc-item-num">{t('notebook.fcCartaDi', { i: i + 1, n: cards.length })}</div>
              <div className="agynb-fc-item-q">{t('notebook.fcDomanda', { text: c.front })}</div>
              <div className="agynb-fc-item-a">{t('notebook.fcRisposta', { text: c.back })}</div>
            </div>
          ))}
        </div>
      ) : (
        <>
          <div className="agynb-fc-scene" title={t('notebook.fcGiraHint')} onClick={() => setFlipped((f) => !f)}>
            <div className={`agynb-fc-card${flipped ? ' flipped' : ''}`}>
              <div className="agynb-fc-face agynb-fc-front">
                <span className="agynb-fc-badge">{t('notebook.fcBadgeDomanda')}</span>
                <div className="agynb-fc-content">{card.front}</div>
                <div className="agynb-fc-hint">
                  <NbIcon name="flip" /> {t('notebook.fcGiraHint')}
                </div>
              </div>
              <div className="agynb-fc-face agynb-fc-back">
                <span className="agynb-fc-badge">{t('notebook.fcBadgeRisposta')}</span>
                <div className="agynb-fc-content">{card.back}</div>
                <div className="agynb-fc-hint">
                  <NbIcon name="flip" /> {t('notebook.fcTornaHint')}
                </div>
              </div>
            </div>
          </div>

          <div className="agynb-fc-controls">
            <button
              type="button"
              className="agynb-fc-btn"
              disabled={idx === 0}
              onClick={() => {
                setIdx((i) => Math.max(i - 1, 0));
                setFlipped(false);
              }}
            >
              {t('notebook.fcPrecedente')}
            </button>
            <button type="button" className="agynb-fc-btn flip" onClick={() => setFlipped((f) => !f)}>
              {flipped ? t('notebook.fcMostraDomanda') : t('notebook.fcGira')}
            </button>
            <button
              type="button"
              className="agynb-fc-btn"
              disabled={idx === cards.length - 1}
              onClick={() => {
                setIdx((i) => Math.min(i + 1, cards.length - 1));
                setFlipped(false);
              }}
            >
              {t('notebook.fcSuccessiva')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ── mappa mentale: parser della sintassi Mermaid "mindmap" ────────────────────
interface MindNode {
  label: string;
  children: MindNode[];
}
function mindLabel(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^[A-Za-z0-9_]+[\[\({]+/, '').replace(/[\]\)}]+$/, '');
  return s.trim() || raw.trim();
}
function parseMindmap(code: string): MindNode | null {
  const lines = code.split('\n');
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim().toLowerCase() === 'mindmap') {
      start = i + 1;
      break;
    }
  }
  const stack: { indent: number; node: MindNode }[] = [];
  let root: MindNode | null = null;
  for (let i = start; i < lines.length; i++) {
    const raw = lines[i]!;
    if (!raw.trim() || raw.trim().startsWith('%%')) continue;
    const indent = raw.length - raw.trimStart().length;
    const node: MindNode = { label: mindLabel(raw), children: [] };
    while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
    if (!stack.length) {
      if (!root) root = node;
      else root.children.push(node);
    } else {
      stack[stack.length - 1]!.node.children.push(node);
    }
    stack.push({ indent, node });
  }
  return root;
}
function MindNodeView({ node, depth }: { node: MindNode; depth: number }) {
  return (
    <li className={`agynb-mm-node agynb-mm-d${Math.min(depth, 3)}`}>
      <span className="agynb-mm-label">{node.label}</span>
      {node.children.length > 0 && (
        <ul>
          {node.children.map((c, i) => (
            <MindNodeView node={c} depth={depth + 1} key={i} />
          ))}
        </ul>
      )}
    </li>
  );
}
function MindMap({ code }: { code: string }) {
  const t = useT();
  const root = useMemo(() => parseMindmap(code), [code]);
  if (!root) return <pre className="agynb-mm-fallback">{code}</pre>;
  return (
    <div className="agynb-mm" role="img" aria-label={t('notebook.mappaTitolo')}>
      <ul className="agynb-mm-root">
        <MindNodeView node={root} depth={0} />
      </ul>
    </div>
  );
}

// ── viewer dei contenuti ─────────────────────────────────────────────────────
type ViewerKind = 'html' | 'flashcards' | 'mindmap' | 'markdown';
function viewerKind(name: string): ViewerKind {
  if (name.startsWith('audio_overview-') || name.startsWith('infographic-') || name.startsWith('presentation-') || name.endsWith('.html')) return 'html';
  if (name.startsWith('flashcards-')) return 'flashcards';
  if (name.startsWith('mindmap-')) return 'mindmap';
  return 'markdown';
}

interface ViewerState {
  name: string;
  kind: ViewerKind;
  content: string;
  blobUrl?: string;
  wide: boolean;
}

// ── impostazioni voci ────────────────────────────────────────────────────────
function SettingsModal({
  settings,
  voices,
  onClose,
  onSaved,
}: {
  settings: NotebookSettings;
  voices: NotebookVoice[];
  onClose: () => void;
  onSaved: (s: NotebookSettings) => void;
}) {
  const t = useT();
  const id = useId();
  const [provider, setProvider] = useState<'edge' | 'elevenlabs'>(settings.provider);
  const [model, setModel] = useState(settings.elevenlabs.model);
  const [key, setKey] = useState('');
  const [voiceA, setVoiceA] = useState(settings.elevenlabs.voiceA || (voices.length ? '' : 'JBFqnCBsd6RMkjVDRZzb'));
  const [voiceB, setVoiceB] = useState(settings.elevenlabs.voiceB || (voices.length ? '' : 'EXAVITQu4vr4xnAE8sDL'));
  const [voiceList, setVoiceList] = useState<NotebookVoice[]>(voices);
  const [localSettings, setLocalSettings] = useState(settings);
  const [status, setStatus] = useState<{ kind: 'ok' | 'err' | ''; text: string }>({ kind: '', text: '' });
  const [busy, setBusy] = useState(false);

  const hasKey = localSettings.elevenlabs.hasKey;
  const keyHint = hasKey ? t('notebook.chiaveAttiva', { hint: localSettings.elevenlabs.keyHint }) : t('notebook.nessunaChiave');

  const voiceName = (list: NotebookVoice[], val: string) => list.find((v) => v.id === val)?.name ?? '';

  const testKey = async () => {
    setBusy(true);
    setStatus({ kind: '', text: t('notebook.verificaInCorso') });
    try {
      if (key.trim()) {
        const saved = await api.notebook.saveSettings({ elevenlabsKey: key.trim() });
        setLocalSettings(saved);
      }
      const data = await api.notebook.voices();
      setVoiceList(data.voices || []);
      setStatus({ kind: 'ok', text: t('notebook.chiaveValida', { n: (data.voices || []).length }) });
    } catch (e) {
      setStatus({ kind: 'err', text: t('notebook.erroreVerifica', { msg: e instanceof Error ? e.message : String(e) }) });
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setStatus({ kind: '', text: t('notebook.salvataggio') });
    try {
      const payload: Parameters<typeof api.notebook.saveSettings>[0] = {
        provider,
        model,
        voiceA,
        voiceB,
        voiceAName: voiceName(voiceList, voiceA),
        voiceBName: voiceName(voiceList, voiceB),
      };
      if (key.trim()) payload.elevenlabsKey = key.trim();
      const saved = await api.notebook.saveSettings(payload);
      setLocalSettings(saved);
      setStatus({ kind: 'ok', text: t('notebook.salvato') });
      onSaved(saved);
      setTimeout(onClose, 800);
    } catch (e) {
      setStatus({ kind: 'err', text: t('notebook.errore', { msg: e instanceof Error ? e.message : String(e) }) });
    } finally {
      setBusy(false);
    }
  };

  const voiceSelect = (slot: 'voiceA' | 'voiceB', current: string, defId: string, defLabel: string) => {
    if (voiceList.length) {
      return (
        <select className="agynb-inp" style={{ width: '100%' }} value={current || ''} onChange={(e) => (slot === 'voiceA' ? setVoiceA(e.target.value) : setVoiceB(e.target.value))}>
          <option value="">{defLabel}</option>
          {voiceList.map((v) => (
            <option value={v.id} key={v.id}>
              {v.name}
              {v.category ? ` [${v.category}]` : ''}
            </option>
          ))}
        </select>
      );
    }
    return (
      <>
        <input
          type="text"
          className="agynb-inp"
          style={{ width: '100%', fontFamily: 'var(--font-mono, monospace)' }}
          value={current || defId}
          onChange={(e) => (slot === 'voiceA' ? setVoiceA(e.target.value) : setVoiceB(e.target.value))}
          placeholder={defId}
        />
        <div className="agynb-hint">{t('notebook.idVoce', { def: defLabel })}</div>
      </>
    );
  };

  return (
    <div
      className="agynb-settings-modal on"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="agynb-settings-card">
        <div className="agynb-settings-head">
          <div className="agynb-settings-title">
            <NbIcon name="settings" /> {t('notebook.impostazioniTitolo')}
          </div>
          <button type="button" className="agynb-viewer-close" onClick={onClose} aria-label={t('notebook.chiudi')}>
            ×
          </button>
        </div>

        <div className="agynb-field">
          <label className="agynb-label">{t('notebook.motoreLabel')}</label>
          <div className="agynb-provider-cards">
            <div className={`agynb-pcard${provider === 'edge' ? ' on' : ''}`} onClick={() => setProvider('edge')} role="button" tabIndex={0}>
              <div className="agynb-pcard-title">🎙️ {t('notebook.edgeTitolo')}</div>
              <div className="agynb-pcard-desc">{t('notebook.edgeDesc')}</div>
            </div>
            <div className={`agynb-pcard${provider === 'elevenlabs' ? ' on' : ''}`} onClick={() => setProvider('elevenlabs')} role="button" tabIndex={0}>
              <div className="agynb-pcard-title">⚡ {t('notebook.elevenTitolo')}</div>
              <div className="agynb-pcard-desc">{t('notebook.elevenDesc')}</div>
            </div>
          </div>
        </div>

        <div style={provider === 'elevenlabs' ? undefined : { opacity: 0.75 }}>
          <div className="agynb-field">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <label className="agynb-label" htmlFor={`${id}-key`}>
                {t('notebook.chiaveLabel')}
              </label>
              <span style={{ fontSize: '.7rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono, monospace)' }}>{keyHint}</span>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                id={`${id}-key`}
                type="password"
                className="agynb-inp"
                style={{ flex: 1 }}
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={hasKey ? t('notebook.chiavePlaceholderNuova') : 'xi-api-key…'}
              />
              <button type="button" className="agynb-btn" disabled={busy} onClick={() => void testKey()}>
                {busy ? <Spinner /> : null} {t('notebook.verificaCarica')}
              </button>
            </div>
            <div className="agynb-hint">{t('notebook.chiaveNota')}</div>
          </div>

          <div className="agynb-field">
            <label className="agynb-label" htmlFor={`${id}-model`}>
              {t('notebook.modelloLabel')}
            </label>
            <select id={`${id}-model`} className="agynb-inp" style={{ width: '100%' }} value={model} onChange={(e) => setModel(e.target.value)}>
              {localSettings.elevenlabs.models.map((m) => (
                <option value={m} key={m}>
                  {m}
                  {m === 'eleven_multilingual_v2' ? t('notebook.modelloConsigliato') : ''}
                </option>
              ))}
            </select>
          </div>

          <div className="agynb-field">
            <label className="agynb-label">{t('notebook.voce1')}</label>
            {voiceSelect('voiceA', voiceA, 'JBFqnCBsd6RMkjVDRZzb', t('notebook.predefinitaGeorge'))}
          </div>
          <div className="agynb-field">
            <label className="agynb-label">{t('notebook.voce2')}</label>
            {voiceSelect('voiceB', voiceB, 'EXAVITQu4vr4xnAE8sDL', t('notebook.predefinitaSarah'))}
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 22, paddingTop: 14, borderTop: '1px solid var(--border-color, rgba(255,255,255,.08))' }}>
          <div
            style={{ fontSize: '.76rem' }}
            className={status.kind === 'ok' ? 'agynb-ok' : status.kind === 'err' ? 'agynb-err' : ''}
            role={status.kind === 'err' ? 'alert' : undefined}
          >
            {status.text}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="agynb-btn" onClick={onClose}>
              {t('notebook.annulla')}
            </button>
            <button type="button" className="agynb-btn primary" disabled={busy} onClick={() => void save()}>
              {t('notebook.salva')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── sezione ──────────────────────────────────────────────────────────────────
export function NotebookSection() {
  const t = useT();
  const id = useId();

  const [projects, setProjects] = useState<string[]>([]);
  const [workspace, setWorkspace] = useState<string | null>(() => localStorage.getItem(PROJECT_KEY));
  const [notebooks, setNotebooks] = useState<NotebookMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [tab, setTab] = useState<'sources' | 'chat' | 'studio'>('sources');
  const [sources, setSources] = useState<NotebookSource[]>([]);
  const [studio, setStudio] = useState<NotebookStudioItem[]>([]);
  const [chatLog, setChatLog] = useState<NotebookChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err' | ''; text: string }>({ kind: '', text: '' });
  const [health, setHealth] = useState<'checking' | 'ok' | 'ko'>('checking');
  const [settings, setSettings] = useState<NotebookSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [viewer, setViewer] = useState<ViewerState | null>(null);
  const [sideOpen, setSideOpen] = useState(true);

  const [urlInput, setUrlInput] = useState('');
  const [textInput, setTextInput] = useState('');
  const [textTitle, setTextTitle] = useState('');
  const [question, setQuestion] = useState('');
  const [adding, setAdding] = useState<'url' | 'text' | 'file' | null>(null);
  const [busyKind, setBusyKind] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const chatRef = useRef<HTMLDivElement>(null);

  const ws = workspace;
  const active = notebooks.find((n) => n.id === activeId) ?? null;

  const errText = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));

  // progetti disponibili
  useEffect(() => {
    void (async () => {
      try {
        const p = await api.projects();
        const list = [...new Set([...p.recent, ...p.roots])];
        setProjects(list);
        setWorkspace((cur) => (cur && list.includes(cur) ? cur : (list[0] ?? null)));
      } catch {
        /* niente progetti: il selettore resta vuoto */
      }
    })();
  }, []);

  useEffect(() => {
    if (workspace) localStorage.setItem(PROJECT_KEY, workspace);
  }, [workspace]);

  useEffect(() => {
    void (async () => {
      try {
        const h = await api.notebook.health();
        setHealth(h.available ? 'ok' : 'ko');
      } catch {
        setHealth('ko');
      }
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        setSettings(await api.notebook.settings());
      } catch {
        /* impostazioni non leggibili: si resta sul predefinito Edge */
      }
    })();
  }, []);

  const loadNotebooks = useCallback(async () => {
    if (!ws) {
      setNotebooks([]);
      return;
    }
    try {
      const list = await api.notebook.list(ws);
      setNotebooks(list);
      setActiveId((cur) => (cur && list.some((n) => n.id === cur) ? cur : (list[0]?.id ?? null)));
    } catch (e) {
      setNotebooks([]);
      setMsg({ kind: 'err', text: errText(e) });
    }
  }, [ws]);

  useEffect(() => {
    void loadNotebooks();
  }, [loadNotebooks]);

  const loadSources = useCallback(async () => {
    if (!ws || !activeId) return;
    try {
      setSources(await api.notebook.sources(activeId, ws));
    } catch {
      setSources([]);
    }
  }, [ws, activeId]);

  const loadChat = useCallback(async () => {
    if (!ws || !activeId) return;
    try {
      setChatLog(await api.notebook.chat(activeId, ws));
    } catch {
      setChatLog([]);
    }
  }, [ws, activeId]);

  const loadStudio = useCallback(async () => {
    if (!ws || !activeId) return;
    try {
      setStudio(await api.notebook.studio(activeId, ws));
    } catch {
      setStudio([]);
    }
  }, [ws, activeId]);

  useEffect(() => {
    if (tab === 'sources') void loadSources();
    else if (tab === 'chat') void loadChat();
    else void loadStudio();
  }, [tab, loadSources, loadChat, loadStudio]);

  useEffect(() => {
    const box = chatRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [chatLog]);

  const selectNotebook = (nid: string) => {
    setActiveId(nid);
    setSources([]);
    setStudio([]);
    setChatLog([]);
    if (typeof window !== 'undefined' && window.innerWidth <= 768) setSideOpen(false);
  };

  const createNotebook = async () => {
    if (!ws) return;
    const title = prompt(t('notebook.nuovoPrompt'));
    if (!title || !title.trim()) return;
    try {
      const nb = await api.notebook.create(ws, title.trim());
      await loadNotebooks();
      selectNotebook(nb.id);
    } catch (e) {
      setMsg({ kind: 'err', text: t('notebook.erroreCreazione', { msg: errText(e) }) });
    }
  };

  const deleteNotebook = async (nid: string) => {
    if (!ws) return;
    const nb = notebooks.find((n) => n.id === nid);
    if (!confirm(t('notebook.eliminaNotebookConferma', { titolo: nb ? nb.title : nid }))) return;
    try {
      await api.notebook.remove(nid, ws);
      if (activeId === nid) setActiveId(null);
      await loadNotebooks();
    } catch (e) {
      setMsg({ kind: 'err', text: t('notebook.erroreEliminazione', { msg: errText(e) }) });
    }
  };

  // ── fonti ──
  const addSourceCommon = async (payload: Record<string, unknown>) => {
    if (!ws || !activeId) return;
    setMsg({ kind: '', text: '' });
    try {
      await api.notebook.addSource(activeId, { wspath: ws, ...payload });
      setMsg({ kind: 'ok', text: t('notebook.fonteAggiunta') });
      await loadSources();
    } catch (e) {
      setMsg({ kind: 'err', text: errText(e) });
    }
  };

  const addSourceUrl = async () => {
    const url = urlInput.trim();
    if (!url || adding) return;
    setAdding('url');
    try {
      await addSourceCommon({ url });
      setUrlInput('');
    } finally {
      setAdding(null);
    }
  };

  const addSourceText = async () => {
    const text = textInput.trim();
    if (!text || adding) return;
    setAdding('text');
    try {
      await addSourceCommon({ text, title: textTitle.trim() || undefined });
      setTextInput('');
      setTextTitle('');
    } finally {
      setAdding(null);
    }
  };

  const addSourceFile = async (file: File | null | undefined) => {
    if (!file) return;
    setAdding('file');
    try {
      const b64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      await addSourceCommon({ fileName: file.name, fileData: b64 });
    } catch (e) {
      setMsg({ kind: 'err', text: errText(e) });
    } finally {
      setAdding(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const deleteSource = async (name: string) => {
    if (!ws || !activeId) return;
    try {
      await api.notebook.deleteSource(activeId, name, ws);
      await loadSources();
    } catch (e) {
      setMsg({ kind: 'err', text: t('notebook.erroreRimozione', { msg: errText(e) }) });
    }
  };

  const openSource = async (name: string) => {
    if (!ws || !activeId) return;
    setViewer({ name, kind: 'markdown', content: '', wide: false });
    try {
      const data = await api.notebook.sourceContent(activeId, name, ws);
      setViewer({ name, kind: 'markdown', content: data.content, wide: false });
    } catch (e) {
      setViewer({ name, kind: 'markdown', content: t('notebook.errore', { msg: errText(e) }), wide: false });
    }
  };

  // ── chat ──
  const sendQuery = async () => {
    if (!ws || !activeId || !question.trim() || busy) return;
    const q = question.trim();
    setQuestion('');
    setChatLog((log) => [...log, { role: 'q', text: q, ts: Date.now() }, { role: 'a', text: '', ts: Date.now() }]);
    setBusy(true);
    try {
      const data = await api.notebook.query(activeId, ws, q);
      setChatLog((log) => {
        const next = log.slice(0, -1);
        return [...next, { role: 'a', text: data.answer, ts: Date.now() }];
      });
    } catch (e) {
      setChatLog((log) => {
        const next = log.slice(0, -1);
        return [...next, { role: 'a', text: t('notebook.errore', { msg: errText(e) }), ts: Date.now() }];
      });
    } finally {
      setBusy(false);
    }
  };

  // ── studio ──
  const createStudio = async (kind: string) => {
    if (!ws || !activeId || busy) return;
    const meta = STUDIO_TYPES.find((s) => s.kind === kind)!;
    setMsg({ kind: '', text: '' });
    setBusy(true);
    setBusyKind(kind);
    try {
      const res = await api.notebook.createStudio(activeId, ws, kind);
      const provMsg = res.provider === 'elevenlabs' ? t('notebook.vociElevenlabs') : res.provider === 'edge' ? t('notebook.vociEdge') : '';
      setMsg({ kind: 'ok', text: t('notebook.generato', { tipo: t(`notebook.${meta.labelKey}`), provider: provMsg }) });
      await loadStudio();
    } catch (e) {
      setMsg({ kind: 'err', text: errText(e) });
    } finally {
      setBusy(false);
      setBusyKind(null);
    }
  };

  const deleteArtifact = async (name: string) => {
    if (!ws || !activeId || !confirm(t('notebook.eliminaContenuto'))) return;
    try {
      await api.notebook.deleteArtifact(activeId, name, ws);
      await loadStudio();
    } catch (e) {
      setMsg({ kind: 'err', text: t('notebook.erroreEliminazione', { msg: errText(e) }) });
    }
  };

  const openArtifact = async (name: string) => {
    if (!ws || !activeId) return;
    const kind = viewerKind(name);
    setViewer({ name, kind, content: '', wide: kind === 'html' });
    try {
      const data = await api.notebook.artifactContent(activeId, name, ws);
      let blobUrl: string | undefined;
      if (kind === 'html') blobUrl = URL.createObjectURL(new Blob([data.content], { type: 'text/html; charset=utf-8' }));
      setViewer({ name, kind, content: data.content, blobUrl, wide: kind === 'html' });
    } catch (e) {
      setViewer({ name, kind: 'markdown', content: t('notebook.errore', { msg: errText(e) }), wide: false });
    }
  };

  const closeViewer = () => {
    setViewer((v) => {
      if (v?.blobUrl) URL.revokeObjectURL(v.blobUrl);
      return null;
    });
  };

  const downloadArtifact = async (name: string) => {
    if (!ws || !activeId) return;
    try {
      const data = await api.notebook.artifactContent(activeId, name, ws);
      const mime = name.startsWith('infographic-') || name.startsWith('presentation-') || name.endsWith('.html') ? 'text/html' : 'text/markdown';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([data.content], { type: mime }));
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } catch (e) {
      setMsg({ kind: 'err', text: t('notebook.downloadFallito', { msg: errText(e) }) });
    }
  };

  const ttsLabel = settings?.provider === 'elevenlabs' ? 'ElevenLabs' : 'Edge';

  return (
    <div className="agynb">
      <div className={`agynb-side${sideOpen ? '' : ' agynb-side-hidden'}`}>
        <div className="agynb-side-top">
          <div className="agynb-brand-row">
            <div className="agynb-brand">
              <span className="agynb-mark">
                <NbIcon name="notebook" />
              </span>
              <span>{t('notebook.titolo')}</span>
            </div>
            <button type="button" className="agynb-side-close" title={t('notebook.chiudiLista')} onClick={() => setSideOpen(false)}>
              <NbIcon name="close" />
            </button>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6, gap: 8 }}>
            <span className="agynb-health">
              <span className={`agynb-dot ${health === 'ok' ? 'ok' : health === 'ko' ? 'ko' : ''}`} />
              {health === 'checking' ? t('notebook.verifica') : health === 'ok' ? t('notebook.motoreAttivo') : t('notebook.agyNonRisponde')}
            </span>
            <button
              type="button"
              className="agynb-btn"
              title={t('notebook.impostazioniVoci')}
              style={{ padding: '2px 6px', fontSize: '.68rem', background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}
              onClick={() => setSettingsOpen(true)}
            >
              <NbIcon name="settings" />
            </button>
          </div>
          {projects.length > 0 && (
            <select
              className="agynb-inp"
              style={{ width: '100%', marginTop: 8 }}
              value={ws ?? ''}
              onChange={(e) => {
                setWorkspace(e.target.value);
                setActiveId(null);
              }}
              aria-label={t('notebook.progetto')}
            >
              {projects.map((p) => (
                <option value={p} key={p}>
                  {p}
                </option>
              ))}
            </select>
          )}
          <button type="button" className="agynb-newbtn" onClick={() => void createNotebook()} disabled={!ws}>
            <NbIcon name="plus" /> {t('notebook.nuovo')}
          </button>
        </div>
        <div className="agynb-nblist">
          {!ws ? (
            <div className="agynb-empty-side">{t('notebook.ambienteNonRilevato')}</div>
          ) : notebooks.length === 0 ? (
            <div className="agynb-empty-side">{t('notebook.nessunNotebook')}</div>
          ) : (
            notebooks.map((n) => (
              <div className={`agynb-nbitem${n.id === activeId ? ' on' : ''}`} key={n.id} onClick={() => selectNotebook(n.id)}>
                <span className="t">{n.title || t('notebook.senzaTitolo')}</span>
                <button
                  type="button"
                  className="agynb-del"
                  title={t('notebook.elimina')}
                  onClick={(e) => {
                    e.stopPropagation();
                    void deleteNotebook(n.id);
                  }}
                >
                  <NbIcon name="trash" />
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      <button type="button" className={`agynb-side-open${sideOpen ? '' : ' show'}`} title={t('notebook.titolo')} onClick={() => setSideOpen(true)}>
        <NbIcon name="list" />
      </button>

      <div className="agynb-main">
        {!active ? (
          <div className="agynb-empty">
            <NbIcon name="notebook" className="agynb-empty-icon" />
            <p>{t('notebook.selezionaNotebook')}</p>
          </div>
        ) : (
          <>
            <div className="agynb-nbheader">
              <span className="agynb-nbtitle">{active.title}</span>
            </div>
            <div className="agynb-tabs" role="tablist">
              {(['sources', 'chat', 'studio'] as const).map((k) => (
                <button type="button" key={k} className={`agynb-tab${tab === k ? ' on' : ''}`} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
                  {k === 'sources' ? t('notebook.tabFonti') : k === 'chat' ? t('notebook.tabChat') : t('notebook.tabStudio')}
                </button>
              ))}
            </div>

            {tab === 'sources' && (
              <div className="agynb-pane on">
                <div className="agynb-card">
                  <div className="agynb-row" style={{ marginBottom: 8 }}>
                    <input
                      type="text"
                      className="agynb-inp"
                      placeholder={t('notebook.urlPlaceholder')}
                      value={urlInput}
                      onChange={(e) => setUrlInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void addSourceUrl();
                      }}
                    />
                    <button type="button" className="agynb-btn" disabled={adding !== null} onClick={() => void addSourceUrl()}>
                      {adding === 'url' ? <Spinner /> : <NbIcon name="link" />} {t('notebook.aggiungiUrl')}
                    </button>
                  </div>
                  <div className="agynb-row" style={{ marginBottom: 8 }}>
                    <input
                      type="file"
                      ref={fileRef}
                      hidden
                      accept=".pdf,.txt,.md,.docx,.csv"
                      onChange={(e) => void addSourceFile(e.target.files && e.target.files[0])}
                    />
                    <button type="button" className="agynb-btn" disabled={adding !== null} onClick={() => fileRef.current?.click()}>
                      {adding === 'file' ? <Spinner /> : <NbIcon name="upload" />} {t('notebook.caricaFile')}
                    </button>
                  </div>
                  <textarea
                    className="agynb-inp"
                    style={{ minHeight: 70, width: '100%', resize: 'vertical', marginBottom: 6 }}
                    placeholder={t('notebook.testoPlaceholder')}
                    value={textInput}
                    onChange={(e) => setTextInput(e.target.value)}
                  />
                  <div className="agynb-row">
                    <input
                      type="text"
                      className="agynb-inp"
                      placeholder={t('notebook.titoloOpzionale')}
                      value={textTitle}
                      onChange={(e) => setTextTitle(e.target.value)}
                    />
                    <button type="button" className="agynb-btn" disabled={adding !== null} onClick={() => void addSourceText()}>
                      {adding === 'text' ? <Spinner /> : <NbIcon name="doc" />} {t('notebook.aggiungiTesto')}
                    </button>
                  </div>
                </div>
                <div>
                  {sources.length === 0 ? (
                    <p className="agynb-muted">{t('notebook.nessunaFonte')}</p>
                  ) : (
                    sources.map((s) => (
                      <div className="agynb-src" key={s.name} onClick={() => void openSource(s.name)}>
                        <span className="t" title={s.name}>
                          {s.name}
                        </span>
                        <button
                          type="button"
                          className="agynb-del"
                          title={t('notebook.rimuovi')}
                          onClick={(e) => {
                            e.stopPropagation();
                            void deleteSource(s.name);
                          }}
                        >
                          <NbIcon name="trash" />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}

            {tab === 'chat' && (
              <div className="agynb-pane on agynb-pane-flex">
                <div className="agynb-chatlog" ref={chatRef} style={{ flex: 1, overflowY: 'auto' }}>
                  {chatLog.length === 0 ? (
                    <p className="agynb-muted">{t('notebook.chatHint')}</p>
                  ) : (
                    chatLog.map((m, i) => (
                      <div className={`agynb-msg ${m.role}`} key={i}>
                        {m.role === 'a' && !m.text && busy && i === chatLog.length - 1 ? (
                          <span className="agynb-thinking">
                            <span />
                            <span />
                            <span />
                          </span>
                        ) : m.role === 'a' ? (
                          <Markdown text={m.text} chat />
                        ) : (
                          m.text
                        )}
                      </div>
                    ))
                  )}
                </div>
                <div className="agynb-row">
                  <input
                    type="text"
                    className="agynb-inp"
                    placeholder={t('notebook.domandaPlaceholder')}
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        void sendQuery();
                      }
                    }}
                  />
                  <button type="button" className="agynb-btn primary" disabled={busy} onClick={() => void sendQuery()}>
                    <NbIcon name="send" /> {t('notebook.chiedi')}
                  </button>
                </div>
              </div>
            )}

            {tab === 'studio' && (
              <div className="agynb-pane on">
                <div className="agynb-card">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10, gap: 10 }}>
                    <p className="agynb-muted" style={{ margin: 0 }}>
                      {t('notebook.studioHint')}
                    </p>
                    <button type="button" className="agynb-btn" style={{ padding: '4px 9px', fontSize: '.72rem', flexShrink: 0 }} onClick={() => setSettingsOpen(true)}>
                      <NbIcon name="settings" /> {t('notebook.vociLabel', { provider: ttsLabel })}
                    </button>
                  </div>
                  <div className="agynb-row">
                    {STUDIO_TYPES.map((s) => (
                      <button type="button" className="agynb-btn" disabled={busy} key={s.kind} onClick={() => void createStudio(s.kind)}>
                        {busyKind === s.kind ? <Spinner /> : <NbIcon name={s.icon} />} {t(`notebook.${s.labelKey}`)}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  {studio.length === 0 ? (
                    <p className="agynb-muted">{t('notebook.nessunContenutoStudio')}</p>
                  ) : (
                    studio.map((a) => {
                      const meta = STUDIO_TYPES.find((s) => s.kind === a.kind) ?? STUDIO_TYPES[0]!;
                      return (
                        <div className="agynb-art" key={a.name} onClick={() => void openArtifact(a.name)}>
                          <NbIcon name={meta.icon} className="k" />
                          <span className="t">{t(`notebook.${meta.labelKey}`)}</span>
                          <span className="meta">{new Date(a.mtime).toLocaleString()}</span>
                          <button
                            type="button"
                            className="agynb-del"
                            title={t('notebook.elimina')}
                            onClick={(e) => {
                              e.stopPropagation();
                              void deleteArtifact(a.name);
                            }}
                          >
                            <NbIcon name="trash" />
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            )}

            {msg.text && (
              <div style={{ padding: '0 18px 14px' }}>
                <div className={`agynb-msgbar on ${msg.kind}`} role={msg.kind === 'err' ? 'alert' : undefined}>
                  {msg.text}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {viewer && (
        <div
          className="agynb-viewer on"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeViewer();
          }}
        >
          <div className={`agynb-viewer-card${viewer.wide ? ' wide' : ''}`}>
            <div className="agynb-viewer-head">
              <span>{viewer.name}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {viewer.kind === 'html' && viewer.blobUrl && (
                  <button
                    type="button"
                    className="agynb-btn"
                    style={{ padding: '4px 9px', fontSize: '.74rem' }}
                    onClick={() => window.open(viewer.blobUrl, '_blank')}
                  >
                    <NbIcon name="external" /> {t('notebook.nuovaScheda')}
                  </button>
                )}
                <button type="button" className="agynb-viewer-close" aria-label={t('notebook.chiudi')} onClick={closeViewer}>
                  ×
                </button>
              </div>
            </div>
            <div className="agynb-viewer-body">
              {viewer.kind === 'html' && viewer.blobUrl ? (
                <iframe className="agynb-viewer-iframe" sandbox="allow-scripts allow-modals" src={viewer.blobUrl} title={viewer.name} />
              ) : viewer.kind === 'flashcards' ? (
                <Flashcards content={viewer.content} />
              ) : viewer.kind === 'mindmap' ? (
                <MindMap code={(viewer.content.match(/```mermaid\n([\s\S]*?)```/)?.[1] ?? viewer.content).trim()} />
              ) : viewer.content ? (
                <Markdown text={viewer.content} />
              ) : (
                <p className="agynb-muted">{t('notebook.caricamento')}</p>
              )}
            </div>
            <div className="agynb-viewer-foot">
              <button type="button" className="agynb-btn" onClick={() => void downloadArtifact(viewer.name)}>
                <NbIcon name="download" /> {t('notebook.scarica')}
              </button>
            </div>
          </div>
        </div>
      )}

      {settingsOpen && settings && (
        <SettingsModal
          settings={settings}
          voices={[]}
          onClose={() => setSettingsOpen(false)}
          onSaved={(s) => setSettings(s)}
        />
      )}
    </div>
  );
}
