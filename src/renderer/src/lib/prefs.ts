// Per-machine UI conveniences (open tab, chat panel, editor mode). Never data.
export function readPref(key: string): string | null {
  try {
    return localStorage.getItem(`visualize.${key}`)
  } catch {
    return null
  }
}

export function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(`visualize.${key}`, value)
  } catch {
    /* storage unavailable: preference just isn't remembered */
  }
}
