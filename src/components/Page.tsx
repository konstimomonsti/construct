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
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3" aria-busy="true" aria-label="Loading">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="mx-auto size-14 rounded-xl" />
          <Skeleton className="mx-auto h-4 w-2/3" />
          <Skeleton className="mx-auto h-3 w-1/2" />
        </div>
      ))}
    </div>
  )
}

export function TableSkeleton() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-10 w-2/3" />
      <div className="space-y-2 rounded-xl border border-slate-200 bg-white p-4">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </div>
    </div>
  )
}

export function EmptyNote({ icon, title, text }: { icon?: string; title: string; text?: string }) {
  return (
    <div className="flex flex-col items-center rounded-2xl border border-dashed border-slate-200 bg-white px-6 py-16 text-center">
      {icon && <Icon name={icon} size={36} className="mb-3 text-slate-300" />}
      <h2 className="font-heading text-sm font-bold text-slate-800">{title}</h2>
      {text && <p className="mt-1 max-w-sm text-xs text-slate-500">{text}</p>}
    </div>
  )
}
