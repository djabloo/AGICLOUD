// Sezione Design: galleria di design system e skill di Open Design.
// "Prova" apre la nuova conversazione con la scelta gia' fatta. Le anteprime girano in iframe
// sandbox (senza allow-same-origin): l'URL viene chiesto solo quando serve, mai all'avvio.

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { api, type DesignCatalog, type DesignChoice } from './api';
import { loadDesignCatalog } from './DesignPreview';
import { useT, type t as translate } from './i18n';
import './design-gallery.css';

type SystemItem = DesignCatalog['systems'][number];
type SkillItem = DesignCatalog['skills'][number];
type TabKey = 'systems' | 'skills';
type Detail = { kind: TabKey; item: SystemItem | SkillItem };

/** Etichette delle modalita' delle skill (come nel dialogo di nuova conversazione) */
function getModeLabel(t: typeof translate, mode: string): string {
  switch (mode) {
    case 'prototype': return t('design.modePrototype');
    case 'deck': return t('design.modeDeck');
    case 'template': return t('design.modeTemplate');
    case 'design-system': return t('design.modeDesignSystem');
    default: return mode;
  }
}

/** URL di anteprima richiesto una sola volta per elemento, anche cambiando scheda o filtro */
const previewCache = new Map<string, Promise<string>>();

function previewBase(key: string, target: { system: string } | { skill: string }): Promise<string> {
  let cached = previewCache.get(key);
  if (!cached) {
    cached = api.designPreview(target).then((r) => r.url).catch((err) => {
      previewCache.delete(key); // riprova alla prossima richiesta
      throw err;
    });
    previewCache.set(key, cached);
  }
  return cached;
}

