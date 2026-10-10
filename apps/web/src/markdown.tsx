import { useMemo } from 'react';
import { Marked } from 'marked';
import DOMPurify from 'dompurify';

const options = { gfm: true, breaks: true };
/** Documenti (es. anteprima di un file): titoli normali */
const docMarked = new Marked(options);
/**
 * Risposte degli agenti in chat: i titoli diventano tutti di livello 2 per i lettori di schermo
 * (la pagina ha il titolo della conversazione al livello 1; un "###" dell'agente saltava i livelli).
 * A vederli restano grandi o piccoli come li ha scritti l'agente.
 */
const chatMarked = new Marked(options, {
  renderer: {
    heading({ tokens, depth }) {
      return `<p class="md-h md-h${depth}" role="heading" aria-level="2">${this.parser.parseInline(tokens)}</p>\n`;
    },
  },
});

// Link esterni in una nuova scheda, senza dare accesso alla pagina
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.getAttribute('href')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

export function Markdown({ text, chat = false }: { text: string; chat?: boolean }) {
  const html = useMemo(
    () => DOMPurify.sanitize((chat ? chatMarked : docMarked).parse(text, { async: false }) as string, { FORBID_ATTR: ['style'] }),
    [text, chat],
  );
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}
