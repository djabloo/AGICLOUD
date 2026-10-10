// Plugin Verdict: una domanda su un testo -> la risposta con quanto e' sicura.
// Tre passi: cosa valutare, la domanda, Decidi. Gli esempi sono solo punti di partenza.
import { useId, useState, type FormEvent, type KeyboardEvent } from 'react';
import { api, type VerdictResult, type VerdictType } from './api';

interface Preset {
  label: string;
  question: string;
  type: VerdictType;
  options?: string[];
  text: string;
}

const PRESETS: Preset[] = [
  {
    label: 'Smistare un ticket',
    question: 'Di che tipo di richiesta si tratta?',
    type: 'choice',
    options: ['Fatturazione e pagamenti', 'Problema tecnico', 'Richiesta commerciale', 'Altro'],
    text: 'Non riesco a fare il login: dopo la password la pagina si ricarica e basta.',
  },
  { label: 'Quanto e\' urgente', question: 'Quanto e\' urgente, da 1 (per niente) a 5 (massimo)?', type: 'score', text: 'Il sito e\' lento da un\'ora per tutti gli utenti, ma funziona.' },
  {
    label: 'Revisione del codice',
    question: 'Questa modifica si puo\' unire?',
    type: 'choice',
    options: ['Approva', 'Chiedi modifiche', 'Blocca per sicurezza'],
    text: 'const token = req.query.token;\ndb.query("SELECT * FROM users WHERE token = \'" + token + "\'");',
  },
  {
    label: 'Moderare un commento',
    question: 'Il commento e\' da pubblicare?',
    type: 'choice',
    options: ['Accettabile', 'Spam o pubblicita\'', 'Offensivo o molesto'],
    text: 'GUADAGNA 5000€ AL MESE DA CASA!!! Clicca qui',
  },
  { label: 'Vero o falso', question: 'L\'affermazione e\' vera?', type: 'yesno', text: 'Parigi e\' la capitale della Germania.' },
];

const TYPES: { id: VerdictType; label: string }[] = [
  { id: 'yesno', label: 'Si\' / No' },
  { id: 'choice', label: 'Una tra…' },
  { id: 'score', label: 'Voto da 1 a 5' },
];

