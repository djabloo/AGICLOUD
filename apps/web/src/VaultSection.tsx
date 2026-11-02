import { useEffect, useId, useState, type FormEvent } from 'react';
import { api, type VaultKey } from './api';
import { useT } from './i18n';

interface PresetDef {
  id: 'google_oauth' | 'github_oauth';
  label: string;
  desc: string;
  idKey: string;
  secretKey: string;
  idPlaceholder: string;
  secretPlaceholder: string;
}

function getPresets(t: ReturnType<typeof useT>): PresetDef[] {
  return [
    {
      id: 'google_oauth',
      label: 'Google OAuth',
      desc: t('portachiavi.googleDesc'),
      idKey: 'GOOGLE_CLIENT_ID',
      secretKey: 'GOOGLE_CLIENT_SECRET',
      idPlaceholder: t('portachiavi.googleIdPlaceholder'),
      secretPlaceholder: t('portachiavi.googleSecretPlaceholder'),
    },
    {
      id: 'github_oauth',
      label: 'GitHub OAuth',
      desc: t('portachiavi.githubDesc'),
      idKey: 'GITHUB_CLIENT_ID',
      secretKey: 'GITHUB_CLIENT_SECRET',
      idPlaceholder: t('portachiavi.githubIdPlaceholder'),
      secretPlaceholder: t('portachiavi.githubSecretPlaceholder'),
    },
  ];
}

