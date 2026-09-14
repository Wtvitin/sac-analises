import { useEffect, useState, type FormEvent } from 'react';
import {
  CircleAlert,
  Eye,
  EyeOff,
  FileCheck2,
  History,
  LoaderCircle,
  LockKeyhole,
  Mail,
  ShieldCheck,
  UserRound,
  Zap,
} from 'lucide-react';
import { App } from './App';
import { apiRequest, type AuthUser } from './api';

type AuthMode = 'login' | 'register';
type Feedback = { kind: 'error' | 'info' | 'success'; text: string };
type LoginErrors = Partial<Record<'email' | 'password', string>>;

const benefits = [
  { label: 'Casos centralizados', icon: FileCheck2 },
  { label: 'Histórico rastreável', icon: History },
  { label: 'Análises mais rápidas', icon: Zap },
];

function validateLogin(email: string, password: string): LoginErrors {
  const errors: LoginErrors = {};
  if (!email.trim()) errors.email = 'Informe seu e-mail corporativo.';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Informe um e-mail válido.';
  if (!password) errors.password = 'Informe sua senha.';
  else if (password.length < 8) errors.password = 'A senha deve ter pelo menos 8 caracteres.';
  return errors;
}

export function AuthGateway() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('sac_token') ?? sessionStorage.getItem('sac_token');
    if (!token) {
      setChecking(false);
      return;
    }
    apiRequest<AuthUser>('/auth/me')
      .then(setUser)
      .catch(() => {
        localStorage.removeItem('sac_token');
        sessionStorage.removeItem('sac_token');
      })
      .finally(() => setChecking(false));
  }, []);

  const logout = () => {
    localStorage.removeItem('sac_token');
    sessionStorage.removeItem('sac_token');
    setUser(null);
  };

  if (checking) return <div className="app-loading"><span /><p>Carregando ambiente seguro...</p></div>;
  return user ? <App user={user} onLogout={logout} /> : <AuthScreen onAuthenticated={setUser} />;
}

