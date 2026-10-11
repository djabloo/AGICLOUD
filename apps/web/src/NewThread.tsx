import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { AgentInfo, DesignCatalog, DesignChoice } from './api';
import { ProjectPicker } from './ProjectPicker';
import { loadDesignCatalog } from './DesignPreview';
import { t, useT } from './i18n';

interface Props {
  open: boolean;
  agents: AgentInfo[];
  error?: string;
  busy: boolean;
  /** Skill/design system gia' scelti (es. "Prova" dalla galleria Design) */
  preset?: DesignChoice | null;
  /** Plugin Design attivo: si puo' scegliere una conversazione di design */
  designEnabled?: boolean;
  onClose: () => void;
  onCreate: (agentId: string, cwd: string, lead: boolean, design: DesignChoice | null) => void;
}

const LAST_AGENT_KEY = 'agicloud_last_agent';

function lastAgent(): string {
  try {
    return localStorage.getItem(LAST_AGENT_KEY) ?? '';
  } catch {
    return '';
  }
}

/** Dialogo nativo: trappola del focus, Esc e ritorno del focus li gestisce il browser */
export function NewThreadDialog({ open, agents, error, busy, preset, designEnabled = true, onClose, onCreate }: Props) {
  const t = useT();
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [agentId, setAgentId] = useState('');
  const [cwd, setCwd] = useState('');
  const [lead, setLead] = useState(false);
  const [designOn, setDesignOn] = useState(false);
  const [skill, setSkill] = useState('');
  const [system, setSystem] = useState('');
  const [catalog, setCatalog] = useState<DesignCatalog | null>(null);
  const [catalogError, setCatalogError] = useState('');

  // Ogni apertura riparte dalla scelta della galleria (o da nessun design)
  useEffect(() => {
    if (!open) return;
    setDesignOn(Boolean(preset?.skill || preset?.system));
    setSkill(preset?.skill ?? '');
    setSystem(preset?.system ?? '');
  }, [open, preset]);

  useEffect(() => {
    if (!designOn || catalog) return;
    loadDesignCatalog()
      .then((c) => {
        setCatalog(c);
        setCatalogError('');
      })
      .catch((err) => setCatalogError(err instanceof Error ? err.message : String(err)));
  }, [designOn, catalog]);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  useEffect(() => {
    if (agentId || !agents.length) return;
    const last = lastAgent();
    setAgentId(agents.some((a) => a.id === last) ? last : (agents.find((a) => a.id === 'claude') ?? agents[0]!).id);
  }, [agents, agentId]);

  const selected = agents.find((a) => a.id === agentId);
  /** Capo: agenti che ricevono gli strumenti MCP di AgiCloud */
  const canLead = ['claude', 'cursor', 'opencode', 'agy'].includes(agentId);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!agentId || !cwd.trim()) return;
    try {
      localStorage.setItem(LAST_AGENT_KEY, agentId);
    } catch {
      /* solo una comodita' */
    }
    onCreate(agentId, cwd.trim(), canLead && lead, designEnabled && designOn && (skill || system) ? { skill: skill || undefined, system: system || undefined } : null);
  };

  return (
    <dialog ref={ref} className="dialog" aria-labelledby={`${id}-title`} onClose={onClose}>
      <form onSubmit={submit}>
        <h2 id={`${id}-title`}>{t('nuovothread.nuovaConversazione')}</h2>

        <fieldset>
          <legend>{t('nuovothread.agente')}</legend>
          <div className="agent-options">
            {agents.map((a) => (
              <label key={a.id} className="agent-option">
                <input
                  type="radio"
                  name="agent"
                  value={a.id}
                  checked={agentId === a.id}
                  onChange={() => setAgentId(a.id)}
                />
                <span>{a.label}</span>
              </label>
            ))}
          </div>
          {selected?.note && <p className="hint">{selected.note}</p>}
        </fieldset>

        {canLead && (
          <label className="choice lead-choice">
            <input type="checkbox" checked={lead} onChange={(e) => setLead(e.target.checked)} aria-describedby={`${id}-lead-hint`} />
            <span className="choice-text">
              <span>{t('nuovothread.conversazioneCapo')}</span>
              <span className="hint" id={`${id}-lead-hint`}>
                {t('nuovothread.capoSpiegazione')}
                {agentId === 'agy' && t('nuovothread.agyNota')}
                {agentId === 'cursor' && t('nuovothread.cursorNota')}
              </span>
            </span>
          </label>
        )}

        {designEnabled && (
        <label className="choice">
          <input type="checkbox" checked={designOn} onChange={(e) => setDesignOn(e.target.checked)} aria-describedby={`${id}-design-hint`} />
          <span className="choice-text">
            <span>{t('nuovothread.conversazioneDesign')}</span>
            <span className="hint" id={`${id}-design-hint`}>
              {t('nuovothread.designSpiegazione')}
            </span>
          </span>
        </label>
        )}

        {designEnabled && designOn && <DesignFields catalog={catalog} error={catalogError} skill={skill} system={system} onSkill={setSkill} onSystem={setSystem} />}

        <ProjectPicker active={open} cwd={cwd} onChange={setCwd} />

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {t('nuovothread.annulla')}
          </button>
          <button type="submit" className="btn primary" disabled={busy || !agentId || !cwd.trim()}>
            {busy ? t('nuovothread.avvio') : t('nuovothread.inizia')}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function modeLabel(mode: string): string {
  if (mode === 'prototype') return t('nuovothread.paginePrototipi');
  if (mode === 'deck') return t('nuovothread.presentazioni');
  if (mode === 'template') return t('nuovothread.modelliPronti');
  if (mode === 'design-system') return t('nuovothread.designSystemBrief');
  return mode;
}

function groupBy<T>(items: T[], key: (t: T) => string): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const it of items) groups.set(key(it), [...(groups.get(key(it)) ?? []), it]);
  return [...groups];
}

