// Excalidraw board of an idea. Loaded lazily (own chunk) by BoardTab.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Excalidraw, MainMenu, WelcomeScreen } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
  LibraryItems
} from '@excalidraw/excalidraw/types'
import type { OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { SaveStatus } from '../lib/autosave'
import { useAutosave } from '../hooks/useAutosave'
import { boardService } from './boardService'
import { buildBoardSave, liveElements, sceneSignature, type FilesLike } from './boardScene'

const api = window.api

interface Snapshot {
  elements: readonly OrderedExcalidrawElement[]
  appState: AppState
  files: BinaryFiles
}

export interface BoardProps {
  ideaId: number
  /** Whether the Board tab is the visible one (the board stays mounted when hidden). */
  active: boolean
  onStatus: (status: SaveStatus, error?: unknown) => void
}

export default function Board({ ideaId, active, onStatus }: BoardProps): React.JSX.Element {
  const [initial, setInitial] = useState<ExcalidrawInitialDataState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const excalidrawRef = useRef<ExcalidrawImperativeAPI | null>(null)
  /** File ids already stored in the DB (never re-sent). */
  const persisted = useRef<Set<string>>(new Set())
  const lastSig = useRef('')
  const hadBoard = useRef(false)
  const sawFirstChange = useRef(false)
  /** The saved library was read: only then may Excalidraw's changes overwrite it. */
  const libraryLoaded = useRef(false)

  const autosave = useAutosave<Snapshot>(
    async (snap) => {
      const { input, persistedAfter } = buildBoardSave(
        snap.elements,
        snap.appState as unknown as Record<string, unknown>,
        snap.files as unknown as FilesLike,
        persisted.current
      )
      await api.boards.save(ideaId, input)
      persisted.current = persistedAfter
      hadBoard.current = true
    },
    800,
    onStatus
  )

  useEffect(() => {
    let alive = true
    libraryLoaded.current = false
    // Biblioteca de formas (global): a failed read must not let an empty library overwrite the saved one.
    const library = api.boards.getLibrary().then(
      (items) => {
        libraryLoaded.current = true
        return items as LibraryItems
      },
      () => [] as LibraryItems
    )
    Promise.all([api.boards.get(ideaId), library])
      .then(([board, libraryItems]) => {
        if (!alive) return
        hadBoard.current = board !== null
        const files = Object.fromEntries((board?.files ?? []).map((f) => [f.id, f]))
        persisted.current = new Set(Object.keys(files))
        const elements = (board?.elements ?? []) as OrderedExcalidrawElement[]
        const appState = (board?.appState ?? {}) as Partial<AppState>
        lastSig.current = sceneSignature(elements, appState, files)
        setInitial({
          elements,
          appState,
          files: files as unknown as BinaryFiles,
          libraryItems,
          scrollToContent: false
        })
      })
      .catch((err: unknown) => alive && setLoadError(err instanceof Error ? err.message : String(err)))
    return () => {
      alive = false
    }
  }, [ideaId])

  useEffect(() => () => boardService.detach(ideaId), [ideaId])

  // Coming back to the tab: let Excalidraw re-measure its container.
  useEffect(() => {
    if (active) excalidrawRef.current?.refresh()
  }, [active])

  const onChange = useCallback(
    (elements: readonly OrderedExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
      const sig = sceneSignature(elements, appState as unknown as Record<string, unknown>, files)
      if (sig === lastSig.current) return // selection, hover, menus…: nothing to persist
      lastSig.current = sig
      const first = !sawFirstChange.current
      sawFirstChange.current = true
      // Excalidraw's own first onChange on an empty, never-saved board: skip.
      if (first && !hadBoard.current && liveElements(elements).length === 0) return
      autosave.schedule({ elements, appState, files })
    },
    [] // autosave.schedule only touches the stable Autosaver instance
  )

  const onLibraryChange = useCallback(
    (items: LibraryItems) => {
      if (!libraryLoaded.current) return
      api.boards.saveLibrary([...items]).catch((err: unknown) => onStatus('error', err))
    },
    [onStatus]
  )

  if (loadError) return <div className="ws-placeholder">Não foi possível abrir o board: {loadError}</div>
  if (!initial) return <div className="ws-placeholder">Carregando board…</div>

  return (
    <div className="board">
      <Excalidraw
        initialData={initial}
        excalidrawAPI={(xapi) => {
          excalidrawRef.current = xapi
          boardService.attach(ideaId, xapi)
        }}
        onChange={onChange}
        onLibraryChange={onLibraryChange}
        theme="dark"
        langCode="pt-BR"
        UIOptions={{
          canvasActions: {
            loadScene: false,
            saveToActiveFile: false,
            export: false,
            toggleTheme: null
          }
        }}
      >
        <MainMenu>
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.SearchMenu />
          <MainMenu.DefaultItems.Help />
          <MainMenu.DefaultItems.ClearCanvas />
          <MainMenu.Separator />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
        </MainMenu>
        <WelcomeScreen>
          <WelcomeScreen.Hints.MenuHint />
          <WelcomeScreen.Hints.ToolbarHint />
          <WelcomeScreen.Hints.HelpHint />
          <WelcomeScreen.Center>
            <WelcomeScreen.Center.Heading>
              Desenhe a ideia: caixas, setas, textos e imagens (Ctrl+V).
              <br />
              Tudo é salvo automaticamente.
            </WelcomeScreen.Center.Heading>
          </WelcomeScreen.Center>
        </WelcomeScreen>
      </Excalidraw>
    </div>
  )
}
