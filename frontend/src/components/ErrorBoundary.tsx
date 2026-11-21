import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Icon } from './ui'
import { resetLoaders } from '../lib/data'

interface Props {
  children: ReactNode
}
interface S {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, S> {
  state: S = { error: null }
  static getDerivedStateFromError(error: Error): S {
    return { error }
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.warn('ErrorBoundary', error.message, info.componentStack?.slice(0, 120))
  }
  retry = () => {
    resetLoaders()
    this.setState({ error: null })
  }
  render() {
    const err = this.state.error
    if (!err) return this.props.children
    const notFound = (err as { notFound?: boolean }).notFound === true
    return (
      <div role="alert" className="mt-6 flex flex-col items-center rounded-lg border border-slate-200 bg-white px-6 py-16 text-center">
        <Icon name={notFound ? 'search_off' : 'report'} size={34} className={notFound ? 'text-slate-400' : 'text-rose-400'} />
        <h2 className="mt-3 font-heading text-base font-bold text-slate-900">{notFound ? 'List not found' : 'This list could not be loaded'}</h2>
        <p className="mt-1 max-w-sm text-xs text-slate-500">{notFound ? 'It may have been deleted or the link is wrong.' : err.message}</p>
        <div className="mt-4 flex items-center gap-2">
          {(
            <button type="button" onClick={this.retry} className="inline-flex h-8 items-center rounded-lg border border-slate-200 bg-white px-3.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
              Retry
            </button>
          )}
          <Link to="/" className="inline-flex h-8 items-center rounded-lg bg-brand-600 px-3.5 text-xs font-semibold text-ink hover:bg-brand-500">
            Back to All Projects
          </Link>
        </div>
      </div>
    )
  }
}
