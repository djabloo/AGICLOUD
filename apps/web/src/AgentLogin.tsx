// Login guidato di un agente, senza terminale: apri il link, (se serve) incolla il codice, fatto.
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { api, type GuidedLogin } from './api';
import { useT } from './i18n';
import { copyText } from './termText';

export function AgentLogin({ agentId, label, onClose, onDone }: { agentId: string; label: string; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const id = useId();
  const [login, setLogin] = useState<GuidedLogin | null>(null);
  const [error, setError] = useState('');
  const [code, setCode] = useState('');
  const [copied, setCopied] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);
  const doneRef = useRef(false);

  useEffect(() => {
    headingRef.current?.focus();
    let stopped = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const s = await api.guidedLoginStatus(agentId);
        if (stopped) return;
        setLogin(s);
        if (s?.state === 'done' && !doneRef.current) {
          doneRef.current = true;
          onDone();
        }
        if (s && (s.state === 'waiting' || s.state === 'checking')) timer = window.setTimeout(poll, 1000);
      } catch (err) {
        if (!stopped) setError(err instanceof Error ? err.message : String(err));
      }
    };
    api
      .startGuidedLogin(agentId)
      .then((s) => {
        if (stopped) return;
        setLogin(s);
        timer = window.setTimeout(poll, 700);
      })
      .catch((err) => !stopped && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
    // Si avvia una volta per apertura del pannello
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  const cancel = () => {
    if (login && (login.state === 'waiting' || login.state === 'checking')) void api.cancelGuidedLogin(agentId).catch(() => {});
    onClose();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    setError('');
    try {
      setLogin(await api.sendGuidedLoginCode(agentId, code));
      setCode(''); // la risposta dell'agente arriva col controllo periodico
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const copy = async () => {
    if (!login?.url) return;
    setCopied((await copyText(login.url)) ? t('agentlogin.linkCopiato') : t('agentlogin.copiaFallita'));
  };

  const state = login?.state;
  const busy = !login || (!login.url && state === 'waiting');
  const STATUS_TEXT: Record<GuidedLogin['state'], string> = {
    waiting: t('agentlogin.statoAttesa'),
    checking: t('agentlogin.statoVerifica'),
    done: t('agentlogin.statoFatto'),
    failed: t('agentlogin.statoFallito'),
  };

  return (
    <section className="guided-login" aria-labelledby={`${id}-title`}>
      <h4 id={`${id}-title`} ref={headingRef} tabIndex={-1}>
        {t('agentlogin.titolo', { label })}
      </h4>
      <p className={`guided-status guided-${state ?? 'waiting'}`} role="status">
        {busy ? t('agentlogin.preparoLink') : STATUS_TEXT[state!]}
      </p>

      {login?.url && state !== 'done' && (
        <ol className="guided-steps">
          <li>
            <span>{t('agentlogin.apriEConferma')}</span>
            <span className="agent-actions">
              <a className="btn primary small-btn" href={login.url} target="_blank" rel="noopener noreferrer">
                {t('agentlogin.apriPagina')}<span className="visually-hidden">{t('agentlogin.nuovaScheda')}</span>
              </a>
              <button type="button" className="btn small-btn" onClick={() => void copy()}>
                {t('agentlogin.copiaLink')}
              </button>
            </span>
            <span className="hint" aria-live="polite">
              {copied}
            </span>
          </li>
          {login.needsCode ? (
            <li>
              <form className="guided-code" onSubmit={(e) => void submit(e)}>
                <label htmlFor={`${id}-code`}>{t('agentlogin.incollaCodice')}</label>
                <div className="secret-row">
                  <input
                    id={`${id}-code`}
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    autoComplete="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    disabled={state === 'checking'}
                    aria-describedby={login.error ? `${id}-err` : undefined}
                    aria-invalid={login.error ? true : undefined}
                  />
                  <button type="submit" className="btn primary" disabled={state === 'checking' || !code.trim()}>
                    {t('agentlogin.inviaCodice')}
                  </button>
                </div>
              </form>
            </li>
          ) : (
            <li>{t('agentlogin.autoAggiorna')}</li>
          )}
        </ol>
      )}

      {(login?.error || error) && (
        <p id={`${id}-err`} className="form-error" role="alert">
          {login?.error || error}
        </p>
      )}

      {login?.output && state !== 'done' && (
        <details className="guided-details">
          <summary>{t('agentlogin.dettagli')}</summary>
          <pre>{login.output}</pre>
        </details>
      )}

      <div className="agent-actions">
        <button type="button" className="btn small-btn" onClick={cancel}>
          {state === 'done' || state === 'failed' ? t('agentlogin.chiudi') : t('agentlogin.annulla')}
        </button>
      </div>
    </section>
  );
}
