// Plugin Verdict: una domanda su un testo -> la risposta con quanto e' sicura.
// Tre passi: cosa valutare, la domanda, Decidi. Gli esempi sono solo punti di partenza.
import { useId, useState, type FormEvent, type KeyboardEvent } from 'react';
import { api, type VerdictResult, type VerdictType } from './api';
import { useT } from './i18n';

type TFN = ReturnType<typeof useT>;

interface Preset {
  label: string;
  question: string;
  type: VerdictType;
  options?: string[];
  text: string;
}

function getPresets(t: TFN): Preset[] {
  return [
    {
      label: t('verdict.preset1Label'),
      question: t('verdict.preset1Question'),
      type: 'choice',
      options: [t('verdict.preset1Opt1'), t('verdict.preset1Opt2'), t('verdict.preset1Opt3'), t('verdict.preset1Opt4')],
      text: t('verdict.preset1Text'),
    },
    {
      label: t('verdict.preset2Label'),
      question: t('verdict.preset2Question'),
      type: 'score',
      text: t('verdict.preset2Text'),
    },
    {
      label: t('verdict.preset3Label'),
      question: t('verdict.preset3Question'),
      type: 'choice',
      options: [t('verdict.preset3Opt1'), t('verdict.preset3Opt2'), t('verdict.preset3Opt3')],
      text: t('verdict.preset3Text'),
    },
    {
      label: t('verdict.preset4Label'),
      question: t('verdict.preset4Question'),
      type: 'choice',
      options: [t('verdict.preset4Opt1'), t('verdict.preset4Opt2'), t('verdict.preset4Opt3')],
      text: t('verdict.preset4Text'),
    },
    {
      label: t('verdict.preset5Label'),
      question: t('verdict.preset5Question'),
      type: 'yesno',
      text: t('verdict.preset5Text'),
    },
  ];
}

function getTypes(t: TFN): { id: VerdictType; label: string }[] {
  return [
    { id: 'yesno', label: t('verdict.typeYesno') },
    { id: 'choice', label: t('verdict.typeChoice') },
    { id: 'score', label: t('verdict.typeScore') },
  ];
}

export function VerdictView() {
  const t = useT();
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

  const PRESETS = getPresets(t);
  const TYPES = getTypes(t);

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
          <p className="chat-meta">{t('verdict.subtitle')}</p>
        </div>
      </header>

      <div className="pii-body">
        <div className="verdict-presets" role="group" aria-label={t('verdict.presetsAria')}>
          <span className="hint">{t('verdict.presetsHint')}</span>
          {PRESETS.map((p) => (
            <button key={p.label} type="button" className="btn small-btn" onClick={() => usePreset(p)}>
              {p.label}
            </button>
          ))}
        </div>

        <form className="pii-card" onSubmit={submit}>
          <div className="pii-field">
            <label htmlFor={`${id}-text`}>
              <span className="verdict-step" aria-hidden="true">1</span> {t('verdict.step1')}
            </label>
            <textarea id={`${id}-text`} rows={6} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onTextKey} placeholder={t('verdict.textPlaceholder')} />
          </div>

          <div className="pii-field">
            <label htmlFor={`${id}-q`}>
              <span className="verdict-step" aria-hidden="true">2</span> {t('verdict.step2')}
            </label>
            <input id={`${id}-q`} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder={t('verdict.questionPlaceholder')} />
          </div>

          <fieldset className="pii-mode">
            <legend>{t('verdict.answerType')}</legend>
            {TYPES.map((ty) => (
              <label key={ty.id} className="choice">
                <input type="radio" name={`${id}-type`} checked={type === ty.id} onChange={() => setType(ty.id)} />
                <span>{ty.label}</span>
              </label>
            ))}
          </fieldset>

          {type === 'choice' && (
            <div className="pii-field">
              <label htmlFor={`${id}-opt`}>{t('verdict.optionsLabel')}</label>
              {options.length > 0 && (
                <ul className="verdict-options">
                  {options.map((o) => (
                    <li key={o}>
                      <span>{o}</span>
                      <button type="button" onClick={() => setOptions(options.filter((x) => x !== o))}>
                        <span aria-hidden="true">×</span>
                        <span className="visually-hidden">{t('verdict.removeOption', { o })}</span>
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
                  placeholder={t('verdict.optionPlaceholder')}
                />
                <button type="button" className="btn" onClick={addOption}>
                  {t('verdict.add')}
                </button>
              </div>
            </div>
          )}

          <label className="choice">
            <input type="checkbox" checked={double} onChange={(e) => setDouble(e.target.checked)} aria-describedby={`${id}-double-hint`} />
            <span className="choice-text">
              <span>{t('verdict.safer')}</span>
              <span className="hint" id={`${id}-double-hint`}>
                {t('verdict.doubleHint')}
              </span>
            </span>
          </label>

          <div className="agent-actions">
            <button type="submit" className="btn primary" disabled={busy || !ready}>
              <span className="verdict-step" aria-hidden="true">3</span> {busy ? t('verdict.deciding') : t('verdict.decide')}
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
              {result.uncertain && <p className="verdict-warn">{t('verdict.uncertain', { note: result.note ?? '' })}</p>}
              {result.expected !== undefined && <p className="hint">{t('verdict.expected', { v: result.expected })}</p>}
              <ul className="verdict-bars" aria-label={t('verdict.probsAria')}>
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
                  {explaining ? t('verdict.thinking') : t('verdict.why')}
                </button>
              )}
              <p className="hint">
                {result.models.join(' + ')}
                {result.method === 'campioni' && ` · ${t('verdict.samples')}`} · {(result.ms / 1000).toFixed(1)} s · costo{' '}
                {result.cost < 0.001 ? t('verdict.costTiny') : t('verdict.costCentesimi', { c: (result.cost * 100).toFixed(2) })}
              </p>
            </section>
          )}
        </div>

        <details className="pii-card">
          <summary className="verdict-n8n-summary">{t('verdict.n8nTitle')}</summary>
          <p>
            {t('verdict.n8nPre')} <code>https://app.agicloud.dev/api/verdict/decide</code>, {t('verdict.n8nMid')}{' '}
            <code>Authorization: Bearer</code> {t('verdict.n8nPost')}
          </p>
          <pre className="pii-out">{`{
  "text": "testo da valutare",
  "question": "È urgente?",
  "type": "yesno",            // oppure "choice" con "options": [...], oppure "score"
  "mode": "fast"              // oppure "double"
}`}</pre>
          <p className="hint">{t('verdict.answerHint')}</p>
        </details>
      </div>
    </section>
  );
}
