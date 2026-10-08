import { useEffect, useRef } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';

import { languages } from '@codemirror/language-data';
import { oneDark } from '@codemirror/theme-one-dark';
import { isDark } from './theme';

interface Props {
  /** Cambia quando si apre un altro file: l'editor riparte da zero */
  docKey: string;
  filename: string;
  initial: string;
  label: string;
  onChange: (text: string) => void;
  onSave: () => void;
}

const dark = isDark;

/**
 * One Dark usa #7d8799 su #282c34 per commenti e numeri di riga: ~3,8:1, sotto il 4,5:1 WCAG AA.
 * Lo stesso vale per il corallo. Qui colori piu' chiari (>= 6:1) con priorita' massima, solo in tema scuro.
 */
const darkContrastFix = [
  Prec.highest(
    syntaxHighlighting(
      HighlightStyle.define([
        { tag: [tags.comment, tags.meta], color: '#a0a8b7' },
        // corallo #e06c75 (~4,4:1) -> #ef8f97 (~6:1): titoli, nomi, proprieta'
        { tag: [tags.name, tags.deleted, tags.character, tags.propertyName, tags.macroName], color: '#ef8f97' },
        { tag: tags.heading, color: '#ef8f97', fontWeight: 'bold' },
      ]),
    ),
  ),
  EditorView.theme({ '.cm-gutters': { color: '#a0a8b7' } }, { dark: true }),
];

/** Editor CodeMirror: evidenziazione per estensione (linguaggi caricati solo se servono), Ctrl/Cmd+S salva */
export function CodeEditor({ docKey, filename, initial, label, onChange, onSave }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const saveRef = useRef(onSave);
  const changeRef = useRef(onChange);
  saveRef.current = onSave;
  changeRef.current = onChange;

  useEffect(() => {
    const language = new Compartment();
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: initial,
        extensions: [
          basicSetup,
          EditorView.lineWrapping,
          language.of([]),
          dark() ? [oneDark, darkContrastFix] : [],
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                saveRef.current();
                return true;
              },
            },
          ]),
          EditorView.contentAttributes.of({ 'aria-label': label }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) changeRef.current(u.state.doc.toString());
          }),
        ],
      }),
    });
    const desc = LanguageDescription.matchFilename(languages, filename);
    desc
      ?.load()
      .then((support) => view.dispatch({ effects: language.reconfigure(support) }))
      .catch(() => {});
    return () => view.destroy();
  }, [docKey]);

  return <div className="code-editor" ref={host} />;
}
