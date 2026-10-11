// Plugin Cloud: i server Hetzner, le immagini e i costi; nuove VPS da un'immagine.
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { api, type CloudBuildJob, type CloudImage, type CloudOverview, type CloudServer } from './api';
import { copyText } from './termText';
import { fmtDate, fmtNumber, useT, type t as tFn } from './i18n';

type T = typeof tFn;

const eur = (n: number) => fmtNumber(n, { style: 'currency', currency: 'EUR' });
const date = (s: string) => fmtDate(new Date(s));

function getStatusLabel(t: T, status: string): string {
  switch (status) {
    case 'running':
      return t('cloud.statoRunning');
    case 'off':
      return t('cloud.statoOff');
    case 'starting':
      return t('cloud.statoStarting');
    case 'stopping':
      return t('cloud.statoStopping');
    case 'initializing':
      return t('cloud.statoInitializing');
    case 'rebuilding':
      return t('cloud.statoRebuilding');
    case 'migrating':
      return t('cloud.statoMigrating');
    case 'deleting':
      return t('cloud.statoDeleting');
    default:
      return status;
  }
}

export function CloudView() {
  const t = useT();
  const id = useId();
  const [data, setData] = useState<CloudOverview | null>(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [newFrom, setNewFrom] = useState<string | null>(null);
  const [newNode, setNewNode] = useState(false);

  const load = async () => {
    try {
      setData(await api.cloud());
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  useEffect(() => {
    void load();
  }, []);
  // Mentre un server cambia stato si ricontrolla ogni pochi secondi
  const changing = data?.servers.some((s) => s.status !== 'running' && s.status !== 'off');
  useEffect(() => {
    if (!changing) return;
    const tm = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(tm);
  }, [changing]);

  const act = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key);
    setMsg('');
    setError('');
    try {
      await fn();
      setMsg(done);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="cloud" aria-labelledby={`${id}-title`}>
      <header className="chat-header">
        <div className="chat-heading">
          <h1 id={`${id}-title`}>{t('cloud.titolo')}</h1>
          <p className="chat-meta">{data ? t('cloud.costoStimato', { costo: eur(data.monthlyTotal) }) : t('cloud.hetzner')}</p>
        </div>
        <button type="button" className="btn small-btn" onClick={() => void load()}>
          {t('cloud.aggiorna')}
        </button>
      </header>

      <div className="pii-body">
        <div aria-live="polite" className="pii-msg-wrap">
          {msg && <p className="pii-msg pii-msg-ok">{msg}</p>}
        </div>
        {error && (
          <p className="pii-msg pii-msg-err" role="alert">
            {error}
          </p>
        )}
        {!data && !error && <p className="hint">{t('cloud.caricamento')}</p>}

        {data && (
          <>
            <NodeImageSection data={data} onChanged={load} onNewNode={() => setNewNode(true)} />

            <section className="pii-card" aria-labelledby={`${id}-srv`}>
              <div className="group-head">
                <h2 id={`${id}-srv`}>{t('cloud.serverTitolo')}</h2>
                <button type="button" className="btn small-btn primary" onClick={() => setNewFrom('ubuntu-24.04')}>
                  {t('cloud.nuovaVps')}
                </button>
              </div>
              <ul className="cloud-list">
                {data.servers.map((s) => (
                  <li key={s.id}>
                    <ServerCard server={s} images={data.images} busy={busy} act={act} />
                  </li>
                ))}
              </ul>
            </section>

            <section className="pii-card" aria-labelledby={`${id}-img`}>
              <h2 id={`${id}-img`}>{t('cloud.immaginiTitolo')}</h2>
              <p className="hint">{t('cloud.immaginiHint')}</p>
              <div className="cloud-table-wrap">
                <table className="pii-table cloud-table">
                  <caption className="visually-hidden">{t('cloud.caption')}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('cloud.thImmagine')}</th>
                      <th scope="col">{t('cloud.thData')}</th>
                      <th scope="col">{t('cloud.thDimensione')}</th>
                      <th scope="col">{t('cloud.thCosto')}</th>
                      <th scope="col">
                        <span className="visually-hidden">Azioni</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.images.map((i) => (
                      <tr key={i.id}>
                        <td>
                          {i.type === 'backup' ? t('cloud.backupLabel') : t('cloud.snapshotLabel')} · {i.description}
                          {i.from && <span className="hint"> · {t('cloud.da', { x: i.from })}</span>}
                          {i.nodeImage && <span className="cloud-badge">{t('cloud.badgeNodi')}</span>}
                          {i.agicloudNode && <span className="cloud-badge cloud-badge-prod">{t('cloud.badgeProd')}</span>}
                        </td>
                        <td>{date(i.created)}</td>
                        <td>{t('cloud.gbValue', { v: fmtNumber(i.sizeGb, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })}</td>
                        <td>{i.type === 'snapshot' ? eur(i.monthly) : t('cloud.compreso')}</td>
                        <td className="cloud-actions">
                          <button type="button" className="btn small-btn" onClick={() => setNewFrom(String(i.id))}>
                            {t('cloud.nuovaDaQui')}
                          </button>
                          {i.type === 'snapshot' && !i.nodeImage && !i.agicloudNode && (
                            <button
                              type="button"
                              className="btn small-btn"
                              disabled={busy !== null}
                              onClick={() => {
                                if (confirm(t('cloud.confirmEliminaSnap', { d: i.description }))) {
                                  void act(`img-${i.id}`, () => api.cloudDeleteImage(i.id), t('cloud.snapEliminato'));
                                }
                              }}
                            >
                              {t('cloud.elimina')}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            {data.volumes.length > 0 && (
              <section className="pii-card" aria-labelledby={`${id}-vol`}>
                <h2 id={`${id}-vol`}>{t('cloud.volumiTitolo')}</h2>
                <ul className="cloud-plain">
                  {data.volumes.map((v) => (
                    <li key={v.id}>
                      {v.name} · {t('cloud.gbValue', { v: fmtNumber(v.sizeGb) })} · {t('cloud.collegatoA', { s: data.servers.find((s) => s.id === v.server)?.name ?? t('cloud.nessunServer') })} · {t('cloud.perMese', { v: eur(v.monthly) })}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>

      {data && newFrom && (
        <NewServerDialog
          data={data}
          image={newFrom}
          onClose={() => setNewFrom(null)}
          onCreated={(name) => {
            setNewFrom(null);
            setMsg(t('cloud.creatingMsg', { n: name }));
            void load();
          }}
        />
      )}

      {data && newNode && (
        <NewAgicloudNodeDialog
          data={data}
          onClose={() => setNewNode(false)}
          onCreated={() => void load()}
        />
      )}
    </section>
  );
}

/** Immagine da cui nascono le VPS AgiCloud: stato, pulsante per costruirla, registro in diretta */
function NodeImageSection({ data, onChanged, onNewNode }: { data: CloudOverview; onChanged: () => void; onNewNode: () => void }) {
  const t = useT();
  const id = useId();
  const [job, setJob] = useState<CloudBuildJob | null>(null);
  const [error, setError] = useState('');
  const current = data.images.find((i) => i.agicloudNode);

  // Un lavoro gia' in corso (es. ricaricando la pagina): lo si ritrova e si continua a seguirlo
  useEffect(() => {
    api.cloudBuildStatus().then(setJob).catch(() => {});
  }, []);

  useEffect(() => {
    if (job?.state !== 'running') return;
    const tm = window.setInterval(async () => {
      try {
        const j = await api.cloudBuildStatus();
        setJob(j);
        if (j?.state === 'done') onChanged();
      } catch {
        /* si riprova al prossimo giro */
      }
    }, 2000);
    return () => window.clearInterval(tm);
  }, [job?.state]);

  const start = async () => {
    setError('');
    try {
      setJob(await api.cloudBuildStart());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section className="pii-card" aria-labelledby={`${id}-t`}>
      <div className="group-head">
        <h2 id={`${id}-t`}>{t('cloud.immagineTitolo')}</h2>
        <div className="agent-actions">
          {current && (
            <button type="button" className="btn small-btn primary" onClick={onNewNode}>
              {t('cloud.nuovaVpsAgicloud')}
            </button>
          )}
          <button type="button" className="btn small-btn" disabled={job?.state === 'running'} onClick={() => void start()}>
            {job?.state === 'running' ? t('cloud.costruzioneInCorso') : t('cloud.costruisci')}
          </button>
        </div>
      </div>
      <p className="hint">
        {current
          ? t('cloud.inUso', { d: current.description, data: date(current.created) })
          : t('cloud.nessunaImmagine')}
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {job && (
        <details className="pii-card" open={job.state !== 'done'}>
          <summary>
            {job.state === 'running' ? t('cloud.costruzioneInCorso') : job.state === 'error' ? t('cloud.costruzNonRiuscita') : t('cloud.ultimaOk')}
          </summary>
          <pre className="cloud-build-log" aria-live={job.state === 'running' ? 'polite' : undefined}>
            {job.log.join('\n') || t('cloud.inAvvio')}
          </pre>
        </details>
      )}
    </section>
  );
}

function NewAgicloudNodeDialog({ data, onClose, onCreated }: { data: CloudOverview; onClose: () => void; onCreated: () => void }) {
  const t = useT();
  const id = useId();
  const ref = useRef<HTMLDialogElement>(null);
  const types = data.serverTypes;
  const [name, setName] = useState('cliente-1');
  const [location, setLocation] = useState('nbg1');
  const [type, setType] = useState(() => (types.find((x) => x.name === 'cax11') ?? types[0])?.name ?? '');
  const [backups, setBackups] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ ipv4: string | null; activationUrl: string | null } | null>(null);
  const [copied, setCopied] = useState('');

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  const sel = types.find((x) => x.name === type);
  const base = sel?.prices[location] ?? 0;
  const monthly = base * (backups ? 1.2 : 1);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api.cloudCreateAgicloudNode({ name, type, location, backups });
      setResult(r);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog ref={ref} className="dialog" aria-labelledby={`${id}-t`} onClose={onClose}>
      {result ? (
        <div>
          <h2 id={`${id}-t`}>{t('cloud.vpsCreata', { n: name })}</h2>
          <p>{t('cloud.avvioCert')}</p>
          {result.activationUrl && (
            <>
              <label htmlFor={`${id}-link`}>{t('cloud.linkLabel')}</label>
              <div className="secret-row">
                <input id={`${id}-link`} className="mono-input" readOnly value={result.activationUrl} onFocus={(e) => e.currentTarget.select()} />
                <button type="button" className="btn" onClick={() => void copyText(result.activationUrl!).then((ok) => setCopied(ok ? t('cloud.linkCopiato') : t('cloud.copiaFallita')))}>
                  {t('cloud.copia')}
                </button>
              </div>
              <p className="hint" aria-live="polite">
                {copied}
              </p>
            </>
          )}
          <div className="dialog-actions">
            <button type="button" className="btn primary" onClick={onClose}>
              {t('cloud.chiudi')}
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={(e) => void submit(e)}>
          <h2 id={`${id}-t`}>{t('cloud.nuovaVpsAgicloud')}</h2>
          <p className="hint">{t('cloud.nasceGia')}</p>
          <div className="pii-field">
            <label htmlFor={`${id}-name`}>{t('cloud.nome')}</label>
            <input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value.toLowerCase())} className="mono-input" />
          </div>
          <div className="pii-field">
            <label htmlFor={`${id}-loc`}>{t('cloud.posto')}</label>
            <select id={`${id}-loc`} value={location} onChange={(e) => setLocation(e.target.value)}>
              {data.locations.map((l) => (
                <option key={l.name} value={l.name}>
                  {t('cloud.luogoOption', { city: l.city, country: l.country, name: l.name })}
                </option>
              ))}
            </select>
          </div>
          <div className="pii-field">
            <label htmlFor={`${id}-type`}>{t('cloud.tipo')}</label>
            <select id={`${id}-type`} value={type} onChange={(e) => setType(e.target.value)}>
              {types
                .filter((x) => x.prices[location] !== undefined)
                .map((x) => (
                  <option key={x.name} value={x.name}>
                    {t('cloud.typeOption', { name: x.name, cores: x.cores, mem: x.memory, disk: x.disk, arch: x.arch, price: eur(x.prices[location]!) })}
                  </option>
                ))}
            </select>
          </div>
          <label className="choice">
            <input type="checkbox" checked={backups} onChange={(e) => setBackups(e.target.checked)} />
            <span className="choice-text">
              <span>{t('cloud.backupGiornalieri')}</span>
              <span className="hint">{t('cloud.setteCopie')}</span>
            </span>
          </label>
          <p className="cloud-price">
            {t('cloud.pricePrefix')} <strong>{eur(monthly)} {t('cloud.alMese')}</strong> {t('cloud.priceSuffix')}
          </p>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={onClose}>
              {t('cloud.annulla')}
            </button>
            <button type="submit" className="btn primary" disabled={busy || !name || !type}>
              {busy ? t('cloud.creazione') : t('cloud.creaPer', { prezzo: eur(monthly) })}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}

function ServerCard({
  server: s,
  images,
  busy,
  act,
}: {
  server: CloudServer;
  images: CloudImage[];
  busy: string | null;
  act: (key: string, fn: () => Promise<unknown>, done: string) => Promise<void>;
}) {
  const t = useT();
  const id = useId();
  const [rebuild, setRebuild] = useState('');
  const prod = !s.worker;
  const power = (action: 'on' | 'off' | 'reboot', label: string) => {
    if (prod && action !== 'on' && !confirm(t('cloud.confirmProd', { n: s.name, azione: label.toLowerCase() }))) return;
    void act(`pw-${s.id}`, () => api.cloudPower(s.id, action), t('cloud.powerDone', { label, n: s.name }));
  };
  return (
    <article className="agent-card cloud-server" aria-labelledby={`${id}-n`}>
      <div className="agent-card-head">
        <h3 id={`${id}-n`}>{s.name}</h3>
        <p className={`badge badge-${s.status === 'running' ? 'ok' : s.status === 'off' ? 'unknown' : 'missing'}`}>
          <span className="status-dot" aria-hidden="true" />
          {getStatusLabel(t, s.status)}
        </p>
      </div>
      <p className="agent-detail">
        {s.type} · {s.cores} vCPU · {s.memory} GB RAM · {s.disk} GB · {s.location} · {s.arch} · {t('cloud.perMese', { v: eur(s.monthly) })}
      </p>
      <p className="agent-detail">
        {s.ipv4 && (
          <>
            IP <code>{s.ipv4}</code>{' '}
            <button type="button" className="link-btn" onClick={() => void copyText(s.ipv4!)}>
              {t('cloud.copiaIp')}<span className="visually-hidden"> {t('cloud.ipNascosto')}</span>
            </button>
            {' · '}
          </>
        )}
        {t('cloud.creato', { data: date(s.created) })}
        {s.image && <> · {t('cloud.da', { x: s.image })}</>}
      </p>
      <p>
        {prod ? (
          <span className="cloud-badge cloud-badge-prod">{t('cloud.badgePrincipale', { extra: s.protected ? t('cloud.protetto') : '' })}</span>
        ) : (
          <span className="cloud-badge">{t('cloud.badgeCreato')}</span>
        )}
      </p>
      <div className="agent-actions">
        {s.status === 'off' ? (
          <button type="button" className="btn small-btn primary" disabled={busy !== null} onClick={() => power('on', t('cloud.powerOn'))}>
            {t('cloud.accendi')}
          </button>
        ) : (
          <>
            <button type="button" className="btn small-btn" disabled={busy !== null} onClick={() => power('reboot', t('cloud.powerReboot'))}>
              {t('cloud.riavvia')}
            </button>
            <button type="button" className="btn small-btn" disabled={busy !== null} onClick={() => power('off', t('cloud.powerOff'))}>
              {t('cloud.spegni')}
            </button>
          </>
        )}
        <button
          type="button"
          className="btn small-btn"
          disabled={busy !== null}
          onClick={() => void act(`snap-${s.id}`, () => api.cloudSnapshot(s.id), t('cloud.snapDone', { n: s.name }))}
        >
          {t('cloud.snapshotOra')}
        </button>
        <label className="switch">
          <input
            type="checkbox"
            role="switch"
            checked={s.backups}
            disabled={busy !== null}
            onChange={(e) => {
              const on = e.target.checked;
              if (!on && !confirm(t('cloud.confirmBackupOff', { n: s.name }))) return;
              void act(`bk-${s.id}`, () => api.cloudBackups(s.id, on), on ? t('cloud.bkOn') : t('cloud.bkOff'));
            }}
          />
          <span>{t('cloud.backupGiornalieri')}</span>
        </label>
      </div>
      {s.worker && (
        <div className="agent-actions cloud-danger">
          <label htmlFor={`${id}-rb`} className="visually-hidden">
            {t('cloud.imgReinstallLabel')}
          </label>
          <select id={`${id}-rb`} value={rebuild} onChange={(e) => setRebuild(e.target.value)}>
            <option value="">{t('cloud.reinstallaDa')}</option>
            {images
              .filter((i) => i.arch === s.arch)
              .map((i) => (
                <option key={i.id} value={i.id}>
                  {t('cloud.rebuildOption', { tipo: i.type === 'backup' ? t('cloud.backupLabel') : t('cloud.snapshotLabel'), d: i.description })}
                </option>
              ))}
          </select>
          <button
            type="button"
            className="btn small-btn"
            disabled={!rebuild || busy !== null}
            onClick={() => {
              if (confirm(t('cloud.confirmRebuild', { n: s.name }))) {
                void act(`rb-${s.id}`, () => api.cloudRebuild(s.id, rebuild), t('cloud.rebuilding', { n: s.name }));
              }
            }}
          >
            {t('cloud.reinstalla')}
          </button>
          <button
            type="button"
            className="btn small-btn"
            disabled={busy !== null}
            onClick={() => {
              const typed = prompt(t('cloud.promptElimina', { n: s.name }));
              if (typed === s.name) void act(`del-${s.id}`, () => api.cloudDelete(s.id, typed), t('cloud.eliminato', { n: s.name }));
            }}
          >
            {t('cloud.elimina')}
          </button>
        </div>
      )}
    </article>
  );
}

function NewServerDialog({ data, image, onClose, onCreated }: { data: CloudOverview; image: string; onClose: () => void; onCreated: (name: string) => void }) {
  const t = useT();
  const id = useId();
  const ref = useRef<HTMLDialogElement>(null);
  const img = data.images.find((i) => String(i.id) === image);
  const arch = img?.arch ?? null;
  const types = data.serverTypes.filter((x) => !arch || x.arch === arch);
  const [name, setName] = useState('vps-1');
  const [location, setLocation] = useState('nbg1');
  const [type, setType] = useState(() => (types.find((x) => x.name === 'cax11') ?? types[0])?.name ?? '');
  const [backups, setBackups] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  const sel = types.find((x) => x.name === type);
  const base = sel?.prices[location] ?? 0;
  const monthly = base * (backups ? 1.2 : 1);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.cloudCreate({ name, type, location, image, backups });
      onCreated(name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <dialog ref={ref} className="dialog" aria-labelledby={`${id}-t`} onClose={onClose}>
      <form onSubmit={(e) => void submit(e)}>
        <h2 id={`${id}-t`}>{t('cloud.nuovaVps')}</h2>
        <p className="hint">{t('cloud.daOrigine', { origine: img ? `${img.type === 'backup' ? t('cloud.backupWord') : t('cloud.snapshotWord')} "${img.description}"` : t('cloud.ubuntuPulito') })}</p>
        <div className="pii-field">
          <label htmlFor={`${id}-name`}>{t('cloud.nome')}</label>
          <input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value.toLowerCase())} className="mono-input" />
        </div>
        <div className="pii-field">
          <label htmlFor={`${id}-loc`}>{t('cloud.posto')}</label>
          <select id={`${id}-loc`} value={location} onChange={(e) => setLocation(e.target.value)}>
            {data.locations.map((l) => (
              <option key={l.name} value={l.name}>
                {t('cloud.luogoOption', { city: l.city, country: l.country, name: l.name })}
              </option>
            ))}
          </select>
        </div>
        <div className="pii-field">
          <label htmlFor={`${id}-type`}>{t('cloud.tipo')}</label>
          <select id={`${id}-type`} value={type} onChange={(e) => setType(e.target.value)}>
            {types
              .filter((x) => x.prices[location] !== undefined)
              .map((x) => (
                <option key={x.name} value={x.name}>
                  {t('cloud.typeOption', { name: x.name, cores: x.cores, mem: x.memory, disk: x.disk, arch: x.arch, price: eur(x.prices[location]!) })}
                </option>
              ))}
          </select>
        </div>
        <label className="choice">
          <input type="checkbox" checked={backups} onChange={(e) => setBackups(e.target.checked)} />
          <span className="choice-text">
            <span>{t('cloud.backupGiornalieri')}</span>
            <span className="hint">{t('cloud.setteCopie')}</span>
          </span>
        </label>
        <p className="cloud-price">
          {t('cloud.pricePrefix')} <strong>{eur(monthly)} {t('cloud.alMese')}</strong> {t('cloud.priceSuffix')}
        </p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {t('cloud.annulla')}
          </button>
          <button type="submit" className="btn primary" disabled={busy || !name || !type}>
            {busy ? t('cloud.creazione') : t('cloud.creaPer', { prezzo: eur(monthly) })}
          </button>
        </div>
      </form>
    </dialog>
  );
}
