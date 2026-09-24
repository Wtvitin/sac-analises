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

type AuthMode = 'login' | 'register' | 'forgot-password';
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
  const [resetToken, setResetToken] = useState<string | null>(null);

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search);
    const token = searchParams.get('token');
    const action = searchParams.get('action');
    if (token && action === 'reset-password') {
      setResetToken(token);
    }
  }, []);

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
  if (resetToken) {
    return <ResetPasswordView token={resetToken} onComplete={() => {
      setResetToken(null);
      window.history.replaceState({}, '', window.location.pathname);
    }} />;
  }
  if (!user) return <AuthScreen onAuthenticated={setUser} />;
  if (user.mustChangePassword) {
    return <FirstAccessPasswordChange user={user} onLogout={logout} />;
  }
  return <App user={user} onUserChange={setUser} onLogout={logout} />;
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
    } else if (mode === 'forgot-password') {
      if (!form.email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
        setErrors({ email: 'Informe um e-mail corporativo válido.' });
        setFeedback({ kind: 'error', text: 'Informe um e-mail válido para recuperação.' });
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
      } else if (mode === 'forgot-password') {
        const result = await apiRequest<{ message: string }>('/auth/forgot-password', {
          method: 'POST',
          body: JSON.stringify({ email: form.email.trim() }),
        });
        setFeedback({ kind: 'success', title: 'Solicitação processada', text: result.message });
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
            <span className="auth-card-icon">{mode === 'forgot-password' ? <Mail aria-hidden="true" /> : <FileCheck2 aria-hidden="true" />}</span>
            <h2>{mode === 'login' ? 'Acesse sua conta' : mode === 'forgot-password' ? 'Recuperação de senha' : 'Solicitar acesso'}</h2>
            <p>{mode === 'login' ? 'Entre com seus dados corporativos.' : mode === 'forgot-password' ? 'Informe seu e-mail para receber as instruções de redefinição.' : 'Envie seus dados para análise de um administrador.'}</p>
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

          {mode !== 'forgot-password' && (
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
          )}

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
              <button type="button" onClick={() => changeMode('forgot-password')} className="auth-forgot-link">
                Esqueci minha senha
              </button>
            </div>
          )}

          <div className="auth-feedback" aria-live="polite" aria-atomic="true">
            {feedback && <p className={`auth-message auth-message-${feedback.kind}`} role={feedback.kind === 'error' ? 'alert' : 'status'}>{feedback.title && <strong>{feedback.title}</strong>}{feedback.text}</p>}
          </div>

          <button className="primary auth-submit" disabled={loading} aria-busy={loading}>
            {loading && <LoaderCircle className="auth-spinner" aria-hidden="true" />}
            {loading ? (mode === 'login' ? 'Entrando...' : mode === 'forgot-password' ? 'Enviando link...' : 'Enviando...') : (mode === 'login' ? 'Entrar' : mode === 'forgot-password' ? 'Enviar link de recuperação' : 'Enviar solicitação')}
          </button>

          {mode === 'login' && <p className="auth-help">Problemas para acessar? Fale com o administrador.</p>}
          <footer>
            {mode === 'register' ? (
              <>Já possui uma conta? <button type="button" onClick={() => changeMode('login')}>Voltar ao login</button></>
            ) : mode === 'forgot-password' ? (
              <>Lembrou sua senha? <button type="button" onClick={() => changeMode('login')}>Voltar ao login</button></>
            ) : (
              <>Ainda não possui acesso? <button type="button" onClick={() => changeMode('register')}>Solicitar acesso</button></>
            )}
            <span className="auth-secure"><ShieldCheck aria-hidden="true" />Ambiente interno e seguro</span>
          </footer>
        </form>
      </section>
    </main>
  );
}