export function VerdictView() {
  const id = useId();
  const [text, setText] = useState('');
  const [question, setQuestion] = useState('');
  const [type, setType] = useState<VerdictType>('yesno');
  const [options, setOptions] = useState<string[]>([]);
  const [newOption, setNewOption] = useState('');
  const [double, setDouble] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<VerdictResult | null>(null);
  const [explaining, setExplaining] = useState(false);

  const usePreset = (p: Preset) => {
    setText(p.text);
    setQuestion(p.question);
    setType(p.type);
    setOptions(p.options ?? []);
    setResult(null);
  };

  const addOption = () => {
    const o = newOption.trim();
    if (o && !options.includes(o) && options.length < 20) setOptions([...options, o]);
    setNewOption('');
  };

  const run = async (explain = false) => {
    setError('');
    if (!explain) setResult(null);
    if (explain) setExplaining(true);
    else setBusy(true);
    try {
      setResult(await api.verdict({ text, question, type, options: type === 'choice' ? options : undefined, mode: double ? 'double' : 'fast', explain }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setExplaining(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run();
  };

  // Ctrl/Cmd+Invio dal testo: decide subito
  const onTextKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void run();
    }
  };

  const ready = text.trim() && question.trim() && (type !== 'choice' || options.length >= 2);
  const pct = (p: number) => `${Math.round(p * 100)}%`;

  return (
    <section className="verdict" aria-labelledby={`${id}-title`}>
      <header className="chat-header">
        <div className="chat-heading">
          <h1 id={`${id}-title`}>Verdict</h1>
          <p className="chat-meta">Una domanda su un testo: la risposta e quanto e' sicura</p>
        </div>
      </header>

      <div className="pii-body">
        <div className="verdict-presets" role="group" aria-label="Parti da un esempio">
          <span className="hint">Parti da un esempio:</span>
          {PRESETS.map((p) => (
            <button key={p.label} type="button" className="btn small-btn" onClick={() => usePreset(p)}>
              {p.label}
            </button>
          ))}
        </div>

        <form className="pii-card" onSubmit={submit}>
          <div className="pii-field">
            <label htmlFor={`${id}-text`}>
              <span className="verdict-step" aria-hidden="true">1</span> Cosa valutare
            </label>
            <textarea id={`${id}-text`} rows={6} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onTextKey} placeholder="Incolla un testo, un messaggio, un pezzo di codice…" />
          </div>

          <div className="pii-field">
            <label htmlFor={`${id}-q`}>
              <span className="verdict-step" aria-hidden="true">2</span> La domanda
            </label>
            <input id={`${id}-q`} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Es. È una richiesta di rimborso?" />
          </div>

          <fieldset className="pii-mode">
            <legend>Tipo di risposta</legend>
            {TYPES.map((t) => (
              <label key={t.id} className="choice">
                <input type="radio" name={`${id}-type`} checked={type === t.id} onChange={() => setType(t.id)} />
                <span>{t.label}</span>
              </label>
            ))}
          </fieldset>

          {type === 'choice' && (
            <div className="pii-field">
              <label htmlFor={`${id}-opt`}>Opzioni (almeno due)</label>
              {options.length > 0 && (
                <ul className="verdict-options">
                  {options.map((o) => (
                    <li key={o}>
                      <span>{o}</span>
                      <button type="button" onClick={() => setOptions(options.filter((x) => x !== o))}>
                        <span aria-hidden="true">×</span>
                        <span className="visually-hidden">Togli l'opzione {o}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="secret-row">
                <input
                  id={`${id}-opt`}
                  value={newOption}
                  onChange={(e) => setNewOption(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addOption();
                    }
                  }}
                  placeholder="Scrivi un'opzione e premi Invio"
                />
                <button type="button" className="btn" onClick={addOption}>
                  Aggiungi
                </button>
              </div>
            </div>
          )}

          <label className="choice">
            <input type="checkbox" checked={double} onChange={(e) => setDouble(e.target.checked)} aria-describedby={`${id}-double-hint`} />
            <span className="choice-text">
              <span>Piu' sicuro: due modelli</span>
              <span className="hint" id={`${id}-double-hint`}>
                Fa la media di due modelli diversi e ti avvisa se non sono d'accordo. Un po' piu' lento.
              </span>
            </span>
          </label>

          <div className="agent-actions">
            <button type="submit" className="btn primary" disabled={busy || !ready}>
              <span className="verdict-step" aria-hidden="true">3</span> {busy ? 'Decido…' : 'Decidi'}
            </button>
          </div>
        </form>

        {error && (
          <p className="pii-msg pii-msg-err" role="alert">
            {error}
          </p>
        )}

        <div aria-live="polite">
          {result && (
            <section className={`pii-card verdict-result${result.uncertain ? ' is-uncertain' : ''}`} aria-labelledby={`${id}-res`}>
              <h2 id={`${id}-res`} className="verdict-answer">
                {result.answer} <span className="verdict-conf">· {pct(result.confidence)}</span>
              </h2>
              {result.uncertain && <p className="verdict-warn">Incerto: {result.note}</p>}
              {result.expected !== undefined && <p className="hint">Voto atteso: {result.expected}</p>}
              <ul className="verdict-bars" aria-label="Probabilita' di ogni opzione">
                {result.probabilities.map((p) => (
                  <li key={p.option}>
                    <span className="verdict-bar-label">{p.option}</span>
                    <span className="verdict-bar" aria-hidden="true">
                      <span style={{ width: pct(p.p) }} />
                    </span>
                    <span className="verdict-bar-pct">{pct(p.p)}</span>
                  </li>
                ))}
              </ul>
              {result.explanation ? (
                <p className="verdict-why">{result.explanation}</p>
              ) : (
                <button type="button" className="btn small-btn verdict-why-btn" disabled={explaining} onClick={() => void run(true)}>
                  {explaining ? 'Ci penso…' : 'Perché?'}
                </button>
              )}
              <p className="hint">
                {result.models.join(' + ')}
                {result.method === 'campioni' && ' · probabilita\' dal voto di 7 risposte'} · {(result.ms / 1000).toFixed(1)} s · costo{' '}
                {result.cost < 0.001 ? 'meno di un decimo di centesimo' : `${(result.cost * 100).toFixed(2)} centesimi`}
              </p>
            </section>
          )}
        </div>

        <details className="pii-card">
          <summary className="verdict-n8n-summary">Usalo da n8n o da uno script</summary>
          <p>
            Un nodo HTTP Request con metodo POST verso <code>https://app.agicloud.dev/api/verdict/decide</code>, intestazione{' '}
            <code>Authorization: Bearer</code> + il token di AgiCloud (meglio come credenziale di n8n, non scritto nel nodo) e corpo JSON:
          </p>
          <pre className="pii-out">{`{
  "text": "testo da valutare",
  "question": "È urgente?",
  "type": "yesno",            // oppure "choice" con "options": [...], oppure "score"
  "mode": "fast"              // oppure "double"
}`}</pre>
          <p className="hint">Risposta: answer, confidence, probabilities, uncertain, note. Gli agenti in chat hanno lo strumento "verdetto".</p>
        </details>
      </div>
    </section>
  );
}
