import { StringDecoder } from 'node:string_decoder'

/**
 * Incremental NDJSON parser for the CLI's stdout. Chunks may end mid-line or
 * mid UTF-8 sequence (StringDecoder keeps the partial bytes); blank lines are
 * skipped; lines that are not JSON objects go to `onBad` instead of throwing.
 */
export class NdjsonParser {
  private readonly decoder = new StringDecoder('utf8')
  private buffer = ''

  constructor(
    private readonly onValue: (value: Record<string, unknown>) => void,
    private readonly onBad: (line: string, error: unknown) => void = () => {},
    /** Safety cap for a single line without newline (protects memory). */
    private readonly maxLine = 64 * 1024 * 1024
  ) {}

  push(chunk: Buffer | string): void {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    let nl: number
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl)
      this.buffer = this.buffer.slice(nl + 1)
      this.handle(line)
    }
    if (this.buffer.length > this.maxLine) {
      this.onBad(this.buffer.slice(0, 200), new Error('linha grande demais'))
      this.buffer = ''
    }
  }

  /** Flushes the decoder and a trailing line without newline. */
  end(): void {
    this.buffer += this.decoder.end()
    const rest = this.buffer
    this.buffer = ''
    if (rest) this.handle(rest)
  }

  private handle(raw: string): void {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (!line.trim()) return
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch (err) {
      this.onBad(line, err)
      return
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) this.onValue(value as Record<string, unknown>)
    else this.onBad(line, new Error('não é um objeto JSON'))
  }
}
