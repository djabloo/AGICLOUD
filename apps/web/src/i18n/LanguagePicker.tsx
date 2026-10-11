import { useId } from 'react';
import { LANGS, getLang, setLang, useT, type Lang } from './index';

/** Scelta della lingua: i nomi sono scritti nella lingua stessa, cosi' si riconoscono anche se l'interfaccia e' in una che non si legge */
export function LanguagePicker({ compact = false }: { compact?: boolean }) {
  const t = useT();
  const id = useId();
  return (
    <div className={compact ? 'lang-picker compact' : 'lang-picker'}>
      <label htmlFor={id}>{t('lingua.titolo')}</label>
      <select id={id} value={getLang()} onChange={(e) => setLang(e.target.value as Lang)}>
        {LANGS.map((l) => (
          <option key={l.id} value={l.id} lang={l.id}>
            {l.label}
          </option>
        ))}
      </select>
    </div>
  );
}