function FirstAccessPasswordChange({ user, onLogout }: { user: AuthUser; onLogout: () => void }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (loading) return;
    setError('');

    if (!currentPassword) {
      setError('Informe a senha provisória recebida.');
      return;
    }
    if (newPassword.length < 12) {
      setError('A nova senha deve ter pelo menos 12 caracteres.');
      return;
    }
    if (!/[A-Z]/.test(newPassword) || !/[a-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      setError('A nova senha deve conter letras maiúsculas, minúsculas e números.');
      return;
    }
    if (newPassword === currentPassword) {
      setError('A nova senha deve ser diferente da senha provisória.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('As senhas não coincidem.');
      return;
    }

    setLoading(true);
    try {
      await apiRequest('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword, confirmPassword }),
      });
      setSuccess(true);
    } catch (err: any) {
      setError(err instanceof Error ? err.message : 'Não foi possível cadastrar a nova senha.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="auth-page">
      <section className="auth-brand" aria-label="SAC Análises">
        <div className="auth-shape auth-shape-one" aria-hidden="true" />
        <div className="auth-shape auth-shape-two" aria-hidden="true" />
        <strong className="auth-wordmark">SAC <em>Análises</em></strong>
        <div className="auth-brand-content">
          <h1>Primeiro Acesso Seguro</h1>
          <p>Defina sua senha definitiva para desbloquear o acesso completo ao SAC Análises.</p>
        </div>
      </section>

      <section className="auth-panel" aria-label="Defina sua nova senha">
        <div className="auth-head">
          <div className="auth-badge"><ShieldCheck aria-hidden="true" />Primeiro acesso obrigatório</div>
          <h2>Defina sua nova senha</h2>
          <p>Olá, <strong>{user.name}</strong>. Para sua segurança, substitua a senha provisória por uma nova senha pessoal definitiva.</p>
        </div>

        {success ? (
          <div className="auth-feedback" style={{ marginTop: '20px' }}>
            <div className="auth-message auth-message-success" role="status">
              <strong>Senha cadastrada com sucesso!</strong>
              <p>A senha provisória foi invalidada e as sessões anteriores foram revogadas. Acesse sua conta com a nova senha permanente.</p>
            </div>
            <button type="button" className="primary auth-submit" style={{ marginTop: '20px' }} onClick={onLogout}>
              Acessar com a nova senha
            </button>
          </div>
        ) : (
          <form className="auth-form" onSubmit={handleSubmit} noValidate>
            <label className="auth-field" htmlFor="provisional-password">
              <span>Senha provisória recebida</span>
              <div className={currentPassword ? 'is-filled' : ''}>
                <LockKeyhole aria-hidden="true" />
                <input
                  id="provisional-password"
                  required
                  type={showPassword ? 'text' : 'password'}
                  value={currentPassword}
                  onChange={e => setCurrentPassword(e.target.value)}
                  placeholder="Digite a senha provisória"
                  autoComplete="current-password"
                />
              </div>
            </label>

            <label className="auth-field" htmlFor="new-password">
              <span>Nova senha definitiva</span>
              <div className={newPassword ? 'is-filled' : ''}>
                <LockKeyhole aria-hidden="true" />
                <input
                  id="new-password"
                  required
                  minLength={12}
                  maxLength={128}
                  type={showPassword ? 'text' : 'password'}
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                  placeholder="Mínimo 12 caracteres (A-Z, a-z, 0-9)"
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  className="auth-password-toggle"
                  aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
                  onClick={() => setShowPassword(!showPassword)}
                >
                  {showPassword ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                </button>
              </div>
            </label>

            <label className="auth-field" htmlFor="confirm-new-password">
              <span>Confirmar nova senha</span>
              <div className={confirmPassword ? 'is-filled' : ''}>
                <LockKeyhole aria-hidden="true" />
                <input
                  id="confirm-new-password"
                  required
                  minLength={12}
                  maxLength={128}
                  type={showPassword ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={e => setConfirmPassword(e.target.value)}
                  placeholder="Repita a nova senha"
                  autoComplete="new-password"
                />
              </div>
            </label>

            <div className="auth-feedback" aria-live="polite">
              {error && (
                <p className="auth-message auth-message-error" role="alert">
                  <CircleAlert aria-hidden="true" />
                  {error}
                </p>
              )}
            </div>

            <button className="primary auth-submit" disabled={loading} aria-busy={loading}>
              {loading && <LoaderCircle className="auth-spinner" aria-hidden="true" />}
              {loading ? 'Salvando...' : 'Salvar nova senha e continuar'}
            </button>

            <footer style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '16px' }}>
              <button type="button" className="secondary" onClick={onLogout} style={{ border: 'none', background: 'none', color: 'var(--color-muted)', cursor: 'pointer' }}>
                Cancelar e sair
              </button>
              <span className="auth-secure"><ShieldCheck aria-hidden="true" />Ambiente seguro</span>
            </footer>
          </form>
        )}
      </section>
    </main>
  );
}

function ResetPasswordView({ token, onComplete }: { token: string; onComplete: () => void }) {
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (loading) return;
    setError('');

    if (newPassword.length < 12) {
      setError('A nova senha deve ter pelo menos 12 caracteres.');
      return;
    }
    if (!/[A-Z]/.test(newPassword) || !/[a-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      setError('A nova senha deve conter letras maiúsculas, minúsculas e números.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('As senhas não coincidem.');
      return;
    }

    setLoading(true);
    try {
      await apiRequest('/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ token, newPassword, confirmPassword }),
      });
      setSuccess(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Não foi possível redefinir a senha.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="auth-page">
      <section className="auth-brand" aria-label="SAC Análises">
        <div className="auth-shape auth-shape-one" aria-hidden="true" />
        <div className="auth-shape auth-shape-two" aria-hidden="true" />
        <strong className="auth-wordmark">SAC <em>Análises</em></strong>
        <div className="auth-brand-content">
          <h1>Recuperação de Senha</h1>
          <p>Defina uma nova senha segura para reativar seu acesso ao SAC Análises.</p>
        </div>
      </section>

      <section className="auth-panel" aria-label="Redefinir senha">
        <div className="auth-card">
          <header>
            <span className="auth-card-icon"><LockKeyhole aria-hidden="true" /></span>
            <h2>Defina sua nova senha</h2>
            <p>Crie uma senha forte com no mínimo 12 caracteres.</p>
          </header>

          {success ? (
            <div style={{ textAlign: 'center', padding: '16px 0' }}>
              <div style={{ background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: '8px', padding: '16px', color: '#065f46', marginBottom: '20px' }}>
                <p style={{ margin: 0, fontWeight: 'bold' }}>Senha redefinida com sucesso!</p>
                <p style={{ margin: '6px 0 0', fontSize: '13px' }}>Você já pode fazer login com sua nova credencial.</p>
              </div>
              <button type="button" className="primary auth-submit" onClick={onComplete}>
                Ir para o login
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} noValidate>
              <label className="auth-field" htmlFor="reset-new-password">
                <span>Nova senha</span>
                <div className={newPassword ? 'is-filled' : ''}>
                  <LockKeyhole aria-hidden="true" />
                  <input
                    id="reset-new-password"
                    required
                    minLength={12}
                    maxLength={128}
                    type={showPassword ? 'text' : 'password'}
                    value={newPassword}
                    onChange={event => setNewPassword(event.target.value)}
                    placeholder="Mínimo 12 caracteres (A-Z, a-z, 0-9)"
                    autoComplete="new-password"
                  />
                  <button
                    type="button"
                    className="auth-password-toggle"
                    aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
                    onClick={() => setShowPassword(current => !current)}
                  >
                    {showPassword ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                  </button>
                </div>
              </label>

              <label className="auth-field" htmlFor="reset-confirm-password">
                <span>Confirmar nova senha</span>
                <div className={confirmPassword ? 'is-filled' : ''}>
                  <LockKeyhole aria-hidden="true" />
                  <input
                    id="reset-confirm-password"
                    required
                    minLength={12}
                    maxLength={128}
                    type={showPassword ? 'text' : 'password'}
                    value={confirmPassword}
                    onChange={event => setConfirmPassword(event.target.value)}
                    placeholder="Repita a nova senha"
                    autoComplete="new-password"
                  />
                </div>
              </label>

              {error && (
                <div className="auth-feedback">
                  <p className="auth-message auth-message-error" role="alert">
                    <CircleAlert aria-hidden="true" />
                    {error}
                  </p>
                </div>
              )}

              <button className="primary auth-submit" disabled={loading} aria-busy={loading}>
                {loading && <LoaderCircle className="auth-spinner" aria-hidden="true" />}
                {loading ? 'Salvando...' : 'Salvar nova senha'}
              </button>

              <footer style={{ marginTop: '16px', textAlign: 'center' }}>
                <button type="button" onClick={onComplete} style={{ border: 'none', background: 'none', color: 'var(--color-brand)', cursor: 'pointer', fontSize: '13px' }}>
                  Cancelar e voltar ao login
                </button>
              </footer>
            </form>
          )}
        </div>
      </section>
    </main>
  );
}

