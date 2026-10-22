import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AlertTriangle, LoaderCircle, Trash2, X } from 'lucide-react';
import { apiRequest } from './api';
import type { RecordItem } from './data';

interface DeleteSacRecordModalProps {
  record: RecordItem;
  onClose: () => void;
  onSuccess: (ticket: string) => void;
}

export function DeleteSacRecordModal({ record, onClose, onSuccess }: DeleteSacRecordModalProps) {
  const [justification, setJustification] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const modalRef = useRef<HTMLElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => textareaRef.current?.focus());
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [saving, onClose]);

  const canSubmit = !saving && confirmed && justification.trim().length >= 5;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;

    const trimmed = justification.trim();
    if (trimmed.length < 5) {
      setError('Informe uma justificativa com no mínimo 5 caracteres.');
      return;
    }
    if (!confirmed) {
      setError('Marque a confirmação para autorizar a exclusão.');
      return;
    }

    setSaving(true);
    setError('');

    try {
      await apiRequest(`/sac-records/${record.id || record.ticket}`, {
        method: 'DELETE',
        body: JSON.stringify({
          updatedAt: record.updatedAt || new Date().toISOString(),
          justification: trimmed,
        }),
      });
      onSuccess(record.ticket);
    } catch (err: any) {
      setError(err?.message || 'Não foi possível excluir o registro SAC.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="overlay"
      onMouseDown={event => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <section
        ref={modalRef}
        className="modal delete-sac-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-sac-title"
      >
        <header className="modal-head">
          <div>
            <h2 id="delete-sac-title">Excluir registro</h2>
            <p>
              Caso <strong>{record.ticket}</strong> · {record.customer} (Pedido {record.order})
            </p>
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label="Fechar exclusão de registro"
            disabled={saving}
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </button>
        </header>

        <form onSubmit={handleSubmit} className="delete-sac-form">
          <div className="modal-body">
            <div className="delete-sac-warning" role="note">
              <AlertTriangle aria-hidden="true" />
              <div>
                <strong>Atenção: exclusão lógica com retenção de histórico</strong>
                <p>
                  O caso <strong>{record.ticket}</strong> será removido das consultas operacionais, buscas,
                  relatórios, exportações e indicadores. Seus dados, evidências e histórico completo serão preservados
                  exclusivamente para auditoria administrativa de Administradores.
                </p>
              </div>
            </div>

            <label htmlFor="delete-sac-justification">
              Justificativa da exclusão *
              <textarea
                ref={textareaRef}
                id="delete-sac-justification"
                required
                minLength={5}
                maxLength={1000}
                rows={3}
                placeholder="Informe o motivo da exclusão deste registro para fins de auditoria..."
                value={justification}
                onChange={event => setJustification(event.target.value)}
                disabled={saving}
              />
              <small>
                {justification.trim().length}/1000 caracteres (mínimo de 5 caracteres)
              </small>
            </label>

            <label className="delete-sac-confirm">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={event => setConfirmed(event.target.checked)}
                disabled={saving}
              />
              <span>
                Confirmo a exclusão definitiva do registro <strong>{record.ticket}</strong> e o registro desta justificativa na auditoria administrativa.
              </span>
            </label>

            {error && (
              <div className="inline-error" role="alert">
                {error}
                <button type="button" onClick={() => setError('')}>
                  Fechar
                </button>
              </div>
            )}
          </div>

          <footer className="form-footer">
            <button
              type="button"
              className="secondary"
              disabled={saving}
              onClick={onClose}
            >
              Cancelar
            </button>
            <button
              type="submit"
              className="delete-sac-danger-btn"
              disabled={!canSubmit}
            >
              {saving ? (
                <>
                  <LoaderCircle className="animate-spin" aria-hidden="true" />
                  Excluindo...
                </>
              ) : (
                <>
                  <Trash2 aria-hidden="true" />
                  Excluir registro
                </>
              )}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
