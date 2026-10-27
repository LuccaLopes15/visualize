import { useEffect, useState } from 'react'
import type { ClaudeStatus } from '@shared/chat'
import { useToast } from './Toasts'

const api = window.api

const SOURCE_LABEL: Record<NonNullable<ClaudeStatus['source']>, string> = {
  setting: 'caminho configurado',
  path: 'encontrado no PATH',
  known: 'local de instalação padrão'
}

/** Configurações → Claude Code: detected CLI, version, login, path override, model. */
export function ClaudeSettingsCard(): React.JSX.Element {
  const toast = useToast()
  const [status, setStatus] = useState<ClaudeStatus | null>(null)
  const [testing, setTesting] = useState(false)
  const [path, setPath] = useState('')
  const [savedPath, setSavedPath] = useState('')
  const [model, setModel] = useState('')
  const [savedModel, setSavedModel] = useState('')

  useEffect(() => {
    let alive = true
    void api.claude.getSettings().then((s) => {
      if (!alive) return
      setPath(s.claudePath)
      setSavedPath(s.claudePath)
      setModel(s.claudeModel)
      setSavedModel(s.claudeModel)
    })
    void api.claude.status().then((s) => alive && setStatus(s))
    return () => {
      alive = false
    }
  }, [])

  const test = async (): Promise<void> => {
    setTesting(true)
    try {
      setStatus(await api.claude.status(true))
    } catch (err) {
      toast.error(err)
    } finally {
      setTesting(false)
    }
  }

  const applyPath = async (value: string): Promise<void> => {
    setTesting(true)
    try {
      const s = await api.claude.setPath(value)
      setPath(value.trim())
      setSavedPath(value.trim())
      setStatus(s)
    } catch (err) {
      toast.error(err)
    } finally {
      setTesting(false)
    }
  }

  const pick = async (): Promise<void> => {
    const chosen = await api.claude.pickPath()
    if (chosen) await applyPath(chosen)
  }

  const saveModel = async (): Promise<void> => {
    if (model.trim() === savedModel) return
    try {
      const s = await api.claude.setModel(model)
      setSavedModel(s.claudeModel)
      setModel(s.claudeModel)
      toast.info(s.claudeModel ? `Modelo do chat: ${s.claudeModel}` : 'Modelo do chat: padrão do Claude Code')
    } catch (err) {
      toast.error(err)
    }
  }

  const ok = status && status.found && status.versionOk && status.loggedIn !== false

  return (
    <section className="settings-card">
      <div className="settings-row">
        <div className="settings-text">
          <h3>Claude Code</h3>
          <p className="muted">
            O chat do workspace usa o Claude Code instalado e logado neste PC (a sua assinatura), só com leitura do
            código.
          </p>
        </div>
        <div className="settings-control">
          <button className="btn" onClick={() => void test()} disabled={testing}>
            {testing ? 'Testando…' : 'Testar'}
          </button>
        </div>
      </div>

      <dl className="about claude-about">
        <dt>Status</dt>
        <dd>
          {!status ? (
            <span className="muted">Verificando…</span>
          ) : ok ? (
            <span className="status-ok">● Pronto{status.account ? ` — ${status.account}` : ''}</span>
          ) : (
            <span className="status-warn">● {status.found ? 'Com problema' : 'Não encontrado'}</span>
          )}
        </dd>
        {status?.path && (
          <>
            <dt>Executável</dt>
            <dd className="mono">
              {status.path}
              {status.source && <span className="muted"> ({SOURCE_LABEL[status.source]})</span>}
            </dd>
          </>
        )}
        {status?.version && (
          <>
            <dt>Versão</dt>
            <dd>{status.version}</dd>
          </>
        )}
      </dl>
      {status?.problem && <p className="claude-problem">{status.problem.message}</p>}

      <div className="claude-fields">
        <label className="claude-field">
          <span>Caminho do executável (opcional)</span>
          <div className="claude-field-row">
            <input
              className="input mono"
              value={path}
              placeholder="Detectar automaticamente (PATH)"
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void applyPath(path)}
            />
            <button className="btn" onClick={() => void pick()} disabled={testing}>
              Escolher…
            </button>
            {path.trim() !== savedPath && (
              <button className="btn btn-primary" onClick={() => void applyPath(path)} disabled={testing}>
                Salvar
              </button>
            )}
            {savedPath && path.trim() === savedPath && (
              <button className="btn btn-ghost" onClick={() => void applyPath('')} disabled={testing}>
                Detectar automaticamente
              </button>
            )}
          </div>
        </label>
        <label className="claude-field">
          <span>Modelo (opcional)</span>
          <div className="claude-field-row">
            <input
              className="input"
              value={model}
              placeholder="Padrão do Claude Code (ex.: opus, sonnet)"
              onChange={(e) => setModel(e.target.value)}
              onBlur={() => void saveModel()}
              onKeyDown={(e) => e.key === 'Enter' && void saveModel()}
            />
          </div>
        </label>
      </div>
    </section>
  )
}