/** Portachiavi: chiavi API usabili da agenti e terminali come variabili d'ambiente, mai mostrate */
export function VaultSection() {
  const t = useT();
  const id = useId();
  const PRESETS = getPresets(t);
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
      setAnnounce(t('portachiavi.aggiornata', { nome: k.name }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (k: VaultKey) => {
    if (!confirm(t('portachiavi.confermaEliminaChiave', { nome: k.name }))) return;
    try {
      setKeys(await api.deleteVaultKey(k.name));
      setAnnounce(t('portachiavi.eliminata', { nome: k.name }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const removePreset = async (p: PresetDef) => {
    if (!confirm(t('portachiavi.confermaEliminaCredenziali', { nome: p.label }))) return;
    try {
      let list = keys;
      if (keys?.some((k) => k.name === p.idKey)) list = await api.deleteVaultKey(p.idKey);
      if (list?.some((k) => k.name === p.secretKey)) list = await api.deleteVaultKey(p.secretKey);
      setKeys(list);
      setAnnounce(t('portachiavi.eliminata', { nome: p.label }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // Accessi a siti web: terne PREFISSO_URL / PREFISSO_USER / PREFISSO_PASSWORD
  const logins = (keys ?? [])
    .filter((k) => k.name.endsWith('_PASSWORD') && keys?.some((u) => u.name === loginKey(k.name, 'USER')))
    .map((pw) => {
      const prefix = pw.name.slice(0, -'_PASSWORD'.length);
      return { prefix, pw, user: keys!.find((k) => k.name === `${prefix}_USER`)!, url: keys!.find((k) => k.name === `${prefix}_URL`) };
    });
  const loginKeyNames = new Set(logins.flatMap((l) => [l.pw.name, l.user.name, ...(l.url ? [l.url.name] : [])]));

  const updateLogin = async (l: (typeof logins)[number], patch: Partial<Pick<VaultKey, 'agents' | 'terminals'>>) => {
    setError('');
    try {
      let list = keys;
      for (const k of [l.url, l.user, l.pw]) if (k) list = await api.saveVaultKey({ name: k.name, ...patch });
      setKeys(list);
      setAnnounce(t('portachiavi.aggiornata', { nome: l.prefix }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const removeLogin = async (l: (typeof logins)[number]) => {
    if (!confirm(t('portachiavi.confermaEliminaCredenziali', { nome: l.prefix }))) return;
    try {
      let list = keys;
      for (const k of [l.url, l.user, l.pw]) if (k) list = await api.deleteVaultKey(k.name);
      setKeys(list);
      setAnnounce(t('portachiavi.eliminata', { nome: l.prefix }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const presetKeyNames = new Set(PRESETS.flatMap((p) => [p.idKey, p.secretKey]));
  const standaloneKeys = keys?.filter((k) => !presetKeyNames.has(k.name) && !loginKeyNames.has(k.name)) ?? [];
  const configuredPresets = PRESETS.map((p) => {
    const idEntry = keys?.find((k) => k.name === p.idKey);
    const secretEntry = keys?.find((k) => k.name === p.secretKey);
    return { ...p, idEntry, secretEntry, active: Boolean(idEntry || secretEntry) };
  }).filter((p) => p.active);

  const totalItems = (standaloneKeys?.length ?? 0) + configuredPresets.length + logins.length;

  return (
    <section aria-labelledby={`${id}-title`} className="settings-group">
      <h2 id={`${id}-title`} tabIndex={-1}>
        Chiavi
      </h2>
      <p className="hint">
        {t('portachiavi.introduzionePrima')} <code>$GOOGLE_CLIENT_ID</code> {t('portachiavi.introduzioneO')} <code>$FAL_KEY</code>
        {t('portachiavi.introduzioneDopo')}
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
                  {p.idEntry && p.secretEntry ? t('portachiavi.configurato') : t('portachiavi.parziale')}
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
                  {t('portachiavi.elimina')}<span className="visually-hidden"> {p.label}</span>
                </button>
              </div>
            </li>
          ))}

          {logins.map((l) => (
            <li key={l.prefix} className="vault-item">
              <div className="vault-head">
                <span className="vault-name" style={{ fontWeight: 600 }}>{l.prefix}</span>
                <span className="hint">{t('portachiavi.accessoSito')}</span>
              </div>
              {l.pw.note && <p className="hint vault-note">{l.pw.note}</p>}
              <div style={{ display: 'grid', gap: '4px', margin: '4px 0', fontSize: '0.85rem' }}>
                {l.url && (
                  <span className="hint">
                    <code>${l.url.name}</code>
                  </span>
                )}
                <span className="hint">
                  <code>${l.user.name}</code>: ••••{l.user.last4}
                </span>
                <span className="hint">
                  <code>${l.pw.name}</code>: ••••
                </span>
              </div>
              <div className="vault-actions">
                <label className="check-row">
                  <input type="checkbox" checked={l.pw.agents} onChange={(e) => void updateLogin(l, { agents: e.target.checked })} />
                  <span>{t('portachiavi.agentiChat')}</span>
                </label>
                <label className="check-row">
                  <input type="checkbox" checked={l.pw.terminals} onChange={(e) => void updateLogin(l, { terminals: e.target.checked })} />
                  <span>{t('portachiavi.terminali')}</span>
                </label>
                <button type="button" className="btn small-btn" onClick={() => void removeLogin(l)}>
                  {t('portachiavi.elimina')}<span className="visually-hidden"> {l.prefix}</span>
                </button>
              </div>
            </li>
          ))}

          {standaloneKeys.map((k) => (
            <li key={k.name} className="vault-item">
              <div className="vault-head">
                <code className="vault-name">${k.name}</code>
                <span className="hint">
                  <span className="visually-hidden">{t('portachiavi.finisceCon')} </span>
                  <span aria-hidden="true">••••</span>
                  {k.last4}
                </span>
              </div>
              {k.note && <p className="hint vault-note">{k.note}</p>}
              {k.blockedFor.length > 0 && (
                <p className="hint vault-note">
                  {t('portachiavi.nonPassataA', { lista: k.blockedFor.join(', ') })}
                </p>
              )}
              <div className="vault-actions">
                <label className="check-row">
                  <input type="checkbox" checked={k.agents} onChange={(e) => void update(k, { agents: e.target.checked })} />
                  <span>{t('portachiavi.agentiChat')}</span>
                </label>
                <label className="check-row">
                  <input type="checkbox" checked={k.terminals} onChange={(e) => void update(k, { terminals: e.target.checked })} />
                  <span>{t('portachiavi.terminali')}</span>
                </label>
                <button type="button" className="btn small-btn" onClick={() => void remove(k)}>
                  {t('portachiavi.elimina')}<span className="visually-hidden"> {k.name}</span>
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {keys && totalItems === 0 && <p className="hint">{t('portachiavi.nessunaChiave')}</p>}

      <AddKey
        onSaved={(list, name) => {
          setKeys(list);
          setAnnounce(t('portachiavi.salvata', { nome: name }));
        }}
      />

      <div className="visually-hidden" aria-live="polite">
        {announce}
      </div>
    </section>
  );
}

function loginKey(passwordName: string, part: 'USER' | 'URL'): string {
  return `${passwordName.slice(0, -'_PASSWORD'.length)}_${part}`;
}

function AddKey({ onSaved }: { onSaved: (keys: VaultKey[], name: string) => void }) {
  const t = useT();
  const id = useId();
  const [kind, setKind] = useState<'custom' | 'login' | 'google_oauth' | 'github_oauth'>('custom');
  const [site, setSite] = useState('');
  const [user, setUser] = useState('');
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const selectedPreset = getPresets(t).find((p) => p.id === kind);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      if (selectedPreset) {
        if (!clientId.trim() || !clientSecret.trim()) {
          throw new Error(t('portachiavi.clientIdESecretRichiesti'));
        }
        let list = await api.saveVaultKey({
          name: selectedPreset.idKey,
          value: clientId.trim(),
          note: note.trim() || t('portachiavi.clientIdNota', { label: selectedPreset.label }),
        });
        list = await api.saveVaultKey({
          name: selectedPreset.secretKey,
          value: clientSecret.trim(),
          note: note.trim() || t('portachiavi.clientSecretNota', { label: selectedPreset.label }),
        });
        onSaved(list, selectedPreset.label);
        setClientId('');
        setClientSecret('');
        setNote('');
      } else if (kind === 'login') {
        const n = name.trim().toUpperCase();
        if (site.trim()) await api.saveVaultKey({ name: `${n}_URL`, value: site.trim(), note });
        await api.saveVaultKey({ name: `${n}_USER`, value: user.trim(), note });
        onSaved(await api.saveVaultKey({ name: `${n}_PASSWORD`, value, note }), n);
        setName('');
        setSite('');
        setUser('');
        setValue('');
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
        {t('portachiavi.aggiungiOSostituisci')}
      </h3>

      <div>
        <label htmlFor={`${id}-kind`}>{t('portachiavi.tipoChiave')}</label>
        <select
          id={`${id}-kind`}
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as typeof kind);
            setErr('');
          }}
          style={{ width: '100%', marginTop: 4, padding: '6px 8px' }}
        >
          <option value="custom">{t('portachiavi.tipoSingola')}</option>
          <option value="login">{t('portachiavi.tipoSito')}</option>
          <option value="google_oauth">{t('portachiavi.tipoGoogle')}</option>
          <option value="github_oauth">{t('portachiavi.tipoGithub')}</option>
        </select>
      </div>

      {selectedPreset ? (
        <div className="add-key-grid">
          <div>
            <label htmlFor={`${id}-cid`}>{t('portachiavi.clientId')}</label>
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
            <label htmlFor={`${id}-sec`}>{t('portachiavi.clientSecret')}</label>
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
            <label htmlFor={`${id}-o`}>{t('portachiavi.notaFacoltativa')}</label>
            <input
              id={`${id}-o`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t('portachiavi.notaPlaceholder', { label: selectedPreset.label })}
              maxLength={200}
            />
          </div>
        </div>
      ) : kind === 'login' ? (
        <div className="add-key-grid">
          <div>
            <label htmlFor={`${id}-n`}>{t('portachiavi.nome')}</label>
            <input
              id={`${id}-n`}
              className="mono-input"
              value={name}
              onChange={(e) => setName(e.target.value.toUpperCase())}
              placeholder="LINKEDIN"
              autoComplete="off"
              spellCheck={false}
              pattern="[A-Z][A-Z0-9_]{1,50}"
              aria-describedby={`${id}-nh`}
              required
            />
            <p id={`${id}-nh`} className="hint">
              {t('portachiavi.sitoNomeHint', { nome: name.trim() || 'LINKEDIN' })}
            </p>
          </div>
          <div>
            <label htmlFor={`${id}-s`}>{t('portachiavi.sitoIndirizzo')}</label>
            <input id={`${id}-s`} type="url" value={site} onChange={(e) => setSite(e.target.value)} placeholder="https://www.linkedin.com/login" autoComplete="off" spellCheck={false} />
          </div>
          <div>
            <label htmlFor={`${id}-u`}>{t('portachiavi.sitoUtente')}</label>
            <input id={`${id}-u`} value={user} onChange={(e) => setUser(e.target.value)} autoComplete="off" spellCheck={false} required />
          </div>
          <div>
            <label htmlFor={`${id}-v`}>{t('portachiavi.sitoPassword')}</label>
            <input id={`${id}-v`} type="password" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="new-password" spellCheck={false} required />
          </div>
          <div className="add-key-note">
            <label htmlFor={`${id}-o`}>{t('portachiavi.notaFacoltativa')}</label>
            <input id={`${id}-o`} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('portachiavi.sitoNotaEsempio')} maxLength={200} />
          </div>
        </div>
      ) : (
        <div className="add-key-grid">
          <div>
            <label htmlFor={`${id}-n`}>{t('portachiavi.nome')}</label>
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
              {t('portachiavi.nomeHint')}
            </p>
          </div>
          <div>
            <label htmlFor={`${id}-v`}>{t('portachiavi.valore')}</label>
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
            <label htmlFor={`${id}-o`}>{t('portachiavi.notaFacoltativa')}</label>
            <input id={`${id}-o`} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('portachiavi.notaEsempio')} maxLength={200} />
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
          disabled={
            busy ||
            (selectedPreset ? !clientId.trim() || !clientSecret.trim() : !name.trim() || !value || (kind === 'login' && !user.trim()))
          }
        >
          {selectedPreset
            ? t('portachiavi.salvaPreset', { label: selectedPreset.label })
            : kind === 'login'
              ? t('portachiavi.salvaAccesso')
              : t('portachiavi.salvaChiave')}
        </button>
      </div>
    </form>
  );
}
