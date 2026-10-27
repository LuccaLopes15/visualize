import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { toolKind, type ChatBlock, type ChatMessage, type ChatToolBlock } from '@shared/chat'
import { renderMarkdown } from '../../lib/markdown'
import { readPref, writePref } from '../../lib/prefs'
import { ConfirmDialog } from '../../components/Modal'
import {
  IconAlert,
  IconChat,
  IconCheck,
  IconDoc,
  IconFile,
  IconNewChat,
  IconPen,
  IconSearch,
  IconSend,
  IconSettings,
  IconStop,
  IconX
} from '../../components/Icons'
import type { ChatController } from './useChat'

const MIN_W = 300
const MAX_W = 760
const DEFAULT_W = 380

const SUGGESTIONS = [
  'Desenhe no board um fluxo desta ideia',
  'Escreva um plano macro inicial para esta ideia',
  'Que partes do código esta ideia vai afetar?'
]

interface Props {
  chat: ChatController
  onCollapse: () => void
  onOpenSettings: () => void
}

export function ChatPanel({ chat, onCollapse, onOpenSettings }: Props): React.JSX.Element {
  const [width, setWidth] = useState(() => {
    const w = Number(readPref('ws.chatWidth'))
    return Number.isFinite(w) && w >= MIN_W ? Math.min(MAX_W, w) : DEFAULT_W
  })
  const [confirmReset, setConfirmReset] = useState(false)
  const [input, setInput] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // ---- resize (drag the left edge) -------------------------------------------
  const startResize = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    let w = startW
    const move = (ev: PointerEvent): void => {
      w = Math.max(MIN_W, Math.min(MAX_W, startW + (startX - ev.clientX)))
      setWidth(w)
    }
    const up = (): void => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      writePref('ws.chatWidth', String(Math.round(w)))
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
  }

  // ---- auto-scroll unless the user scrolled up -----------------------------------
  const onScroll = (): void => {
    const el = listRef.current
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  }
  useLayoutEffect(() => {
    const el = listRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [chat.messages, chat.live, chat.busy])

  useEffect(() => {
    if (chat.loaded) inputRef.current?.focus()
  }, [chat.loaded])

  // Grow the textarea with its content (up to ~8 lines).
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [input])

  const disabled = !!chat.blocker
  const submit = async (text = input): Promise<void> => {
    const t = text.trim()
    if (!t || chat.busy || disabled) return
    stick.current = true
    setInput('')
    const ok = await chat.send(t)
    if (!ok) setInput(t)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void submit()
    }
  }

  const empty = chat.loaded && chat.messages.length === 0 && !chat.live

  return (
    <aside className="ws-chat" style={{ width }} aria-label="Chat com Claude">
      <div className="chat-resize" onPointerDown={startResize} title="Arraste para redimensionar" />
      <header className="ws-chat-head">
        <IconChat />
        <span>Claude</span>
        {chat.status?.version && (
          <span className="chat-version" title={chat.status.path ?? ''}>
            Claude Code {chat.status.version}
          </span>
        )}
        <button
          className="icon-btn"
          title="Nova conversa"
          disabled={chat.messages.length === 0 && !chat.busy}
          onClick={() => setConfirmReset(true)}
        >
          <IconNewChat size={15} />
        </button>
        <button className="icon-btn" onClick={onCollapse} title="Recolher o chat">
          <IconX size={14} />
        </button>
      </header>

      {chat.blocker && (
        <div className="chat-blocker" role="alert">
          <IconAlert size={18} />
          <div>
            <p>{chat.blocker.message}</p>
            <div className="chat-blocker-actions">
              <button className="btn" onClick={onOpenSettings}>
                <IconSettings size={14} /> Abrir Configurações
              </button>
              <button className="btn btn-ghost" onClick={() => void chat.recheck()}>
                Testar de novo
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="chat-list" ref={listRef} onScroll={onScroll}>
        {!chat.loaded && <div className="chat-empty muted small">Carregando conversa…</div>}
        {empty && !disabled && (
          <div className="chat-empty">
            <IconChat size={22} />
            <p>Converse com o Claude sobre esta ideia.</p>
            <p className="muted small">
              Ele lê o código dos projetos vinculados (só leitura), desenha no board e escreve o plano macro.
            </p>
            <div className="chat-suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="chat-suggestion" onClick={() => void submit(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {chat.messages.map((m) => (
          <MessageView key={m.id} message={m} />
        ))}
        {chat.live && <LiveView blocks={chat.live.blocks} />}
      </div>

      {chat.error && (
        <div className="chat-error" role="alert">
          <span>{chat.error.message}</span>
          <button className="icon-btn" onClick={chat.dismissError} title="Fechar">
            <IconX size={12} />
          </button>
        </div>
      )}

      <div className={`chat-input${disabled ? ' disabled' : ''}`}>
        <textarea
          ref={inputRef}
          value={input}
          rows={1}
          disabled={disabled}
          placeholder={disabled ? 'Chat indisponível' : 'Pergunte ou peça algo ao Claude…'}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="Mensagem para o Claude"
        />
        {chat.busy ? (
          <button className="chat-send stop" onClick={chat.stop} title="Parar a resposta">
            <IconStop size={14} />
          </button>
        ) : (
          <button
            className="chat-send"
            onClick={() => void submit()}
            disabled={disabled || !input.trim()}
            title="Enviar (Enter) · nova linha: Shift+Enter"
          >
            <IconSend size={15} />
          </button>
        )}
      </div>

      {confirmReset && (
        <ConfirmDialog
          title="Nova conversa"
          message="Apagar o histórico deste chat e começar uma conversa nova com o Claude? O board e o plano macro não mudam."
          confirmLabel="Nova conversa"
          danger
          onCancel={() => setConfirmReset(false)}
          onConfirm={() => {
            setConfirmReset(false)
            void chat.reset()
          }}
        />
      )}
    </aside>
  )
}

