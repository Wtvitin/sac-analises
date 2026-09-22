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
import { apiRequest, setSessionExpiredHandler, type AuthUser } from './api';

type AuthMode = 'login' | 'register';
type Feedback = { kind: 'error' | 'info' | 'success'; title?: string; text: string };
type LoginErrors = Partial<Record<'name' | 'email' | 'password' | 'confirm', string>>;

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
    setSessionExpiredHandler(() => setUser(null));
    apiRequest<AuthUser>('/auth/session')
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setChecking(false));
    return () => setSessionExpiredHandler(undefined);
  }, []);

  const logout = async () => { try { await apiRequest('/auth/logout', { method: 'POST' }); } finally { setUser(null); } };

  if (checking) return <div className="app-loading"><span /><p>Carregando ambiente seguro...</p></div>;
  return user ? <App user={user} onUserChange={setUser} onLogout={logout} /> : <AuthScreen onAuthenticated={setUser} />;
}

function AuthScreen({ onAuthenticated }: { onAuthenticated: (user: AuthUser) => void }) {
  const [registrationEnabled, setRegistrationEnabled] = useState(false);
  const [mode, setMode] = useState<AuthMode>('login');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [errors, setErrors] = useState<LoginErrors>({});
  const [form, setForm] = useState({ name: '', email: '', password: '', confirm: '' });

  useEffect(() => { apiRequest<{ enabled: boolean }>('/auth/registration-config').then(result => setRegistrationEnabled(result.enabled)).catch(() => setRegistrationEnabled(false)); }, []);

  const updateField = (field: 'name' | 'email' | 'password' | 'confirm', value: string) => {
    setForm(current => ({ ...current, [field]: value }));
    if (errors[field]) {
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
    } else {
      const nextErrors: LoginErrors = {};
      if (form.name.trim().length < 3) nextErrors.name = 'Informe seu nome completo.';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) nextErrors.email = 'Informe um e-mail corporativo válido.';
      if (form.password.length < 12) nextErrors.password = 'A senha deve ter pelo menos 12 caracteres.';
      else if (!/[A-Z]/.test(form.password) || !/[a-z]/.test(form.password) || !/[0-9]/.test(form.password)) nextErrors.password = 'Use letras maiúsculas, minúsculas e número.';
      if (form.password !== form.confirm) nextErrors.confirm = 'As senhas não coincidem.';
      setErrors(nextErrors); if (Object.keys(nextErrors).length) { setFeedback({ kind: 'error', text: 'Revise os campos destacados antes de continuar.' }); return; }
    }

    setLoading(true);
    try {
      if (mode === 'login') {
        const result = await apiRequest<{ user: AuthUser }>('/auth/login', {
          method: 'POST',
          body: JSON.stringify({ email: form.email.trim(), password: form.password }),
        });
        onAuthenticated(result.user);
      } else {
        const result = await apiRequest<{ message: string }>('/auth/register', {
          method: 'POST',
          body: JSON.stringify({ name: form.name, email: form.email, password: form.password, confirmPassword: form.confirm }),
        });
        setFeedback({ kind: 'success', title: 'Solicitação enviada', text: result.message });
        setForm(current => ({ ...current, name: '', email: '', password: '', confirm: '' }));
      }
    } catch (error) {
      setFeedback({ kind: 'error', text: error instanceof Error ? error.message : 'Não foi possível continuar.' });
    } finally {
      setLoading(false);
    }
  };

  const changeMode = (nextMode: AuthMode) => {
    if (nextMode === 'register' && !registrationEnabled) { setFeedback({ kind: 'info', text: 'A solicitação pública de acesso está indisponível no momento.' }); return; }
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
            <h2>{mode === 'login' ? 'Acesse sua conta' : 'Solicitar acesso'}</h2>
            <p>{mode === 'login' ? 'Entre com seus dados corporativos.' : 'Envie seus dados para análise de um administrador.'}</p>
          </header>

          {mode === 'register' && (
            <label className="auth-field" htmlFor="auth-name">
              <span>Nome completo</span>
              <div className={`${form.name ? 'is-filled ' : ''}${errors.name ? 'is-invalid' : ''}`}>
                <UserRound aria-hidden="true" />
                <input id="auth-name" required maxLength={120} value={form.name} onChange={event => updateField('name', event.target.value)} autoComplete="name" aria-invalid={Boolean(errors.name)} aria-describedby={errors.name ? 'auth-name-error' : undefined} />
              </div>
              {errors.name && <small id="auth-name-error" className="auth-field-error"><CircleAlert aria-hidden="true" />{errors.name}</small>}
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
                minLength={mode === 'login' ? 8 : 12}
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
              <div className={`${form.confirm ? 'is-filled ' : ''}${errors.confirm ? 'is-invalid' : ''}`}>
                <LockKeyhole aria-hidden="true" />
                <input id="auth-confirm" required minLength={12} maxLength={128} type={showPassword ? 'text' : 'password'} value={form.confirm} onChange={event => updateField('confirm', event.target.value)} autoComplete="new-password" aria-invalid={Boolean(errors.confirm)} aria-describedby={errors.confirm ? 'auth-confirm-error' : undefined} />
              </div>
              {errors.confirm && <small id="auth-confirm-error" className="auth-field-error"><CircleAlert aria-hidden="true" />{errors.confirm}</small>}
            </label>
          )}

          {mode === 'login' && (
            <div className="auth-options">
              <span>Esta sessão usa cookies protegidos.</span>
              <button type="button" disabled aria-describedby="password-recovery-unavailable">Recuperação por e-mail indisponível</button>
              <span id="password-recovery-unavailable" className="sr-only">Solicite a redefinição ao administrador do sistema.</span>
            </div>
          )}

          <div className="auth-feedback" aria-live="polite" aria-atomic="true">
            {feedback && <p className={`auth-message auth-message-${feedback.kind}`} role={feedback.kind === 'error' ? 'alert' : 'status'}>{feedback.title && <strong>{feedback.title}</strong>}{feedback.text}</p>}
          </div>

          <button className="primary auth-submit" disabled={loading} aria-busy={loading}>
            {loading && <LoaderCircle className="auth-spinner" aria-hidden="true" />}
            {loading ? (mode === 'login' ? 'Entrando...' : 'Enviando...') : mode === 'login' ? 'Entrar' : 'Enviar solicitação'}
          </button>

          {mode === 'login' && <p className="auth-help">Problemas para acessar? Fale com o administrador.</p>}
          <footer>
            {mode === 'register' ? <>Já possui uma conta? <button type="button" onClick={() => changeMode('login')}>Voltar ao login</button></> : <>Ainda não possui acesso? <button type="button" onClick={() => changeMode('register')}>Solicitar acesso</button></>}
            <span className="auth-secure"><ShieldCheck aria-hidden="true" />Ambiente interno e seguro</span>
          </footer>
        </form>
      </section>
    </main>
  );
}
