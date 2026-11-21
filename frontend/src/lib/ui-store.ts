import { create } from 'zustand'
import type { DocMeta } from './types'

export type DialogState =
  | { kind: 'new-folder'; parent?: string; name?: string }
  | { kind: 'rename-folder'; id: string }
  | { kind: 'rename-list'; id: string }
  | { kind: 'doc'; doc: DocMeta }
  | { kind: 'folder-target'; action: 'import' }
  | { kind: 'folder-target'; action: 'move-list'; listId: string }
  | { kind: 'folder-target'; action: 'move-folder'; folderId: string }
  | { kind: 'folder-target'; action: 'move-document'; docId: string }
  | { kind: 'link-document'; doc: DocMeta }
  | { kind: 'blank-list'; folderId: string }
  | { kind: 'edit-cap'; target: 'folder' | 'list'; id: string }
  | { kind: 'confirm'; title: string; body: string; confirmLabel: string; danger?: boolean; run: () => void }
  | null

interface UiState {
  dialog: DialogState
  palette: boolean
  mobileNav: boolean
  openDialog: (d: Exclude<DialogState, null>) => void
  closeDialog: () => void
  setPalette: (v: boolean) => void
  setMobileNav: (v: boolean) => void
}

export const useUi = create<UiState>((set) => ({
  dialog: null,
  palette: false,
  mobileNav: false,
  openDialog: (dialog) => set({ dialog }),
  closeDialog: () => set({ dialog: null }),
  setPalette: (palette) => set({ palette }),
  setMobileNav: (mobileNav) => set({ mobileNav }),
}))
