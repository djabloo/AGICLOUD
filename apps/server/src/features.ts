// Sezioni limitate dal piano (AGICLOUD_FEATURES): "all" o assente = tutto,
// altrimenti elenco separato da virgole (es. "chat,pii").
export const PLAN_ERROR = 'Non incluso nel tuo piano';

// chat resta sempre disponibile (conversazioni, deleghe, permessi, notifiche);
// impostazioni e portachiavi non sono sezioni limitabili e non passano di qui.
const SECTION_PREFIXES: [string, string][] = [
  ['/api/terminals', 'terminal'],
  ['/api/files', 'files'],
  ['/api/design', 'design'],
  ['/preview/', 'design'],
  ['/api/browser', 'browser'],
  ['/browser-start', 'browser'],
  ['/api/pii', 'pii'],
  ['/api/verdict', 'verdict'],
  ['/verdict-api', 'verdict'],
  ['/api/flow', 'flow'],
  ['/flow-api', 'flow'],
  ['/api/cloud', 'cloud'],
];

/** Legge AGICLOUD_FEATURES una volta: null = tutto consentito */
export function parseFeatures(raw: string | undefined): Set<string> | null {
  if (!raw || raw.trim() === '' || raw.trim().toLowerCase() === 'all') return null;
  const set = new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  return set.size ? set : null;
}

/** Sezione della route, oppure null se non e' una sezione limitabile */
export function sectionOf(path: string): string | null {
  for (const [prefix, section] of SECTION_PREFIXES) {
    if (path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : prefix + '/') || path.startsWith(prefix + '?')) {
      return section;
    }
  }
  return null;
}

/** true se la sezione e' consentita dal piano (null = tutto) */
export function isAllowed(features: Set<string> | null, section: string): boolean {
  if (!features) return true;
  return features.has(section);
}
