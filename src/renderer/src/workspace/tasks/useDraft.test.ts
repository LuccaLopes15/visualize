// Tests for the real `useDraft` hook (not just `DraftCore`): mounted with react-dom in Node, the
// way SidePanel uses it for the description, to prove that leaving the field with an open
// conflict (unmount, app quitting) writes both versions.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { flushAll } from '../../lib/autosave'
import { mergeDrafts } from './draftCore'
import { useDraft, type Draft } from './useDraft'

// The probe renders nothing, so react-dom never touches the DOM: a container that accepts the
// root's event listeners and an empty `window` (read for `window.event`) are enough (no jsdom).
function fakeContainer(): Element {
  const doc = { nodeType: 9, addEventListener: () => {}, removeEventListener: () => {} }
  return { nodeType: 1, tagName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml', ownerDocument: doc, addEventListener: () => {}, removeEventListener: () => {} } as unknown as Element
}

interface Mounted {
  current: () => Draft
  setValue: (v: string) => void
  unmount: () => void
}

function mount(value: string, commit: (next: string) => void, merge = mergeDrafts): Mounted {
  let draft: Draft | undefined
  const Probe = (props: { value: string }): null => {
    draft = useDraft(props.value, commit, 0, merge)
    return null
  }
  const root: Root = createRoot(fakeContainer())
  const render = (v: string): void => act(() => root.render(createElement(Probe, { value: v })))
  render(value)
  return {
    current: () => draft as Draft,
    setValue: render,
    unmount: () => act(() => root.unmount())
  }
}

/** Opens the conflict: the user types, then Claude's version arrives before the edit is sent. */
function openConflict(m: Mounted): void {
  act(() => m.current().change('meu texto'))
  m.setValue('versão do Claude')
  expect(m.current().conflict).toBe('versão do Claude')
  expect(m.current().draft).toBe('meu texto')
}

const merged = mergeDrafts('versão do Claude', 'meu texto')

beforeAll(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('window', { HTMLIFrameElement: class {} })
})
afterAll(() => {
  vi.unstubAllGlobals()
})

let live: Mounted | null = null
afterEach(() => {
  live?.unmount()
  live = null
})

describe('useDraft (hook) with a conflict', () => {
  it('holds the user text while the user stays on the node (blur / plain flush write nothing)', async () => {
    const commit = vi.fn()
    live = mount('original', commit)
    openConflict(live)
    await act(() => live!.current().flush())
    await act(() => flushAll())
    expect(commit).not.toHaveBeenCalled()
    expect(live.current().conflict).toBe('versão do Claude')
  })

  it('unmount (other node, panel / tab / workspace closed) writes both versions', () => {
    const commit = vi.fn()
    const m = mount('original', commit)
    openConflict(m)
    m.unmount()
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledWith(merged)
    expect(merged).toContain('versão do Claude')
    expect(merged).toContain('meu texto')
  })

  it('the app quitting (flushAll leaving) writes both versions, and unmount does not write again', async () => {
    const commit = vi.fn()
    const m = mount('original', commit)
    openConflict(m)
    await act(() => flushAll({ leaving: true }))
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledWith(merged)
    m.setValue(merged) // the stored value echoes what was written
    expect(m.current().conflict).toBeNull()
    expect(m.current().draft).toBe(merged)
    m.unmount()
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('without a conflict, unmount writes only the user text', () => {
    const commit = vi.fn()
    const m = mount('original', commit)
    act(() => m.current().change('original editado'))
    m.unmount()
    expect(commit).toHaveBeenCalledWith('original editado')
  })
})
