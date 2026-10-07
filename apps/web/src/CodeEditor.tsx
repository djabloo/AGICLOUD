import { useEffect, useRef } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Compartment } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { oneDark } from '@codemirror/theme-one-dark';

interface Props {
  /** Cambia quando si apre un altro file: l'editor riparte da zero */
  docKey: string;
  filename: string;
  initial: string;
  label: string;
  onChange: (text: string) => void;
  onSave: () => void;
}

const dark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;

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
          dark() ? oneDark : [],
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
