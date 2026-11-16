import { useEffect, useState } from 'react'
import { DEVOPS_PAT_SCOPES, type DevOpsStatus, type DevOpsTestResult } from '@shared/devops'
import { useToast } from './Toasts'

const api = window.api

/** How many project names "Testar conexão" lists before "e mais N". */
const SHOWN_PROJECTS = 5

/**
 * Configurações → Azure DevOps: org URL, PAT (saved encrypted in main, never shown again:
 * only "configurado ✓" with Trocar / Remover), the scopes it needs and "Testar conexão".
 */
export function DevOpsSettingsCard(): React.JSX.Element {
  const toast = useToast()
  const [status, setStatus] = useState<DevOpsStatus | null>(null)
  const [url, setUrl] = useState('')
  const [pat, setPat] = useState('')
  const [editingPat, setEditingPat] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<DevOpsTestResult | null>(null)

  useEffect(() => {
    let alive = true
    void api.devops.getStatus().then((s) => {
      if (!alive) return
      setStatus(s)
      setUrl(s.orgUrl)
    })
    return () => {
      alive = false
    }
  }, [])

  const run = async (fn: () => Promise<DevOpsStatus>): Promise<boolean> => {
    setBusy(true)
    try {
      setStatus(await fn())
      setResult(null)
      return true
    } catch (err) {
      toast.error(err)
      return false
    } finally {
      setBusy(false)
    }
  }

  const saveUrl = async (): Promise<void> => {
    if (!status || url.trim() === status.orgUrl) return
    await run(async () => {
      const s = await api.devops.setOrgUrl(url)
      setUrl(s.orgUrl)
      return s
    })
  }

  const savePat = async (): Promise<void> => {
    const ok = await run(() => api.devops.setPat(pat))
    if (ok) {
      setPat('')
      setEditingPat(false)
      toast.info('PAT salvo')
    }
  }

  const removePat = async (): Promise<void> => {
    if (!window.confirm('Remover o PAT salvo? Para criar tickets será preciso colar um PAT de novo.')) return
    await run(() => api.devops.clearPat())
  }

  const test = async (): Promise<void> => {
    setBusy(true)
    try {
      setResult(await api.devops.testConnection())
    } catch (err) {
      toast.error(err)
    } finally {
      setBusy(false)
    }
  }

  const configured = !!status?.orgUrl && status.patConfigured
  const showPatInput = status && (!status.patConfigured || editingPat)

  return (
    <section className="settings-card">
      <div className="settings-row">
        <div className="settings-text">
          <h3>Azure DevOps</h3>
          <p className="muted">
            Usado para transformar as tarefas em tickets. O PAT fica cifrado neste PC e não é exibido de novo.
          </p>
        </div>
        <div className="settings-control">
          <button className="btn" onClick={() => void test()} disabled={busy || !configured}>
            {busy ? 'Aguarde…' : 'Testar conexão'}
          </button>
        </div>
      </div>

      <dl className="about claude-about">
        <dt>Status</dt>
        <dd>
          {!status ? (
            <span className="muted">Verificando…</span>
          ) : configured ? (
            <span className="status-ok">● Configurado</span>
          ) : (
            <span className="status-warn">
              ● Falta {!status.orgUrl && !status.patConfigured ? 'a URL e o PAT' : !status.orgUrl ? 'a URL' : 'o PAT'}
            </span>
          )}
        </dd>
      </dl>
      {result &&
        (result.ok ? (
          <p className="devops-result">
            <span className="status-ok">● Conectado</span> — {result.projects.length}{' '}
            {result.projects.length === 1 ? 'projeto' : 'projetos'}
            {result.projects.length > 0 && `: ${result.projects.slice(0, SHOWN_PROJECTS).join(', ')}`}
            {result.projects.length > SHOWN_PROJECTS && ` e mais ${result.projects.length - SHOWN_PROJECTS}`}
          </p>
        ) : (
          <p className="claude-problem">{result.message}</p>
        ))}
      {status && !status.encryptionAvailable && (
        <p className="claude-problem">
          A criptografia do sistema não está disponível neste PC, então o PAT não pode ser salvo com segurança.
        </p>
      )}

      <div className="claude-fields">
        <label className="claude-field">
          <span>URL da organização</span>
          <div className="claude-field-row">
            <input
              className="input mono"
              value={url}
              placeholder="https://<sua-org>.visualstudio.com ou https://dev.azure.com/<sua-org>"
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void saveUrl()}
            />
            {status && url.trim() !== status.orgUrl && (
              <button className="btn btn-primary" onClick={() => void saveUrl()} disabled={busy}>
                Salvar
              </button>
            )}
          </div>
        </label>

        <div className="claude-field">
          <span>Personal Access Token (PAT)</span>
          {showPatInput ? (
            <div className="claude-field-row">
              <input
                className="input mono"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={pat}
                placeholder="Cole o PAT aqui"
                aria-label="Personal Access Token"
                onChange={(e) => setPat(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && pat.trim() && void savePat()}
              />
              <button
                className="btn btn-primary"
                onClick={() => void savePat()}
                disabled={busy || !pat.trim() || !status.encryptionAvailable}
              >
                Salvar
              </button>
              {editingPat && (
                <button
                  className="btn btn-ghost"
                  onClick={() => {
                    setPat('')
                    setEditingPat(false)
                  }}
                >
                  Cancelar
                </button>
              )}
            </div>
          ) : (
            status && (
              <div className="claude-field-row devops-pat-saved">
                <span className="status-ok">configurado ✓</span>
                <button className="btn" onClick={() => setEditingPat(true)} disabled={busy}>
                  Trocar
                </button>
                <button className="btn btn-ghost" onClick={() => void removePat()} disabled={busy}>
                  Remover
                </button>
              </div>
            )
          )}
          <div className="devops-scopes">
            Escopos necessários ao criar o PAT:
            <ul>
              {DEVOPS_PAT_SCOPES.map((s) => (
                <li key={s.name}>
                  <strong>{s.name}</strong> — {s.why}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  )
}
