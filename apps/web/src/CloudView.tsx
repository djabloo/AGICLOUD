// Plugin Cloud: i server Hetzner, le immagini e i costi; nuove VPS da un'immagine.
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { api, type CloudImage, type CloudOverview, type CloudServer } from './api';
import { copyText } from './termText';

const eur = (n: number) => n.toLocaleString('it-IT', { style: 'currency', currency: 'EUR' });
const date = (s: string) => new Date(s).toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' });

const STATUS: Record<string, string> = {
  running: 'In funzione',
  off: 'Spento',
  starting: 'Si accende…',
  stopping: 'Si spegne…',
  initializing: 'In preparazione…',
  rebuilding: 'Si reinstalla…',
  migrating: 'In migrazione…',
  deleting: 'Si elimina…',
};

export function CloudView() {
  const id = useId();
  const [data, setData] = useState<CloudOverview | null>(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [newFrom, setNewFrom] = useState<string | null>(null);

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
    const t = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(t);
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
          <h1 id={`${id}-title`}>Cloud</h1>
          <p className="chat-meta">{data ? `Costo stimato ${eur(data.monthlyTotal)} al mese, IVA inclusa` : 'Hetzner Cloud'}</p>
        </div>
        <button type="button" className="btn small-btn" onClick={() => void load()}>
          Aggiorna
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
        {!data && !error && <p className="hint">Caricamento da Hetzner…</p>}

        {data && (
          <>
            <section className="pii-card" aria-labelledby={`${id}-srv`}>
              <div className="group-head">
                <h2 id={`${id}-srv`}>Server</h2>
                <button type="button" className="btn small-btn primary" onClick={() => setNewFrom('ubuntu-24.04')}>
                  Nuova VPS
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
              <h2 id={`${id}-img`}>Immagini e backup</h2>
              <p className="hint">Gli snapshot si pagano a GB; i backup giornalieri sono compresi nel 20% in piu' del server.</p>
              <div className="cloud-table-wrap">
                <table className="pii-table cloud-table">
                  <caption className="visually-hidden">Snapshot e backup</caption>
                  <thead>
                    <tr>
                      <th scope="col">Immagine</th>
                      <th scope="col">Data</th>
                      <th scope="col">Dimensione</th>
                      <th scope="col">Costo/mese</th>
                      <th scope="col">
                        <span className="visually-hidden">Azioni</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.images.map((i) => (
                      <tr key={i.id}>
                        <td>
                          {i.type === 'backup' ? 'Backup' : 'Snapshot'} · {i.description}
                          {i.from && <span className="hint"> · da {i.from}</span>}
                          {i.nodeImage && <span className="cloud-badge">immagine dei nodi</span>}
                        </td>
                        <td>{date(i.created)}</td>
                        <td>{i.sizeGb.toFixed(1)} GB</td>
                        <td>{i.type === 'snapshot' ? eur(i.monthly) : 'compreso'}</td>
                        <td className="cloud-actions">
                          <button type="button" className="btn small-btn" onClick={() => setNewFrom(String(i.id))}>
                            Nuova VPS da qui
                          </button>
                          {i.type === 'snapshot' && !i.nodeImage && (
                            <button
                              type="button"
                              className="btn small-btn"
                              disabled={busy !== null}
                              onClick={() => {
                                if (confirm(`Eliminare lo snapshot "${i.description}"? Non si recupera.`)) {
                                  void act(`img-${i.id}`, () => api.cloudDeleteImage(i.id), 'Snapshot eliminato');
                                }
                              }}
                            >
                              Elimina
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
                <h2 id={`${id}-vol`}>Volumi</h2>
                <ul className="cloud-plain">
                  {data.volumes.map((v) => (
                    <li key={v.id}>
                      {v.name} · {v.sizeGb} GB · collegato a {data.servers.find((s) => s.id === v.server)?.name ?? 'nessun server'} · {eur(v.monthly)}/mese
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
            setMsg(`VPS "${name}" in creazione: tra un minuto o due e' pronta.`);
            void load();
          }}
        />
      )}
    </section>
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
  const id = useId();
  const [rebuild, setRebuild] = useState('');
  const prod = !s.worker;
  const power = (action: 'on' | 'off' | 'reboot', label: string) => {
    if (prod && action !== 'on' && !confirm(`"${s.name}" e' il server principale: ${label.toLowerCase()} ferma tutto (ProSEO, n8n, AgiCloud…). Procedere?`)) return;
    void act(`pw-${s.id}`, () => api.cloudPower(s.id, action), `${label}: comando inviato a "${s.name}"`);
  };
  return (
    <article className="agent-card cloud-server" aria-labelledby={`${id}-n`}>
      <div className="agent-card-head">
        <h3 id={`${id}-n`}>{s.name}</h3>
        <p className={`badge badge-${s.status === 'running' ? 'ok' : s.status === 'off' ? 'unknown' : 'missing'}`}>
          <span className="status-dot" aria-hidden="true" />
          {STATUS[s.status] ?? s.status}
        </p>
      </div>
      <p className="agent-detail">
        {s.type} · {s.cores} vCPU · {s.memory} GB RAM · {s.disk} GB · {s.location} · {s.arch} · {eur(s.monthly)}/mese
      </p>
      <p className="agent-detail">
        {s.ipv4 && (
          <>
            IP <code>{s.ipv4}</code>{' '}
            <button type="button" className="link-btn" onClick={() => void copyText(s.ipv4!)}>
              copia<span className="visually-hidden"> l'indirizzo IP</span>
            </button>
            {' · '}
          </>
        )}
        creato {date(s.created)}
        {s.image && <> · da {s.image}</>}
      </p>
      <p>
        {prod ? (
          <span className="cloud-badge cloud-badge-prod">Server principale{s.protected ? ', protetto' : ''}</span>
        ) : (
          <span className="cloud-badge">Creato da AgiCloud</span>
        )}
      </p>
      <div className="agent-actions">
        {s.status === 'off' ? (
          <button type="button" className="btn small-btn primary" disabled={busy !== null} onClick={() => power('on', 'Accensione')}>
            Accendi
          </button>
        ) : (
          <>
            <button type="button" className="btn small-btn" disabled={busy !== null} onClick={() => power('reboot', 'Riavvio')}>
              Riavvia
            </button>
            <button type="button" className="btn small-btn" disabled={busy !== null} onClick={() => power('off', 'Spegnimento')}>
              Spegni
            </button>
          </>
        )}
        <button
          type="button"
          className="btn small-btn"
          disabled={busy !== null}
          onClick={() => void act(`snap-${s.id}`, () => api.cloudSnapshot(s.id), `Snapshot di "${s.name}" avviato: compare tra le immagini quando e' pronto`)}
        >
          Snapshot ora
        </button>
        <label className="switch">
          <input
            type="checkbox"
            role="switch"
            checked={s.backups}
            disabled={busy !== null}
            onChange={(e) => {
              const on = e.target.checked;
              if (!on && !confirm(`Spegnere i backup giornalieri di "${s.name}"? Hetzner cancella quelli esistenti.`)) return;
              void act(`bk-${s.id}`, () => api.cloudBackups(s.id, on), on ? 'Backup giornalieri attivati' : 'Backup spenti');
            }}
          />
          <span>Backup giornalieri</span>
        </label>
      </div>
      {s.worker && (
        <div className="agent-actions cloud-danger">
          <label htmlFor={`${id}-rb`} className="visually-hidden">
            Immagine da cui reinstallare
          </label>
          <select id={`${id}-rb`} value={rebuild} onChange={(e) => setRebuild(e.target.value)}>
            <option value="">Reinstalla da…</option>
            {images
              .filter((i) => i.arch === s.arch)
              .map((i) => (
                <option key={i.id} value={i.id}>
                  {i.type === 'backup' ? 'Backup' : 'Snapshot'} {i.description}
                </option>
              ))}
          </select>
          <button
            type="button"
            className="btn small-btn"
            disabled={!rebuild || busy !== null}
            onClick={() => {
              if (confirm(`Reinstallare "${s.name}" da questa immagine? Il disco attuale viene sostituito.`)) {
                void act(`rb-${s.id}`, () => api.cloudRebuild(s.id, rebuild), `"${s.name}" in reinstallazione`);
              }
            }}
          >
            Reinstalla
          </button>
          <button
            type="button"
            className="btn small-btn"
            disabled={busy !== null}
            onClick={() => {
              const typed = prompt(`Per eliminare "${s.name}" (e smettere di pagarlo) scrivi il suo nome:`);
              if (typed === s.name) void act(`del-${s.id}`, () => api.cloudDelete(s.id, typed), `"${s.name}" eliminato`);
            }}
          >
            Elimina
          </button>
        </div>
      )}
    </article>
  );
}

function NewServerDialog({ data, image, onClose, onCreated }: { data: CloudOverview; image: string; onClose: () => void; onCreated: (name: string) => void }) {
  const id = useId();
  const ref = useRef<HTMLDialogElement>(null);
  const img = data.images.find((i) => String(i.id) === image);
  const arch = img?.arch ?? null;
  const types = data.serverTypes.filter((t) => !arch || t.arch === arch);
  const [name, setName] = useState('vps-1');
  const [location, setLocation] = useState('nbg1');
  const [type, setType] = useState(() => (types.find((t) => t.name === 'cax11') ?? types[0])?.name ?? '');
  const [backups, setBackups] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  const t = types.find((x) => x.name === type);
  const base = t?.prices[location] ?? 0;
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
        <h2 id={`${id}-t`}>Nuova VPS</h2>
        <p className="hint">Da: {img ? `${img.type === 'backup' ? 'backup' : 'snapshot'} "${img.description}"` : 'Ubuntu 24.04 pulito'}. Si accede con la tua chiave SSH registrata su Hetzner.</p>
        <div className="pii-field">
          <label htmlFor={`${id}-name`}>Nome</label>
          <input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value.toLowerCase())} className="mono-input" />
        </div>
        <div className="pii-field">
          <label htmlFor={`${id}-loc`}>Posto</label>
          <select id={`${id}-loc`} value={location} onChange={(e) => setLocation(e.target.value)}>
            {data.locations.map((l) => (
              <option key={l.name} value={l.name}>
                {l.city} ({l.country}) · {l.name}
              </option>
            ))}
          </select>
        </div>
        <div className="pii-field">
          <label htmlFor={`${id}-type`}>Tipo</label>
          <select id={`${id}-type`} value={type} onChange={(e) => setType(e.target.value)}>
            {types
              .filter((x) => x.prices[location] !== undefined)
              .map((x) => (
                <option key={x.name} value={x.name}>
                  {x.name} · {x.cores} vCPU · {x.memory} GB · {x.disk} GB · {x.arch} · {eur(x.prices[location]!)}/mese
                </option>
              ))}
          </select>
        </div>
        <label className="choice">
          <input type="checkbox" checked={backups} onChange={(e) => setBackups(e.target.checked)} />
          <span className="choice-text">
            <span>Backup giornalieri</span>
            <span className="hint">7 copie, +20% sul prezzo del server</span>
          </span>
        </label>
        <p className="cloud-price">
          Costo: <strong>{eur(monthly)} al mese</strong> (IVA inclusa, a ore finche' la tieni)
        </p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Annulla
          </button>
          <button type="submit" className="btn primary" disabled={busy || !name || !type}>
            {busy ? 'Creazione…' : `Crea per ${eur(monthly)}/mese`}
          </button>
        </div>
      </form>
    </dialog>
  );
}
