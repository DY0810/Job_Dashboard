"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

export type ModalProps = {
  open: boolean;
  /** Asks to close; `open` decides. Return false to decline synchronously (a parent may also accept later, e.g. via history). */
  onClose: () => void | false;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  /** Extra header controls, beside close. */
  actions?: ReactNode;
};

/**
 * Native <dialog> + showModal(), like the jobs drawer: Esc, the top layer, the focus trap and
 * focus return to the opener are platform behaviour. `kind` only swaps the CSS shell.
 */
export function Modal({
  kind = "modal",
  open,
  onClose,
  title,
  children,
  footer,
  actions,
}: ModalProps & { kind?: "modal" | "drawer" }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  // A drag-select that starts inside and releases on the backdrop still clicks the dialog;
  // only a press that also started on the backdrop closes it.
  const pressedBackdrop = useRef(false);

  useEffect(() => {
    const dialog = ref.current;
    if (open && !dialog?.open) dialog?.showModal();
    if (!open && dialog?.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={kind}
      aria-labelledby={titleId}
      // Esc asks; `open` decides. Without preventDefault the dialog would close behind a
      // parent that declined to, leaving `open` true on a closed dialog.
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      // Chrome may ignore preventDefault on a repeated Esc without user activation and close anyway:
      // ask the parent, and put the dialog back if it declines.
      onClose={() => {
        if (!open || ref.current?.open) return;
        if (onClose() === false) ref.current?.showModal();
      }}
      onPointerDown={(event) => {
        pressedBackdrop.current = event.target === ref.current;
      }}
      onClick={(event) => {
        if (pressedBackdrop.current && event.target === ref.current) onClose();
      }}
    >
      <div className="flex h-full max-h-[inherit] flex-col">
        <div className="dialog-head">
          <h2 id={titleId} className="min-w-0 truncate">{title}</h2>
          <div className="ml-auto flex items-center gap-1">
            {actions}
            <button type="button" className="btn ghost icon" onClick={onClose} aria-label="Close" title="Close">
              <X size={18} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </div>
        </div>
        <div className="dialog-body">
          {children}
        </div>
        {footer ? <div className="dialog-foot">{footer}</div> : null}
      </div>
    </dialog>
  );
}