export function DesignView({ onTry }: { onTry: (choice: DesignChoice) => void }) {
  const t = useT();
  const id = useId();
  const [catalog, setCatalog] = useState<DesignCatalog | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<TabKey>('systems');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [detail, setDetail] = useState<Detail | null>(null);
  const tabsRef = useRef<Record<TabKey, HTMLButtonElement | null>>({ systems: null, skills: null });
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    loadDesignCatalog()
      .then(setCatalog)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  // Ritorno del focus sul pulsante "Dettagli" quando il dialogo si chiude
  useEffect(() => {
    if (detail) return;
    const opener = openerRef.current;
    openerRef.current = null;
    if (opener && document.contains(opener)) opener.focus();
  }, [detail]);

  const items = tab === 'systems' ? (catalog?.systems ?? []) : (catalog?.skills ?? []);
  const categories = useMemo(() => {
    const values = tab === 'systems'
      ? (catalog?.systems ?? []).map((s) => s.category)
      : (catalog?.skills ?? []).map((s) => s.mode);
    return [...new Set(values)].sort((a, b) => categoryLabel(tab, a, t).localeCompare(categoryLabel(tab, b, t)));
  }, [tab, catalog, t]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((it) => {
      if (q && !`${it.name} ${it.description}`.toLowerCase().includes(q)) return false;
      if (!category) return true;
      return tab === 'systems' ? (it as SystemItem).category === category : (it as SkillItem).mode === category;
    });
  }, [items, query, category, tab]);

  /** Cambio scheda: il filtro per categoria vale solo per la scheda corrente */
  const switchTab = (next: TabKey) => {
    if (next === tab) return;
    setTab(next);
    setCategory('');
    tabsRef.current[next]?.focus();
  };

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'Home') switchTab('systems');
    else if (e.key === 'End') switchTab('skills');
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') switchTab(tab === 'systems' ? 'skills' : 'systems');
  };

  const openDetail = (kind: TabKey, item: SystemItem | SkillItem) => {
    openerRef.current = document.activeElement as HTMLElement | null;
    setDetail({ kind, item });
  };

  // "Prova" dal dettaglio: prima chiude il dialogo, poi apre la nuova conversazione
  const tryFromDetail = (choice: DesignChoice) => {
    setDetail(null);
    onTry(choice);
  };

  return (
    <section className="design-gallery" aria-labelledby="design-title">
      <div className="design-head">
        <h1 id="design-title">{t('design.title')}</h1>
        <p>{t('design.subtitle')}</p>
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>

      {!catalog && !error && (
        <div className="design-body">
          <p className="hint">{t('design.catalogLoading')}</p>
        </div>
      )}

      {catalog && (
        <div className="design-body">
          <div className="gal-tabs" role="tablist" aria-label={t('design.contentType')}>
            <button
              type="button"
              role="tab"
              id={`${id}-tab-systems`}
              className="gal-tab"
              aria-selected={tab === 'systems'}
              aria-controls={`${id}-panel`}
              tabIndex={tab === 'systems' ? 0 : -1}
              ref={(el) => {
                tabsRef.current.systems = el;
              }}
              onClick={() => switchTab('systems')}
              onKeyDown={onTabKey}
            >
              {t('design.systemsTab')}
            </button>
            <button
              type="button"
              role="tab"
              id={`${id}-tab-skills`}
              className="gal-tab"
              aria-selected={tab === 'skills'}
              aria-controls={`${id}-panel`}
              tabIndex={tab === 'skills' ? 0 : -1}
              ref={(el) => {
                tabsRef.current.skills = el;
              }}
              onClick={() => switchTab('skills')}
              onKeyDown={onTabKey}
            >
              {t('design.skillsTab')}
            </button>
          </div>

          <div className="gal-controls">
            <div className="gal-filters">
              <label className="gal-field" htmlFor={`${id}-q`}>
                <span>{t('design.search')}</span>
                <input
                  id={`${id}-q`}
                  type="search"
                  value={query}
                  placeholder={t('design.searchPlaceholder')}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
              <label className="gal-field" htmlFor={`${id}-cat`}>
                <span>{t('design.category')}</span>
                <select id={`${id}-cat`} value={category} onChange={(e) => setCategory(e.target.value)}>
                  <option value="">{t('design.all')}</option>
                  {categories.map((c) => (
                    <option key={c} value={c}>
                      {categoryLabel(tab, c, t)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="gal-count hint" role="status">
              {t('design.count', { n: filtered.length })}
            </p>
          </div>

          <div
            role="tabpanel"
            id={`${id}-panel`}
            aria-labelledby={`${id}-tab-${tab}`}
            tabIndex={0}
            className="gal-panel"
          >
            {filtered.length === 0 ? (
              <p className="gal-empty">{t('design.empty')}</p>
            ) : tab === 'systems' ? (
              <ul className="gal-grid">
                {filtered.map((s) => {
                  const sys = s as SystemItem;
                  return (
                    <SystemCard
                      key={sys.id}
                      item={sys}
                      onTry={onTry}
                      onOpen={() => openDetail('systems', sys)}
                    />
                  );
                })}
              </ul>
            ) : (
              <ul className="gal-grid">
                {filtered.map((s) => {
                  const sk = s as SkillItem;
                  return (
                    <SkillCard key={sk.id} item={sk} onTry={onTry} onOpen={() => openDetail('skills', sk)} />
                  );
                })}
              </ul>
            )}
          </div>

          <p className="gal-credit hint">
            {t('design.creditPre')}{' '}
            <a href={catalog.source.repo} target="_blank" rel="noopener noreferrer">
              Open Design
            </a>{' '}
            {t('design.creditPost')}
          </p>
        </div>
      )}

      {detail && catalog && (
        <DetailDialog
          kind={detail.kind}
          item={detail.item}
          catalog={catalog}
          onTry={tryFromDetail}
          onClose={() => setDetail(null)}
        />
      )}
    </section>
  );
}

/** Etichetta della categoria: per le skill vale la modalita' tradotta */
function categoryLabel(tab: TabKey, value: string, t: typeof translate): string {
  return tab === 'skills' ? getModeLabel(t, value) : value;
}

function SystemCard({ item, onTry, onOpen }: {
  item: SystemItem;
  onTry: (c: DesignChoice) => void;
  onOpen: () => void;
}) {
  const t = useT();
  // Miniatura: la prima pagina di anteprima, altrimenti il kit dei componenti
  const thumb = item.previews[0] ? `preview/${item.previews[0]}` : item.kit ? 'system/kit.html' : '';
  return (
    <li className="gal-card">
      {thumb && <Thumb id={item.id} page={thumb} label={item.name} />}
      <div className="gal-body">
        <h3 className="gal-name">{item.name}</h3>
        <p className="gal-cat">{item.category}</p>
        <p className="gal-desc">{item.description}</p>
        <div className="gal-actions">
          <button type="button" className="btn primary" onClick={() => onTry({ system: item.id })}>
            {t('design.try')}
          </button>
          <button type="button" className="btn" onClick={onOpen}>
            {t('design.details')}
          </button>
        </div>
      </div>
    </li>
  );
}

function SkillCard({ item, onTry, onOpen }: {
  item: SkillItem;
  onTry: (c: DesignChoice) => void;
  onOpen: () => void;
}) {
  const t = useT();
  return (
    <li className="gal-card">
      <div className="gal-body">
        {item.emoji && (
          <span className="gal-emoji" aria-hidden="true">
            {item.emoji}
          </span>
        )}
        <h3 className="gal-name">{item.name}</h3>
        <p className="gal-cat">{getModeLabel(t, item.mode)}</p>
        <p className="gal-desc">{item.description}</p>
        <div className="gal-actions">
          <button type="button" className="btn primary" onClick={() => onTry({ skill: item.id })}>
            {t('design.try')}
          </button>
          <button type="button" className="btn" onClick={onOpen}>
            {t('design.details')}
          </button>
        </div>
      </div>
    </li>
  );
}

/** Miniatura decorativa: caricata solo quando la scheda entra nello schermo */
function Thumb({ id, page, label }: { id: string; page: string; label: string }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [src, setSrc] = useState('');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: '160px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let stop = false;
    previewBase(`system:${id}`, { system: id })
      .then((base) => {
        if (!stop) setSrc(`${base}${page}`);
      })
      .catch(() => {
        if (!stop) setFailed(true);
      });
    return () => {
      stop = true;
    };
  }, [visible, id, page]);

  return (
    <div className="gal-thumb" ref={ref} aria-hidden="true">
      {src ? (
        <iframe
          className="gal-thumb-frame"
          src={src}
          title={t('design.thumbTitle', { label })}
          loading="lazy"
          sandbox="allow-scripts"
          tabIndex={-1}
        />
      ) : (
        <span className="hint">{failed ? t('design.thumbUnavailable') : t('design.thumbLoading')}</span>
      )}
    </div>
  );
}

/** Dialogo nativo dei dettagli: anteprima grande, descrizione e "Prova" */
function DetailDialog({ kind, item, catalog, onTry, onClose }: {
  kind: TabKey;
  item: SystemItem | SkillItem;
  catalog: DesignCatalog;
  onTry: (c: DesignChoice) => void;
  onClose: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const system = kind === 'systems' ? (item as SystemItem) : null;
  const skill = kind === 'skills' ? (item as SkillItem) : null;
  const pages = system
    ? [...system.previews.map((p) => `preview/${p}`), ...(system.kit ? ['system/kit.html'] : [])]
    : skill?.example
      ? ['example.html']
      : [];
  const [page, setPage] = useState(pages[0] ?? '');
  const [base, setBase] = useState('');
  const [previewError, setPreviewError] = useState('');
  const [systemChoice, setSystemChoice] = useState('');

  // Il dialogo nativo gestisce trappola del focus, Esc e ritorno del focus
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  // L'URL di anteprima viene chiesto solo qui, con il dettaglio aperto
  useEffect(() => {
    if (!pages.length) return;
    let stop = false;
    previewBase(`${kind}:${item.id}`, kind === 'systems' ? { system: item.id } : { skill: item.id })
      .then((u) => {
        if (!stop) setBase(u);
      })
      .catch((err) => {
        if (!stop) setPreviewError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      stop = true;
    };
  }, [kind, item.id, pages.length]);

  const tryIt = () =>
    onTry(skill ? { skill: skill.id, system: systemChoice || undefined } : { system: system!.id });

  return (
    <dialog ref={ref} className="dialog gal-dialog" aria-labelledby={`${id}-title`} onClose={onClose}>
      <div className="gal-detail">
        <div className="gal-detail-head">
          <h2 id={`${id}-title`}>{item.name}</h2>
          <p className="gal-cat">{skill ? getModeLabel(t, skill.mode) : system!.category}</p>
        </div>
        <p>{item.description}</p>
        {item.craft.length > 0 && <p className="hint">{t('design.crafts', { crafts: item.craft.join(', ') })}</p>}
        {skill?.examplePrompt && <p className="hint">{t('design.examplePrompt', { p: skill.examplePrompt })}</p>}

        {pages.length > 1 && (
          <label className="gal-field" htmlFor={`${id}-page`}>
            <span>{t('design.page')}</span>
            <select id={`${id}-page`} value={page} onChange={(e) => setPage(e.target.value)}>
              {pages.map((p) => (
                <option key={p} value={p}>
                  {p.split('/').pop()}
                </option>
              ))}
            </select>
          </label>
        )}

        {previewError && (
          <p className="form-error" role="alert">
            {previewError}
          </p>
        )}
        {!previewError && pages.length > 0 && !base && <p className="hint">{t('design.previewLoading')}</p>}
        {base && page && (
          <iframe
            className="gal-frame"
            src={`${base}${page}`}
            title={t('design.previewOf', { nome: item.name })}
            loading="lazy"
            sandbox="allow-scripts"
          />
        )}

        {skill?.needsSystem && (
          <>
            <label className="gal-field" htmlFor={`${id}-system`}>
              <span>{t('design.systemToUse')}</span>
              <select
                id={`${id}-system`}
                value={systemChoice}
                onChange={(e) => setSystemChoice(e.target.value)}
                aria-describedby={`${id}-system-hint`}
              >
                <option value="">{t('design.none')}</option>
                {catalog.systems.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <p className="hint" id={`${id}-system-hint`}>
              {t('design.systemHint')}
            </p>
          </>
        )}

        <div className="dialog-actions">
          <button type="button" className="btn" onClick={() => ref.current?.close()}>
            {t('design.close')}
          </button>
          <button type="button" className="btn primary" onClick={tryIt}>
            {t('design.try')}
          </button>
        </div>
      </div>
    </dialog>
  );
}
