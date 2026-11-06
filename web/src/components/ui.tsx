import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { IconAlert, IconX } from './Icon';

/* ---------- 开关 ---------- */

interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  id?: string;
}

export function Switch({ checked, onChange, label, disabled, id }: SwitchProps) {
  return (
    <button
      type="button"
      id={id}
      className="switch"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}

/* ---------- 字段错误 ---------- */

export function FieldError({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return (
    <p className="field-error" role="alert">
      <span aria-hidden="true">!</span>
      {children}
    </p>
  );
}

/* ---------- 空状态 ---------- */

interface EmptyStateProps {
  mark?: string;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  compact?: boolean;
}

export function EmptyState({ mark = 'GR', title, children, actions, compact }: EmptyStateProps) {
  return (
    <section className={`empty-state${compact ? ' compact' : ''}`} aria-live="polite">
      <div className="empty-mark" aria-hidden="true">
        {mark}
      </div>
      <h2>{title}</h2>
      {children}
      {actions}
    </section>
  );
}

/* ---------- 错误条 ---------- */

interface ErrorBannerProps {
  code?: string;
  message: string;
  detail?: unknown;
  action?: ReactNode;
  title?: string;
}

export function ErrorBanner({ code, message, detail, action, title }: ErrorBannerProps) {
  return (
    <div className="alert" role="alert">
      <span aria-hidden="true" style={{ marginTop: 2 }}>
        <IconAlert size={18} />
      </span>
      <div className="alert-body">
        {title ? <div className="alert-title">{title}</div> : null}
        {code ? <div className="alert-code">{code}</div> : null}
        <div>{message}</div>
        {detail !== undefined && detail !== null && detail !== '' ? (
          <div className="alert-detail">
            {typeof detail === 'string' ? detail : JSON.stringify(detail)}
          </div>
        ) : null}
        {action ? <div style={{ marginTop: 10 }}>{action}</div> : null}
      </div>
    </div>
  );
}

/* ---------- 模态对话框 ---------- */

interface ModalProps {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
  labelledBy?: string;
}

export function Modal({ open, title, children, onClose }: ModalProps) {
  const titleId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return undefined;
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCloseRef.current();
      }
      if (event.key === 'Tab' && containerRef.current) {
        const focusable = containerRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    const timer = window.setTimeout(() => {
      const focusable = containerRef.current?.querySelector<HTMLElement>(
        'button, input, [href], select, textarea',
      );
      focusable?.focus();
    }, 0);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      window.clearTimeout(timer);
      // 关闭后把焦点还给触发按钮（O1），避免键盘用户丢失位置。
      const previous = previousFocusRef.current;
      previousFocusRef.current = null;
      if (previous && document.contains(previous)) previous.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={containerRef}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h2 id={titleId}>{title}</h2>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={onClose}
            aria-label="关闭对话框"
            style={{ marginLeft: 'auto' }}
          >
            <IconX size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* ---------- 二次确认对话框 ---------- */

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  requireText?: string;
  inputLabel?: string;
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: (typed: string) => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = '确认',
  cancelLabel = '取消',
  danger,
  requireText,
  inputLabel,
  busy,
  error,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState('');
  const inputId = useId();
  const handleClose = useCallback(() => {
    if (!busy) {
      setTyped('');
      onCancel();
    }
  }, [busy, onCancel]);

  useEffect(() => {
    if (!open) setTyped('');
  }, [open]);

  const canConfirm = !busy && (!requireText || typed.trim() === requireText);

  return (
    <Modal open={open} title={title} onClose={handleClose}>
      <div className="small muted" style={{ lineHeight: 1.65 }}>
        {description}
      </div>
      {requireText ? (
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor={inputId}>{inputLabel ?? `输入「${requireText}」以确认`}</label>
          <input
            id={inputId}
            className="input"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            placeholder={requireText}
            autoComplete="off"
            disabled={busy}
          />
        </div>
      ) : null}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={handleClose} disabled={busy}>
          {cancelLabel}
        </button>
        <button
          type="button"
          className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
          onClick={() => onConfirm(typed)}
          disabled={!canConfirm}
        >
          {busy ? <span className="spinner" aria-hidden="true" /> : null}
          {busy ? '处理中…' : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

/* ---------- 内联提示 ---------- */

export function InlineNotice({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'success' | 'warning' | 'error';
  children: ReactNode;
}) {
  const icon = tone === 'success' ? '✓' : tone === 'warning' ? '!' : tone === 'error' ? '×' : 'i';
  return (
    <div className={`notice${tone === 'info' ? '' : ` ${tone}`}`}>
      <span className="notice-icon" aria-hidden="true">
        {icon}
      </span>
      <div>{children}</div>
    </div>
  );
}
