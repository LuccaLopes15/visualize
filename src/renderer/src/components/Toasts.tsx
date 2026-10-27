import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'

interface Toast {
  id: number
  kind: 'error' | 'info'
  text: string
}

interface ToastApi {
  error: (err: unknown) => void
  info: (text: string) => void
}

const ToastContext = createContext<ToastApi>({ error: () => {}, info: () => {} })

let nextId = 1

export function ToastProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [toasts, setToasts] = useState<Toast[]>([])

  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = nextId++
    setToasts((t) => [...t, { id, kind, text }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 3000)
  }, [])

  const api: ToastApi = {
    error: (err) => push('error', err instanceof Error ? err.message : String(err)),
    info: (text) => push('info', text)
  }

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" role="status">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export const useToast = (): ToastApi => useContext(ToastContext)