const MessageView = memo(function MessageView({ message }: { message: ChatMessage }): React.JSX.Element {
  if (message.role === 'user') {
    const text = message.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n')
    return <div className="chat-msg user">{text}</div>
  }
  const meta = message.meta
  return (
    <div className="chat-msg assistant">
      <Blocks blocks={message.blocks} />
      {meta?.interrupted && <div className="chat-meta">Interrompido</div>}
      {meta?.error && <div className="chat-meta error">{meta.error}</div>}
    </div>
  )
})

function LiveView({ blocks }: { blocks: ChatBlock[] }): React.JSX.Element {
  const last = blocks.at(-1)
  const toolRunning = last?.type === 'tool' && last.status === 'running'
  return (
    <div className="chat-msg assistant live">
      <Blocks blocks={blocks} />
      {!toolRunning && (
        <div className="chat-working" aria-live="polite">
          <span className="chat-dots">
            <i />
            <i />
            <i />
          </span>
          {last ? 'Trabalhando…' : 'Pensando…'}
        </div>
      )}
    </div>
  )
}

function Blocks({ blocks }: { blocks: ChatBlock[] }): React.JSX.Element {
  return (
    <>
      {blocks.map((b, i) => (b.type === 'text' ? <Markdown key={i} text={b.text} /> : <ToolChip key={b.id} tool={b} />))}
    </>
  )
}

function Markdown({ text }: { text: string }): React.JSX.Element {
  const html = useMemo(() => renderMarkdown(text), [text])
  return <div className="markdown chat-md" dangerouslySetInnerHTML={{ __html: html }} />
}

function ToolChip({ tool }: { tool: ChatToolBlock }): React.JSX.Element {
  const kind = toolKind(tool.name)
  const Icon = kind === 'board' ? IconPen : kind === 'macro' ? IconDoc : kind === 'read' ? IconFile : IconSearch
  return (
    <div className={`chat-tool ${tool.status}`} title={tool.error ? `${tool.label}: ${tool.error}` : tool.name}>
      <Icon size={13} />
      <span className="chat-tool-label">
        {tool.label}
        {tool.status === 'running' ? '…' : ''}
      </span>
      {tool.summary && <span className="chat-tool-summary mono">{tool.summary}</span>}
      <span className="chat-tool-state">
        {tool.status === 'running' ? (
          <span className="chat-spinner" />
        ) : tool.status === 'ok' ? (
          <IconCheck size={13} />
        ) : (
          <IconX size={12} />
        )}
      </span>
    </div>
  )
}
