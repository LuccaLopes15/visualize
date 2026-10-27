import { Marked } from 'marked'
import DOMPurify from 'dompurify'

const md = new Marked({ gfm: true, breaks: false, async: false })

// Links open in the default browser: main's setWindowOpenHandler only lets
// http(s) through to shell.openExternal and denies everything else.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

/** Markdown -> sanitized HTML (raw HTML in the source is sanitized, never injected as-is). */
export function renderMarkdown(source: string): string {
  const html = md.parse(source) as string
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'iframe', 'object', 'embed'],
    FORBID_ATTR: ['style']
  })
}
