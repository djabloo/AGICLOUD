import { useEffect, useId, useState, type FormEvent } from 'react';
import { api, type VaultKey } from './api';

/** Portachiavi: chiavi API usabili da agenti e terminali come variabili d'ambiente, mai mostrate */
export function VaultSection() {
  const id = useId();
  const [keys, setKeys] = useState<VaultKey[] | null>(null);
  const [error, setError] = useState('');
  const [announce, setAnnounce] = useState('');

  useEffect(() => {
    api.vault().then(setKeys).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const update = async (k: VaultKey, patch: Partial<Pick<VaultKey, 'agents' | 'terminals'>>) => {
    setError('');
    try {
      setKeys(await api.saveVaultKey({ name: k.name, ...patch }));
      setAnnounce(`${k.name} aggiornata`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (k: VaultKey) => {
    if (!confirm(`Eliminare la chiave ${k.name}?`)) return;
    try {
      setKeys(await api.deleteVaultKey(k.name));
      setAnnounce(`${k.name} eliminata`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section aria-labelledby={`${id}-title`} className="settings-group">
      <h2 id={`${id}-title`}>Chiavi</h2>
      <p className="hint">
        Chiavi API per video, workflow e script: restano sul server e non tornano mai al browser. Agenti e terminali le
        ricevono come variabili d'ambiente, quindi in chat basta scrivere per esempio <code>usa $FAL_KEY</code>. Valgono per
        agenti e terminali avviati dopo il salvataggio.
      </p>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {keys && keys.length > 0 && (
        <ul className="vault-list">
          {keys.map((k) => (
            <li key={k.name} className="vault-item">
              <div className="vault-head">
                <code className="vault-name">${k.name}</code>
                <span className="hint">
                  <span className="visually-hidden">finisce con </span>
                  <span aria-hidden="true">••••</span>
                  {k.last4}
                </span>
              </div>
              {k.note && <p className="hint vault-note">{k.note}</p>}
              {k.blockedFor.length > 0 && (
                <p className="hint vault-note">
                  Non viene passata a {k.blockedFor.join(', ')}, che resta sul suo account (abbonamento).
                </p>
              )}
              <div className="vault-actions">
                <label className="check-row">
                  <input type="checkbox" checked={k.agents} onChange={(e) => void update(k, { agents: e.target.checked })} />
                  <span>Agenti (chat)</span>
                </label>
                <label className="check-row">
                  <input type="checkbox" checked={k.terminals} onChange={(e) => void update(k, { terminals: e.target.checked })} />
                  <span>Terminali</span>
                </label>
                <button type="button" className="btn small-btn" onClick={() => void remove(k)}>
                  Elimina<span className="visually-hidden"> {k.name}</span>
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {keys && keys.length === 0 && <p className="hint">Nessuna chiave salvata.</p>}

      <AddKey
        onSaved={(list, name) => {
          setKeys(list);
          setAnnounce(`${name} salvata`);
        }}
      />

      <div className="visually-hidden" aria-live="polite">
        {announce}
      </div>
    </section>
  );
}

function AddKey({ onSaved }: { onSaved: (keys: VaultKey[], name: string) => void }) {
  const id = useId();
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    const n = name.trim().toUpperCase();
    try {
      onSaved(await api.saveVaultKey({ name: n, value, note }), n);
      setName('');
      setValue('');
      setNote('');
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="add-key" onSubmit={submit} aria-labelledby={`${id}-t`}>
      <h3 id={`${id}-t`} className="mini-title">
        Aggiungi o sostituisci
      </h3>
      <div className="add-key-grid">
        <div>
          <label htmlFor={`${id}-n`}>Nome</label>
          <input
            id={`${id}-n`}
            className="mono-input"
            value={name}
            onChange={(e) => setName(e.target.value.toUpperCase())}
            placeholder="FAL_KEY"
            autoComplete="off"
            spellCheck={false}
            pattern="[A-Z][A-Z0-9_]{1,63}"
            aria-describedby={`${id}-nh`}
            required
          />
          <p id={`${id}-nh`} className="hint">
            Maiuscole, numeri e _
          </p>
        </div>
        <div>
          <label htmlFor={`${id}-v`}>Valore</label>
          <input
            id={`${id}-v`}
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            required
          />
        </div>
        <div className="add-key-note">
          <label htmlFor={`${id}-o`}>Nota (facoltativa)</label>
          <input id={`${id}-o`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="es. fal.ai per i video" maxLength={200} />
        </div>
      </div>
      {err && (
        <p className="form-error" role="alert">
          {err}
        </p>
      )}
      <div className="dialog-actions start">
        <button type="submit" className="btn primary" disabled={busy || !name.trim() || !value}>
          Salva chiave
        </button>
      </div>
    </form>
  );
}
