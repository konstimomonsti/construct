import { create } from 'zustand'
import type { DocMeta } from './types'

export type DialogState =
  | { kind: 'new-folder'; parent?: string }
  | { kind: 'rename-folder'; id: string }
  | { kind: 'rename-list'; id: string }
  | { kind: 'cap'; target: 'folder' | 'list'; id: string; prefill?: number }
  | { kind: 'doc'; doc: DocMeta }
  | { kind: 'blank-list'; folderId: string }
  | { kind: 'confirm'; title: string; body: string; confirmLabel: string; danger?: boolean; run: () => void }
  | null

interface UiState {
  dialog: DialogState
  palette: boolean
  mobileNav: boolean
  sessionDocs: Record<string, DocMeta[]>
  openDialog: (d: Exclude<DialogState, null>) => void
  closeDialog: () => void
  setPalette: (v: boolean) => void
  setMobileNav: (v: boolean) => void
  addSessionDoc: (folderId: string, doc: DocMeta) => void
}

export const useUi = create<UiState>((set) => ({
  dialog: null,
  palette: false,
  mobileNav: false,
  sessionDocs: {},
  openDialog: (dialog) => set({ dialog }),
  closeDialog: () => set({ dialog: null }),
  setPalette: (palette) => set({ palette }),
  setMobileNav: (mobileNav) => set({ mobileNav }),
  addSessionDoc: (folderId, doc) =>
    set((s) => ({ sessionDocs: { ...s.sessionDocs, [folderId]: [...(s.sessionDocs[folderId] ?? []), doc] } })),
}))
