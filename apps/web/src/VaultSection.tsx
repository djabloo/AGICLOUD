import { useEffect, useId, useState, type FormEvent } from 'react';
import { api, type VaultKey } from './api';

interface PresetDef {
  id: 'google_oauth' | 'github_oauth';
  label: string;
  desc: string;
  idKey: string;
  secretKey: string;
  idPlaceholder: string;
  secretPlaceholder: string;
}

const PRESETS: PresetDef[] = [
  {
    id: 'google_oauth',
    label: 'Google OAuth',
    desc: 'Accesso con account Google (piattaforma e agenti)',
    idKey: 'GOOGLE_CLIENT_ID',
    secretKey: 'GOOGLE_CLIENT_SECRET',
    idPlaceholder: 'es. 123456789-xxx.apps.googleusercontent.com',
    secretPlaceholder: 'es. GOCSPX-xxx',
  },
  {
    id: 'github_oauth',
    label: 'GitHub OAuth',
    desc: 'Accesso con account GitHub (piattaforma e agenti)',
    idKey: 'GITHUB_CLIENT_ID',
    secretKey: 'GITHUB_CLIENT_SECRET',
    idPlaceholder: 'es. Ov23li...',
    secretPlaceholder: 'es. 9a8b7c...',
  },
];

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

  const removePreset = async (p: PresetDef) => {
    if (!confirm(`Eliminare le credenziali di ${p.label}?`)) return;
    try {
      let list = keys;
      if (keys?.some((k) => k.name === p.idKey)) list = await api.deleteVaultKey(p.idKey);
      if (list?.some((k) => k.name === p.secretKey)) list = await api.deleteVaultKey(p.secretKey);
      setKeys(list);
      setAnnounce(`${p.label} eliminata`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const presetKeyNames = new Set(PRESETS.flatMap((p) => [p.idKey, p.secretKey]));
  const standaloneKeys = keys?.filter((k) => !presetKeyNames.has(k.name)) ?? [];
  const configuredPresets = PRESETS.map((p) => {
    const idEntry = keys?.find((k) => k.name === p.idKey);
    const secretEntry = keys?.find((k) => k.name === p.secretKey);
    return { ...p, idEntry, secretEntry, active: Boolean(idEntry || secretEntry) };
  }).filter((p) => p.active);

  const totalItems = (standaloneKeys?.length ?? 0) + configuredPresets.length;

  return (
    <section aria-labelledby={`${id}-title`} className="settings-group">
      <h2 id={`${id}-title`} tabIndex={-1}>
        Chiavi
      </h2>
      <p className="hint">
        Chiavi API e credenziali OAuth: restano sul server e non tornano mai al browser. Agenti e terminali le
        ricevono come variabili d'ambiente (es. <code>$GOOGLE_CLIENT_ID</code> o <code>$FAL_KEY</code>).
      </p>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {totalItems > 0 && (
        <ul className="vault-list">
          {configuredPresets.map((p) => (
            <li key={p.id} className="vault-item">
              <div className="vault-head">
                <span className="vault-name" style={{ fontWeight: 600 }}>{p.label}</span>
                <span className="hint">
                  {p.idEntry && p.secretEntry ? 'Configurato' : 'Parziale'}
                </span>
              </div>
              <p className="hint vault-note">{p.desc}</p>
              <div style={{ display: 'grid', gap: '4px', margin: '4px 0', fontSize: '0.85rem' }}>
                {p.idEntry && (
                  <span className="hint">
                    <code>${p.idKey}</code>: ••••{p.idEntry.last4}
                  </span>
                )}
                {p.secretEntry && (
                  <span className="hint">
                    <code>${p.secretKey}</code>: ••••{p.secretEntry.last4}
                  </span>
                )}
              </div>
              <div className="vault-actions">
                <button type="button" className="btn small-btn" onClick={() => void removePreset(p)}>
                  Elimina<span className="visually-hidden"> {p.label}</span>
                </button>
              </div>
            </li>
          ))}

          {standaloneKeys.map((k) => (
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
      {keys && totalItems === 0 && <p className="hint">Nessuna chiave salvata.</p>}

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
  const [kind, setKind] = useState<'custom' | 'google_oauth' | 'github_oauth'>('custom');
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const selectedPreset = PRESETS.find((p) => p.id === kind);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      if (selectedPreset) {
        if (!clientId.trim() || !clientSecret.trim()) {
          throw new Error('Inserisci sia il Client ID sia il Client Secret');
        }
        let list = await api.saveVaultKey({
          name: selectedPreset.idKey,
          value: clientId.trim(),
          note: note.trim() || `${selectedPreset.label} (Client ID)`,
        });
        list = await api.saveVaultKey({
          name: selectedPreset.secretKey,
          value: clientSecret.trim(),
          note: note.trim() || `${selectedPreset.label} (Client Secret)`,
        });
        onSaved(list, selectedPreset.label);
        setClientId('');
        setClientSecret('');
        setNote('');
      } else {
        const n = name.trim().toUpperCase();
        onSaved(await api.saveVaultKey({ name: n, value, note }), n);
        setName('');
        setValue('');
        setNote('');
      }
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

      <div>
        <label htmlFor={`${id}-kind`}>Tipo di chiave</label>
        <select
          id={`${id}-kind`}
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as typeof kind);
            setErr('');
          }}
          style={{ width: '100%', marginTop: 4, padding: '6px 8px' }}
        >
          <option value="custom">Chiave singola (API Key / Token)</option>
          <option value="google_oauth">Google OAuth (Client ID + Client Secret)</option>
          <option value="github_oauth">GitHub OAuth (Client ID + Client Secret)</option>
        </select>
      </div>

      {selectedPreset ? (
        <div className="add-key-grid">
          <div>
            <label htmlFor={`${id}-cid`}>Client ID</label>
            <input
              id={`${id}-cid`}
              className="mono-input"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder={selectedPreset.idPlaceholder}
              autoComplete="off"
              spellCheck={false}
              required
            />
          </div>
          <div>
            <label htmlFor={`${id}-sec`}>Client Secret</label>
            <input
              id={`${id}-sec`}
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder={selectedPreset.secretPlaceholder}
              autoComplete="off"
              spellCheck={false}
              required
            />
          </div>
          <div className="add-key-note">
            <label htmlFor={`${id}-o`}>Nota (facoltativa)</label>
            <input
              id={`${id}-o`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={`es. ${selectedPreset.label} produzione`}
              maxLength={200}
            />
          </div>
        </div>
      ) : (
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
      )}

      {err && (
        <p className="form-error" role="alert">
          {err}
        </p>
      )}
      <div className="dialog-actions start">
        <button
          type="submit"
          className="btn primary"
          disabled={busy || (selectedPreset ? !clientId.trim() || !clientSecret.trim() : !name.trim() || !value)}
        >
          {selectedPreset ? `Salva ${selectedPreset.label}` : 'Salva chiave'}
        </button>
      </div>
    </form>
  );
}
