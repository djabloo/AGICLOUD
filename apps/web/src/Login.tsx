import { useId, useState, type FormEvent } from 'react';
import { copyText } from './termText';
import { useT } from './i18n';
import { LanguagePicker } from './i18n/LanguagePicker';

export function Login({ error, onSubmit }: { error?: string; onSubmit: (token: string) => void }) {
  const t = useT();
  const [token, setTokenValue] = useState('');
  const id = useId();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (token.trim()) onSubmit(token.trim());
  };
  return (
    <main className="login">
      <form className="card" onSubmit={submit} aria-labelledby={`${id}-title`}>
        <h1 id={`${id}-title`}>AgiCloud</h1>
        <label htmlFor={`${id}-token`}>{t('login.token')}</label>
        <input
          id={`${id}-token`}
          type="password"
          autoComplete="current-password"
          value={token}
          onChange={(e) => setTokenValue(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-err` : undefined}
          required
        />
        {error && (
          <p id={`${id}-err`} className="form-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn primary">
          {t('login.entra')}
        </button>
        <LanguagePicker compact />
      </form>
    </main>
  );
}

/** Dopo il link di attivazione: il token definitivo, mostrato una sola volta */
export function SetupDone({ token, onContinue }: { token: string; onContinue: () => void }) {
  const t = useT();
  const id = useId();
  const [copied, setCopied] = useState('');
  return (
    <main className="login">
      <section className="card" aria-labelledby={`${id}-title`}>
        <h1 id={`${id}-title`}>{t('login.attivoTitolo')}</h1>
        <p>{t('login.tokenSpiegazione')}</p>
        <p className="setup-token">
          <code>{token}</code>
        </p>
        <p className="hint">{t('login.nonPiuMostrato')}</p>
        <div className="agent-actions">
          <button type="button" className="btn" onClick={() => void copyText(token).then((ok) => setCopied(ok ? t('login.copiato') : t('login.copiaFallita')))}>
            {t('login.copia')}
          </button>
          <button type="button" className="btn primary" onClick={onContinue}>
            {t('login.continua')}
          </button>
        </div>
        <p className="hint" aria-live="polite">
          {copied}
        </p>
      </section>
    </main>
  );
}
