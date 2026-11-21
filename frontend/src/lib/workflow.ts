/**
 * Where a project stands in the four-phase workflow (X83 → Subcontractors → X84 → X86). Pure; the crane in the list
 * header and the check marks on the phase tabs both read it.
 */
import type { SubcontractPackage } from './subcontract'

export const WORKFLOW_PHASES = ['x83', 'subcontractors', 'x84', 'x86'] as const
export type WorkflowPhase = (typeof WORKFLOW_PHASES)[number]

export type WorkflowState = {
  phase: WorkflowPhase
  /** 0-based position of `phase` */
  index: number
  /** 0..1 along the four phases: a finished phase counts fully, the current one up to its centre, an award means 1 */
  progress: number
  /** the award document exists: every phase is done */
  complete: boolean
  /** phases that are finished (they get a check mark) */
  done: WorkflowPhase[]
}

type PackageState = Pick<SubcontractPackage, 'chosenId' | 'status' | 'sentAt'>

const wasSent = (p: PackageState) => p.status !== 'draft' || !!p.sentAt

/**
 * The current phase, by the first rule that holds:
 * 1. `x86`: an award document exists (the project is complete, everything is lit).
 * 2. `x84`: at least one package, and every package has a chosen subcontractor.
 * 3. `subcontractors`: at least one package was sent.
 * 4. `x83`: otherwise (nothing sent yet, or only drafts).
 */
export function currentPhase(packages: readonly PackageState[], hasAward: boolean): WorkflowState {
  const phase: WorkflowPhase = hasAward ? 'x86'
    : packages.length > 0 && packages.every((p) => !!p.chosenId) ? 'x84'
    : packages.some(wasSent) ? 'subcontractors'
    : 'x83'
  const index = WORKFLOW_PHASES.indexOf(phase)
  return {
    phase,
    index,
    progress: hasAward ? 1 : (index + 0.5) / WORKFLOW_PHASES.length,
    complete: hasAward,
    done: hasAward ? [...WORKFLOW_PHASES] : WORKFLOW_PHASES.slice(0, index),
  }
}
