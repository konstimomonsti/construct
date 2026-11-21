import type { ReactNode } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { Icon } from './ui'

export const easeOutExpo = [0.16, 1, 0.3, 1] as const

/** route-level fade / slide-in */
export function Page({ children, className }: { children: ReactNode; className?: string }) {
  const reduce = useReducedMotion()
  return (
    <motion.div
      className={className}
      initial={reduce ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: easeOutExpo }}
    >
      {children}
    </motion.div>
  )
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded-lg bg-slate-200/70 ${className}`} />
}

export function GridSkeleton({ n = 6 }: { n?: number }) {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-36 w-full rounded-lg" />
      <div className="space-y-1">
        {Array.from({ length: n }, (_, i) => (
          <div key={i} className="flex items-center gap-4 px-3 py-3">
            <Skeleton className="size-11 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-3 w-1/2" />
            </div>
            <Skeleton className="h-4 w-24" />
          </div>
        ))}
      </div>
    </div>
  )
}

export function TableSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-32 w-full rounded-lg" />
      <div className="space-y-2">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-11 w-full" />
        ))}
      </div>
    </div>
  )
}

export function EmptyNote({ icon, title, text, children }: { icon?: string; title: string; text?: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center sm:py-20">
      {icon && (
        <span className="mb-4 flex size-14 items-center justify-center rounded-md bg-slate-100 text-slate-600">
          <Icon name={icon} size={28} />
        </span>
      )}
      <h2 className="font-heading text-lg font-bold text-balance text-slate-900">{title}</h2>
      {text && <p className="mt-1.5 max-w-sm text-sm text-balance text-slate-600">{text}</p>}
      {children && <div className="mt-6 flex flex-wrap justify-center gap-2">{children}</div>}
    </div>
  )
}
