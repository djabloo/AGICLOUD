import { useId, useState, type FormEvent } from 'react';

export function Login({ error, onSubmit }: { error?: string; onSubmit: (token: string) => void }) {
  const [token, setTokenValue] = useState('');
  const id = useId();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (token.trim()) onSubmit(token.trim());
  };
  return (
    <main className="login">
      <form className="card" onSubmit={submit} aria-labelledby={`${id}-title`}>
        <h1 id={`${id}-title`}>AgiCloud</h1>
        <label htmlFor={`${id}-token`}>Token di accesso</label>
        <input
          id={`${id}-token`}
          type="password"
          autoComplete="current-password"
          value={token}
          onChange={(e) => setTokenValue(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-err` : undefined}
          required
        />
        {error && (
          <p id={`${id}-err`} className="form-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn primary">
          Entra
        </button>
      </form>
    </main>
  );
}
