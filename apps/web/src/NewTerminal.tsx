import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ProjectPicker } from './ProjectPicker';

interface Props {
  open: boolean;
  /** Cartella proposta (es. quella della conversazione aperta) */
  initialCwd?: string;
  error?: string;
  busy: boolean;
  onClose: () => void;
  onCreate: (cwd: string, command?: 'claude') => void;
}

export function NewTerminalDialog({ open, initialCwd, error, busy, onClose, onCreate }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [cwd, setCwd] = useState('');
  const [claude, setClaude] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      if (initialCwd) setCwd(initialCwd);
      d.showModal();
    }
    if (!open && d.open) d.close();
  }, [open]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (cwd.trim()) onCreate(cwd.trim(), claude ? 'claude' : undefined);
  };

  return (
    <dialog ref={ref} className="dialog" aria-labelledby={`${id}-title`} onClose={onClose}>
      <form onSubmit={submit}>
        <h2 id={`${id}-title`}>Nuovo terminale</h2>

        <ProjectPicker active={open} cwd={cwd} onChange={setCwd} />

        <label className="check-row">
          <input type="checkbox" checked={claude} onChange={(e) => setClaude(e.target.checked)} />
          <span>Avvia subito Claude Code (interfaccia da terminale)</span>
        </label>

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Annulla
          </button>
          <button type="submit" className="btn primary" disabled={busy || !cwd.trim()}>
            {busy ? 'Apertura…' : 'Apri'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
