import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import './confirmation-dialog.css';

export type ConfirmationDetail = {
  readonly label: string;
  readonly value: string;
};

export type ConfirmationRequest = {
  readonly title: string;
  readonly description: string;
  readonly details?: readonly ConfirmationDetail[];
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  readonly tone?: 'primary' | 'danger';
};

type PendingConfirmation = {
  readonly request: ConfirmationRequest;
  readonly resolve: (confirmed: boolean) => void;
};

type ConfirmationController = {
  readonly confirm: (request: ConfirmationRequest) => Promise<boolean>;
  readonly dialog: ReactNode;
};

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function useConfirmationDialog(): ConfirmationController {
  const [pending, setPending] = useState<PendingConfirmation | null>(null);
  const pendingRef = useRef<PendingConfirmation | null>(null);

  const settle = useCallback((confirmed: boolean) => {
    const current = pendingRef.current;
    if (current === null) return;
    pendingRef.current = null;
    setPending(null);
    current.resolve(confirmed);
  }, []);

  const confirm = useCallback((request: ConfirmationRequest): Promise<boolean> => (
    new Promise(resolve => {
      if (pendingRef.current !== null) {
        resolve(false);
        return;
      }
      const next = { request, resolve };
      pendingRef.current = next;
      setPending(next);
    })
  ), []);

  const cancel = useCallback(() => settle(false), [settle]);
  const accept = useCallback(() => settle(true), [settle]);

  useEffect(() => () => {
    const current = pendingRef.current;
    pendingRef.current = null;
    current?.resolve(false);
  }, []);

  return {
    confirm,
    dialog: pending === null ? null : (
      <ConfirmationDialog
        request={pending.request}
        onCancel={cancel}
        onConfirm={accept}
      />
    ),
  };
}

function ConfirmationDialog(props: {
  readonly request: ConfirmationRequest;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const { onCancel } = props;

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
    const rootElement = document.getElementById('root');
    const rootWasInert = rootElement?.hasAttribute('inert') ?? false;
    document.body.style.overflow = 'hidden';
    rootElement?.setAttribute('inert', '');
    const focusFrame = window.requestAnimationFrame(() => cancelRef.current?.focus());

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== 'Tab' || panelRef.current === null) return;
      const focusable = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter(element => element.tabIndex >= 0);
      if (focusable.length === 0) {
        event.preventDefault();
        panelRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener('keydown', handleKeyDown, true);
      document.body.style.overflow = previousOverflow;
      if (!rootWasInert) rootElement?.removeAttribute('inert');
      previouslyFocused?.focus();
    };
  }, [onCancel]);

  return createPortal(
    <div
      className="confirmation-overlay"
      role="presentation"
      onMouseDown={event => {
        if (event.target === event.currentTarget) props.onCancel();
      }}
    >
      <section
        ref={panelRef}
        className="confirmation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
      >
        <header className="confirmation-dialog__header">
          <h2 id={titleId}>{props.request.title}</h2>
          <p id={descriptionId}>{props.request.description}</p>
        </header>
        {props.request.details === undefined || props.request.details.length === 0 ? null : (
          <dl className="confirmation-dialog__details">
            {props.request.details.map(detail => (
              <div key={`${detail.label}:${detail.value}`}>
                <dt>{detail.label}</dt>
                <dd>{detail.value}</dd>
              </div>
            ))}
          </dl>
        )}
        <footer className="confirmation-dialog__actions">
          <button
            ref={cancelRef}
            className="button button--secondary"
            type="button"
            onClick={props.onCancel}
          >
            {props.request.cancelLabel ?? '取消'}
          </button>
          <button
            className={`button ${props.request.tone === 'danger' ? 'button--danger' : 'button--primary'}`}
            type="button"
            onClick={props.onConfirm}
          >
            {props.request.confirmLabel ?? '确认'}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
