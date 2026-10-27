// Converts keyboard events into Electron accelerator strings and back to a
// display form. Kept DOM-free (takes a plain object) so it can be unit tested.

export interface KeyLike {
  key: string
  code: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'OS'])

function keyFromCode(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^Numpad[0-9]$/.test(code)) return `num${code.slice(6)}`
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code
  const map: Record<string, string> = {
    Space: 'Space',
    Enter: 'Enter',
    Tab: 'Tab',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Insert: 'Insert',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    Backquote: '`'
  }
  return map[code] ?? null
}

/**
 * Returns an accelerator like "Control+Alt+Space", or null when the event is
 * only modifiers / has no modifier (a global shortcut needs Ctrl/Alt/Win,
 * except function keys).
 */
export function eventToAccelerator(e: KeyLike): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null
  const key = keyFromCode(e.code)
  if (!key) return null
  const mods: string[] = []
  if (e.ctrlKey) mods.push('Control')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  if (e.metaKey) mods.push('Super')
  const isFn = /^F\d+$/.test(key)
  const hasStrongModifier = e.ctrlKey || e.altKey || e.metaKey
  if (!hasStrongModifier && !isFn) return null
  return [...mods, key].join('+')
}

export function formatAccelerator(acc: string): string {
  return acc
    .split('+')
    .map((part) => {
      switch (part) {
        case 'Control':
        case 'CommandOrControl':
        case 'CmdOrCtrl':
          return 'Ctrl'
        case 'Super':
        case 'Meta':
          return 'Win'
        case 'Space':
          return 'Espaço'
        default:
          return part
      }
    })
    .join(' + ')
}
