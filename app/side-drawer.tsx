'use client';

import { Modal, type ModalProps } from './modal';

/** The Modal, pinned right with the jobs drawer's shell and motion (`dialog.drawer`). */
export function SideDrawer(props: ModalProps) {
  return <Modal {...props} kind="drawer" />;
}
