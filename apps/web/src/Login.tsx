import { useId, useState, type FormEvent } from 'react';
import { copyText } from './termText';

export function Login({ error, onSubmit }: { error?: string; onSubmit: (token: string) => void }) {
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
        <label htmlFor={`${id}-token`}>Token di accesso</label>
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
          Entra
        </button>
      </form>
    </main>
  );
}

/** Dopo il link di attivazione: il token definitivo, mostrato una sola volta */
export function SetupDone({ token, onContinue }: { token: string; onContinue: () => void }) {
  const id = useId();
  const [copied, setCopied] = useState('');
  return (
    <main className="login">
      <section className="card" aria-labelledby={`${id}-title`}>
        <h1 id={`${id}-title`}>AgiCloud e' attivo</h1>
        <p>Questo e' il tuo token di accesso. Questo browser lo ricorda gia'; per gli altri dispositivi ti servira': copialo e conservalo (per esempio nel gestore di password).</p>
        <p className="setup-token">
          <code>{token}</code>
        </p>
        <p className="hint">Non verra' piu' mostrato. Il link di attivazione non funziona piu'.</p>
        <div className="agent-actions">
          <button type="button" className="btn" onClick={() => void copyText(token).then((ok) => setCopied(ok ? 'Token copiato' : 'Copia non riuscita: selezionalo e copialo a mano'))}>
            Copia il token
          </button>
          <button type="button" className="btn primary" onClick={onContinue}>
            Continua
          </button>
        </div>
        <p className="hint" aria-live="polite">
          {copied}
        </p>
      </section>
    </main>
  );
}
