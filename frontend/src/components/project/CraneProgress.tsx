import { useId } from 'react'
import { motion } from 'motion/react'
import { WORKFLOW_PHASES, type WorkflowState } from '../../lib/workflow'

/**
 * Workflow progress drawn as a crane jib (two chords, a zigzag web, the lit
 * part, the unlit dashed part, the hook). The jib is split into the four phases, as wide as the tabs below it.
 * Finished phases are lit, the current one up to its centre, and the hook hangs over that centre. Once the award
 * document exists the whole jib is lit and the hook sits at the end.
 */
export function CraneProgress({ state, valueText }: { state: WorkflowState; valueText: string }) {
  const id = useId().replace(/:/g, '')
  const slot = 100 / WORKFLOW_PHASES.length
  const lit = state.complete ? 100 : (state.index + 0.5) * slot
  const hookAt = state.complete ? 98.5 : lit
  /* a pattern takes its colour from where it is defined, so each jib carries its own web */
  const jib = (key: string) => (
    <>
      <pattern id={`${id}-${key}`} width="16" height="18" patternUnits="userSpaceOnUse">
        <path d="M0 17 L8 1 L16 17" fill="none" stroke="currentColor" strokeWidth="1.25" />
      </pattern>
      <line x1="0" y1="1" x2="100%" y2="1" strokeWidth="2" />
      <line x1="0" y1="17" x2="100%" y2="17" strokeWidth="2" />
      <rect x="0" y="0" width="100%" height="18" fill={`url(#${id}-${key})`} stroke="none" />
    </>
  )
  return (
    <div
      role="progressbar"
      aria-label="Workflow progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(state.progress * 100)}
      aria-valuetext={valueText}
      className="relative pb-4"
    >
      <svg width="100%" height="18" className="block overflow-visible" aria-hidden>
        <defs>
          <clipPath id={`${id}-clip`}>
            <rect x="0" y="-2" height="22" className="transition-[width] duration-700 ease-out-expo motion-reduce:transition-none" style={{ width: `${lit}%` }} />
          </clipPath>
        </defs>
        <g className="text-slate-400" stroke="currentColor" strokeDasharray="4 3">{jib('rest')}</g>
        <g className="text-jib" stroke="currentColor" clipPath={`url(#${id}-clip)`}>{jib('lit')}</g>
      </svg>
      <span aria-hidden className="absolute top-[17px] -translate-x-1/2 text-jib transition-[left] duration-700 ease-out-expo motion-reduce:transition-none" style={{ left: `${hookAt}%` }}>
        {/* the hook swings gently from its top; reduced motion (MotionConfig, `reducedMotion="user"`) keeps it still */}
        <motion.svg
          width="12" height="16" viewBox="0 0 12 16" className="block motion-reduce:!transform-none"
          style={{ transformOrigin: '50% 0%' }}
          animate={{ rotate: state.complete ? 0 : [-5, 5, -5] }}
          transition={{ duration: 3.2, repeat: Infinity, ease: 'easeInOut' }}
        >
          <path d="M6 0 V8 M6 8 C6 8 2.5 8 2.5 11.5 C2.5 15 9.5 15 9.5 11.5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
        </motion.svg>
      </span>
    </div>
  )
}
