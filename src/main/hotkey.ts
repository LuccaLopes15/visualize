import { globalShortcut } from 'electron'
import type { HotkeyStatus } from '@shared/types'

/** Owns the single global "nova ideia" shortcut. */
export class HotkeyManager {
  private current: string | null = null
  private registered = false

  constructor(private readonly onTrigger: () => void) {}

  status(): HotkeyStatus {
    return { hotkey: this.current ?? '', registered: this.registered }
  }

  private tryRegister(accelerator: string): boolean {
    try {
      return globalShortcut.register(accelerator, this.onTrigger)
    } catch {
      // Invalid accelerator strings throw.
      return false
    }
  }

  /** Registers `accelerator` (replacing any previous one). Returns success. */
  register(accelerator: string): boolean {
    this.unregister()
    this.current = accelerator
    this.registered = this.tryRegister(accelerator)
    return this.registered
  }

  /**
   * Switches to a new accelerator. If the new one can't be registered the
   * previous one is restored and `false` is returned.
   */
  change(accelerator: string): boolean {
    const previous = this.current
    const previousOk = this.registered
    this.unregister()
    if (this.tryRegister(accelerator)) {
      this.current = accelerator
      this.registered = true
      return true
    }
    if (previous) {
      this.current = previous
      this.registered = previousOk ? this.tryRegister(previous) : false
    }
    return false
  }

  unregister(): void {
    if (this.current && this.registered) globalShortcut.unregister(this.current)
    this.registered = false
  }
}

/** "Control+Alt+Space" -> "Ctrl+Alt+Space" for display. */
export function formatAccelerator(acc: string): string {
  return acc
    .replace(/CommandOrControl|CmdOrCtrl|Control/g, 'Ctrl')
    .replace(/\bSuper\b|\bMeta\b/g, 'Win')
}
