import { useEffect, useState } from 'react'
import { DEFAULT_SETTINGS, type AppInfo, type AppSettings } from '@shared/types'
import { eventToAccelerator, formatAccelerator } from '../lib/accelerator'
import { useToast } from './Toasts'
import { IconKeyboard } from './Icons'

const api = window.api

interface Props {
  settings: AppSettings | null
  info: AppInfo | null
}

export function SettingsView({ settings, info }: Props): React.JSX.Element {
  const toast = useToast()
  const [recording, setRecording] = useState(false)
  const [pending, setPending] = useState<string | null>(null)

  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        setRecording(false)
        setPending(null)
        return
      }
      const acc = eventToAccelerator(e)
      if (acc) {
        setRecording(false)
        setPending(acc)
        void apply(acc)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording]) // apply() only uses stable refs (api, toast)

  const apply = async (acc: string): Promise<void> => {
    try {
      await api.settings.setHotkey(acc)
      toast.info(`Atalho alterado para ${formatAccelerator(acc)}`)
    } catch (err) {
      toast.error(err)
    } finally {
      setPending(null)
    }
  }

  const toggleAutostart = async (enabled: boolean): Promise<void> => {
    try {
      await api.settings.setAutostart(enabled)
    } catch (err) {
      toast.error(err)
    }
  }

  if (!settings || !info) return <div className="empty">Carregando…</div>

  const hotkeyOk = info.hotkey.registered && info.hotkey.hotkey === settings.hotkey

  return (
    <div className="settings">
      <section className="settings-card">
        <div className="settings-row">
          <div className="settings-text">
            <h3>Atalho de captura</h3>
            <p className="muted">
              Abre a janelinha de nova ideia de qualquer lugar do Windows.
            </p>
          </div>
          <div className="settings-control">
            <div className={`hotkey-box${recording ? ' recording' : ''}`}>
              <IconKeyboard />
              {recording
                ? 'Pressione a combinação…'
                : formatAccelerator(pending ?? settings.hotkey)}
            </div>
            <button className="btn" onClick={() => setRecording((r) => !r)}>
              {recording ? 'Cancelar' : 'Alterar'}
            </button>
          </div>
        </div>
        <div className="settings-foot">
          {hotkeyOk ? (
            <span className="status-ok">● Registrado</span>
          ) : (
            <span className="status-warn">
              ● Não registrado — pode estar em uso por outro aplicativo. Escolha outra combinação.
            </span>
          )}
          {settings.hotkey !== DEFAULT_SETTINGS.hotkey && (
            <button className="link-btn" onClick={() => void apply(DEFAULT_SETTINGS.hotkey)}>
              Restaurar padrão ({formatAccelerator(DEFAULT_SETTINGS.hotkey)})
            </button>
          )}
        </div>
      </section>

      <section className="settings-card">
        <div className="settings-row">
          <div className="settings-text">
            <h3>Iniciar com o Windows</h3>
            <p className="muted">Abre o Visualize minimizado na bandeja ao entrar no Windows.</p>
          </div>
          <div className="settings-control">
            <label className="switch">
              <input
                type="checkbox"
                checked={settings.autostart}
                onChange={(e) => void toggleAutostart(e.target.checked)}
              />
              <span className="switch-track" />
            </label>
          </div>
        </div>
        {!info.isPackaged && (
          <div className="settings-foot">
            <span className="muted small">
              Modo desenvolvimento: a preferência é salva, mas só é aplicada ao Windows na versão
              instalada.
            </span>
          </div>
        )}
      </section>

      <section className="settings-card">
        <div className="settings-text">
          <h3>Sobre</h3>
          <dl className="about">
            <dt>Versão</dt>
            <dd>
              {info.version}
              {info.isPackaged ? '' : ' (dev)'}
            </dd>
            <dt>Banco de dados</dt>
            <dd className="mono">{info.dbPath}</dd>
          </dl>
        </div>
      </section>
    </div>
  )
}
