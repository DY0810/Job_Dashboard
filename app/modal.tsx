"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

export type ModalProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
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
      onCancel={onClose}
      onPointerDown={(event) => {
        pressedBackdrop.current = event.target === ref.current;
      }}
      onClick={(event) => {
        if (pressedBackdrop.current && event.target === ref.current) onClose();
      }}
    >
      <div className="flex h-full max-h-[inherit] flex-col">
        <div className="flex items-center gap-4 border-b border-rule px-5 py-3">
          <h2 id={titleId} className="min-w-0 truncate text-[15px]">{title}</h2>
          <button type="button" className="chip ml-auto" onClick={onClose}>
            close
            <X size={12} strokeWidth={1.25} absoluteStrokeWidth />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {children}
        </div>
        {footer ? (
          <div className="flex items-center gap-2 border-t border-rule px-5 py-3">
            {footer}
          </div>
        ) : null}
      </div>
    </dialog>
  );
}
