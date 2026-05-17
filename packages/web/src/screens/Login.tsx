import { useState, useRef, useEffect } from 'react';
import { api, ApiError } from '../lib/api';

interface Props {
  onAuthenticated: () => void;
}

export function Login({ onAuthenticated }: Props) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    usernameRef.current?.focus();
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await api.login(username.trim(), password);
      onAuthenticated();
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 400)) {
        setError('Credenciais inválidas.');
      } else {
        setError('Erro ao conectar com o servidor.');
      }
      setPassword('');
      passwordRef.current?.focus();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative z-10 mx-auto max-w-[1120px] px-6 pt-16 pb-24 md:px-12 lg:pl-24">
      <div className="rule-bottom pb-8 mb-12">
        <p className="eyebrow mb-3">finanças</p>
        <h1 className="font-display text-5xl font-bold leading-none text-[color:var(--color-ink)]">
          acesso
        </h1>
      </div>

      <form onSubmit={handleSubmit} className="max-w-sm space-y-6">
        <div className="space-y-2">
          <label
            htmlFor="username"
            className="block font-mono text-xs uppercase tracking-widest text-[color:var(--color-ink-muted)]"
          >
            usuário
          </label>
          <input
            ref={usernameRef}
            id="username"
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={loading}
            className="w-full border-b border-[color:var(--color-rule)] bg-transparent pb-2 font-mono text-lg text-[color:var(--color-ink)] placeholder-[color:var(--color-ink-muted)] outline-none focus:border-[color:var(--color-accent)]"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>

        <div className="space-y-2">
          <label
            htmlFor="password"
            className="block font-mono text-xs uppercase tracking-widest text-[color:var(--color-ink-muted)]"
          >
            senha
          </label>
          <input
            ref={passwordRef}
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={loading}
            className="w-full border-b border-[color:var(--color-rule)] bg-transparent pb-2 font-mono text-lg text-[color:var(--color-ink)] placeholder-[color:var(--color-ink-muted)] outline-none focus:border-[color:var(--color-accent)]"
            autoComplete="current-password"
          />
        </div>

        {error && (
          <p className="font-mono text-sm text-[color:var(--color-accent)]">{error}</p>
        )}

        <button
          type="submit"
          disabled={loading || !username || !password}
          className="font-mono text-sm uppercase tracking-widest text-[color:var(--color-ink)] underline underline-offset-4 decoration-[color:var(--color-rule)] hover:decoration-[color:var(--color-accent)] disabled:opacity-40 disabled:no-underline transition-colors"
        >
          {loading ? 'entrando…' : 'entrar →'}
        </button>
      </form>
    </div>
  );
}