function DesignFields(props: {
  catalog: DesignCatalog | null;
  error: string;
  skill: string;
  system: string;
  onSkill: (v: string) => void;
  onSystem: (v: string) => void;
}) {
  const t = useT();
  const { catalog, error, skill, system } = props;
  const id = useId();
  if (error) return <p className="form-error" role="alert">{t('nuovothread.catalogoNonDisponibile', { errore: error })}</p>;
  if (!catalog) return <p className="hint">{t('nuovothread.caricamentoCatalogo')}</p>;
  const sk = catalog.skills.find((s) => s.id === skill);
  const sys = catalog.systems.find((s) => s.id === system);
  return (
    <div className="design-choice">
      <label>
        {t('nuovothread.skill')}
        <select value={skill} onChange={(e) => props.onSkill(e.target.value)} aria-describedby={`${id}-skill`}>
          <option value="">{t('nuovothread.nessuna')}</option>
          {groupBy(catalog.skills, (s) => modeLabel(s.mode)).map(([group, skills]) => (
            <optgroup key={group} label={group}>
              {skills.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      <p className="hint" id={`${id}-skill`}>
        {sk ? sk.description : t('nuovothread.modoLavoro')}
        {sk?.needsSystem && !system && t('nuovothread.rendeMeglio')}
      </p>
      <label>
        {t('nuovothread.designSystem')}
        <select value={system} onChange={(e) => props.onSystem(e.target.value)} aria-describedby={`${id}-system`}>
          <option value="">{t('nuovothread.nessuno')}</option>
          {groupBy(catalog.systems, (s) => s.category).map(([group, systems]) => (
            <optgroup key={group} label={group}>
              {systems.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      <p className="hint" id={`${id}-system`}>
        {sys ? sys.description : t('nuovothread.stileSpiegazione')}
      </p>
    </div>
  );
}
