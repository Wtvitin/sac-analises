import { useState, useRef, useEffect, type DragEvent, type ChangeEvent, type KeyboardEvent } from 'react';
import { UploadCloud, FileText, LoaderCircle, AlertCircle, X } from 'lucide-react';

interface DocumentImportDropzoneProps {
  onFileSelected: (file: File) => void;
  isProcessing: boolean;
  onCancel: () => void;
  error?: string | null;
  onClearError?: () => void;
}

const ALLOWED_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg', '.xlsx'];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

export function DocumentImportDropzone({
  onFileSelected,
  isProcessing,
  onCancel,
  error,
  onClearError,
}: DocumentImportDropzoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropzoneRef = useRef<HTMLDivElement>(null);

  const displayError = error || validationError;

  // Validate selected file locally before delegating to backend
  const validateAndSelect = (file: File) => {
    setValidationError(null);
    onClearError?.();

    if (file.size > MAX_FILE_SIZE) {
      setValidationError('O arquivo selecionado ultrapassa o limite de 10 MB.');
      return;
    }

    if (file.size === 0) {
      setValidationError('Arquivo vazio não pode ser processado.');
      return;
    }

    const name = file.name.toLowerCase();
    const isAllowed = ALLOWED_EXTENSIONS.some((ext) => name.endsWith(ext)) ||
      file.type.startsWith('image/') ||
      file.type === 'application/pdf' ||
      file.type.includes('spreadsheet') ||
      file.type.includes('excel');

    if (!isAllowed) {
      setValidationError('Formato não suportado. Selecione um arquivo PDF, imagem (PNG, JPG) ou planilha (XLSX).');
      return;
    }

    onFileSelected(file);
  };

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isProcessing) setIsDragging(true);
  };

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (isProcessing) return;

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      validateAndSelect(file);
    }
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const file = e.target.files[0];
      validateAndSelect(file);
    }
    // Clear input so selecting the same file again triggers change
    e.target.value = '';
  };

  const handleClick = () => {
    if (!isProcessing) {
      fileInputRef.current?.click();
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.key === 'Enter' || e.key === ' ') && !isProcessing) {
      e.preventDefault();
      fileInputRef.current?.click();
    }
  };

  // Clipboard paste support (safe handling for pasted images)
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      if (isProcessing) return;
      const items = e.clipboardData?.items;
      if (!items) return;

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type.indexOf('image') !== -1) {
          const blob = item.getAsFile();
          if (blob) {
            const pastedFile = new File([blob], `captura-area-transferencia-${Date.now()}.png`, {
              type: blob.type || 'image/png',
            });
            validateAndSelect(pastedFile);
            break;
          }
        }
      }
    };

    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [isProcessing]);

  if (isProcessing) {
    return (
      <div className="sac-import-processing" role="status" aria-live="polite">
        <LoaderCircle className="spin" />
        <strong>Processando e interpretando documento...</strong>
        <p>
          Extraindo texto, identificando cliente, pedido, protocolos, ocorrência e tabela de itens. Aguarde alguns instantes.
        </p>
        <button
          type="button"
          className="secondary"
          onClick={onCancel}
          aria-label="Cancelar processamento"
        >
          Cancelar
        </button>
      </div>
    );
  }

  return (
    <div
      ref={dropzoneRef}
      className={`sac-import-dropzone ${isDragging ? 'dragging' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      role="button"
      aria-label="Área de importação de formulário de atendimento"
    >
      <input
        ref={fileInputRef}
        type="file"
        accept={ALLOWED_EXTENSIONS.join(',')}
        onChange={handleFileChange}
        style={{ display: 'none' }}
        tabIndex={-1}
        aria-hidden="true"
      />

      <div className="sac-import-icon-wrapper">
        <UploadCloud />
      </div>

      <h3>Arraste e solte o formulário de atendimento aqui</h3>
      <p>PDF (texto ou digitalizado), Imagens (PNG, JPG) ou Planilha (XLSX)</p>
      <small>Até 10 MB · 1 arquivo por vez · Você também pode colar imagem (Ctrl+V)</small>

      <button
        type="button"
        className="sac-import-select-btn"
        onClick={(e) => {
          e.stopPropagation();
          fileInputRef.current?.click();
        }}
      >
        <FileText style={{ width: 16, height: 16 }} />
        Selecionar arquivo
      </button>

      {displayError && (
        <div
          className="sac-catalog-warning"
          style={{ marginTop: 16, width: '100%', borderColor: 'var(--color-danger)', background: 'var(--color-danger-soft)' }}
          role="alert"
          onClick={(e) => e.stopPropagation()}
        >
          <AlertCircle style={{ color: 'var(--color-danger)' }} />
          <div>
            <strong style={{ color: 'var(--color-danger)' }}>Não foi possível ler o documento</strong>
            <p>{displayError}</p>
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label="Dispensar erro"
            onClick={() => {
              setValidationError(null);
              onClearError?.();
            }}
          >
            <X />
          </button>
        </div>
      )}
    </div>
  );
}
