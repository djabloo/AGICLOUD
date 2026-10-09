// Sezione Design: catalogo del plugin (skill e design system da Open Design).
// "Prova" apre una nuova conversazione con la scelta gia' fatta.

import { useEffect, useState } from 'react';
import type { DesignCatalog, DesignChoice } from './api';
import { loadDesignCatalog } from './DesignPreview';

export function DesignView({ onTry }: { onTry: (choice: DesignChoice) => void }) {
  const [catalog, setCatalog] = useState<DesignCatalog | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    loadDesignCatalog()
      .then(setCatalog)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  return (
    <section className="welcome" aria-labelledby="design-title">
      <h1 id="design-title">Design</h1>
      <p>Skill e stili di Open Design: scegline uno e l'agente scrive le pagine nel progetto, con anteprima dal vivo nella chat.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      {catalog && (
        <>
          <h2>Design system</h2>
          <ul className="agent-list">
            {catalog.systems.map((s) => (
              <li key={s.id}>
                <button type="button" className="btn" onClick={() => onTry({ system: s.id })}>
                  {s.name}
                </button>
                <span className="hint"> — {s.description}</span>
              </li>
            ))}
          </ul>
          <h2>Skill</h2>
          <ul className="agent-list">
            {catalog.skills.map((s) => (
              <li key={s.id}>
                <button type="button" className="btn" onClick={() => onTry({ skill: s.id })}>
                  {s.name}
                </button>
                <span className="hint"> — {s.description}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