function AuthScreen({ onAuthenticated }: { onAuthenticated: (user: AuthUser) => void }) {
  const registrationEnabled = import.meta.env.VITE_REGISTRATION_ENABLED === 'true';
  const [mode, setMode] = useState<AuthMode>('login');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [errors, setErrors] = useState<LoginErrors>({});
  const [form, setForm] = useState({ name: '', email: '', password: '', confirm: '', remember: false });

  const updateField = (field: 'name' | 'email' | 'password' | 'confirm', value: string) => {
    setForm(current => ({ ...current, [field]: value }));
    if ((field === 'email' || field === 'password') && errors[field]) {
      setErrors(current => ({ ...current, [field]: undefined }));
    }
  };

  const validateField = (field: 'email' | 'password') => {
    const next = validateLogin(form.email, form.password);
    setErrors(current => ({ ...current, [field]: next[field] }));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (loading) return;
    setFeedback(null);

    if (mode === 'login') {
      const nextErrors = validateLogin(form.email, form.password);
      setErrors(nextErrors);
      if (Object.keys(nextErrors).length) {
        setFeedback({ kind: 'error', text: 'Revise os campos destacados antes de continuar.' });
        return;
      }
    } else if (form.password !== form.confirm) {
      setFeedback({ kind: 'error', text: 'As senhas não coincidem.' });
      return;
    }

    setLoading(true);
    try {
      if (mode === 'login') {
        const result = await apiRequest<{ token: string; user: AuthUser }>('/auth/login', {
          method: 'POST',
          body: JSON.stringify({ email: form.email.trim(), password: form.password }),
        });
        (form.remember ? localStorage : sessionStorage).setItem('sac_token', result.token);
        onAuthenticated(result.user);
      } else {
        const result = await apiRequest<{ message: string }>('/auth/register', {
          method: 'POST',
          body: JSON.stringify({ name: form.name, email: form.email, password: form.password }),
        });
        setFeedback({ kind: 'success', text: result.message });
      }
    } catch (error) {
      setFeedback({ kind: 'error', text: error instanceof Error ? error.message : 'Não foi possível continuar.' });
    } finally {
      setLoading(false);
    }
  };

  const changeMode = (nextMode: AuthMode) => {
    setMode(nextMode);
    setFeedback(null);
    setErrors({});
    setShowPassword(false);
  };

  return (
    <main className="auth-page">
      <section className="auth-brand" aria-label="SAC Análises">
        <div className="auth-shape auth-shape-one" aria-hidden="true" />
        <div className="auth-shape auth-shape-two" aria-hidden="true" />
        <strong className="auth-wordmark">SAC <em>Análises</em></strong>
        <div className="auth-brand-content">
          <h1>Transforme ocorrências em decisões melhores.</h1>
          <p>Centralize casos, responsáveis, prazos e causas em um único fluxo de trabalho.</p>
          <ul>
            {benefits.map(({ label, icon: Icon }) => (
              <li key={label}><span><Icon aria-hidden="true" /></span>{label}</li>
            ))}
          </ul>
        </div>
      </section>

      <section className="auth-panel">
        <strong className="auth-mobile-wordmark">SAC <em>Análises</em></strong>
        <form className="auth-card" onSubmit={submit} noValidate>
          <header>
            <span className="auth-card-icon"><FileCheck2 aria-hidden="true" /></span>
            <h2>{mode === 'login' ? 'Acesse sua conta' : 'Crie sua conta'}</h2>
            <p>{mode === 'login' ? 'Entre com seus dados corporativos.' : 'Seu acesso poderá depender da aprovação de um administrador.'}</p>
          </header>

          {mode === 'register' && (
            <label className="auth-field" htmlFor="auth-name">
              <span>Nome completo</span>
              <div className={form.name ? 'is-filled' : ''}>
                <UserRound aria-hidden="true" />
                <input id="auth-name" required value={form.name} onChange={event => updateField('name', event.target.value)} autoComplete="name" />
              </div>
            </label>
          )}

          <label className="auth-field" htmlFor="auth-email">
            <span>E-mail</span>
            <div className={`${form.email ? 'is-filled ' : ''}${errors.email ? 'is-invalid' : ''}`}>
              <Mail aria-hidden="true" />
              <input
                id="auth-email"
                required
                type="email"
                value={form.email}
                onChange={event => updateField('email', event.target.value)}
                onBlur={() => mode === 'login' && validateField('email')}
                placeholder="nome@empresa.com.br"
                autoComplete="email"
                inputMode="email"
                aria-invalid={Boolean(errors.email)}
                aria-describedby={errors.email ? 'auth-email-error' : undefined}
              />
            </div>
            {errors.email && <small id="auth-email-error" className="auth-field-error"><CircleAlert aria-hidden="true" />{errors.email}</small>}
          </label>

          <label className="auth-field" htmlFor="auth-password">
            <span>Senha</span>
            <div className={`${form.password ? 'is-filled ' : ''}${errors.password ? 'is-invalid' : ''}`}>
              <LockKeyhole aria-hidden="true" />
              <input
                id="auth-password"
                required
                minLength={mode === 'login' ? 8 : 10}
                type={showPassword ? 'text' : 'password'}
                value={form.password}
                onChange={event => updateField('password', event.target.value)}
                onBlur={() => mode === 'login' && validateField('password')}
                placeholder="Digite sua senha"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                aria-invalid={Boolean(errors.password)}
                aria-describedby={errors.password ? 'auth-password-error' : undefined}
              />
              <button type="button" className="auth-password-toggle" aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'} aria-pressed={showPassword} onClick={() => setShowPassword(current => !current)}>
                {showPassword ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
              </button>
            </div>
            {errors.password && <small id="auth-password-error" className="auth-field-error"><CircleAlert aria-hidden="true" />{errors.password}</small>}
          </label>

          {mode === 'register' && (
            <label className="auth-field" htmlFor="auth-confirm">
              <span>Confirmar senha</span>
              <div className={form.confirm ? 'is-filled' : ''}>
                <LockKeyhole aria-hidden="true" />
                <input id="auth-confirm" required minLength={10} type={showPassword ? 'text' : 'password'} value={form.confirm} onChange={event => updateField('confirm', event.target.value)} autoComplete="new-password" />
              </div>
            </label>
          )}

          {mode === 'login' && (
            <div className="auth-options">
              <label className="auth-check"><input type="checkbox" checked={form.remember} onChange={event => setForm(current => ({ ...current, remember: event.target.checked }))} /><span aria-hidden="true" />Lembrar de mim</label>
              <button type="button" onClick={() => setFeedback({ kind: 'info', text: 'Solicite a redefinição de senha ao administrador do sistema.' })}>Esqueci minha senha</button>
            </div>
          )}

          <div className="auth-feedback" aria-live="polite" aria-atomic="true">
            {feedback && <p className={`auth-message auth-message-${feedback.kind}`} role={feedback.kind === 'error' ? 'alert' : 'status'}>{feedback.text}</p>}
          </div>

          <button className="primary auth-submit" disabled={loading} aria-busy={loading}>
            {loading && <LoaderCircle className="auth-spinner" aria-hidden="true" />}
            {loading ? 'Entrando...' : mode === 'login' ? 'Entrar' : 'Criar conta'}
          </button>

          {mode === 'login' && <p className="auth-help">Problemas para acessar? Fale com o administrador.</p>}
          <footer>
            {mode === 'register' ? <>Já possui uma conta? <button type="button" onClick={() => changeMode('login')}>Voltar ao login</button></> : registrationEnabled ? <>Ainda não possui acesso? <button type="button" onClick={() => changeMode('register')}>Solicitar cadastro</button></> : null}
            <span className="auth-secure"><ShieldCheck aria-hidden="true" />Ambiente interno e seguro</span>
          </footer>
        </form>
      </section>
    </main>
  );
}
