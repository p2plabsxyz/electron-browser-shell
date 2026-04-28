import { app } from 'electron'
import path from 'node:path'
import { promises as fs } from 'node:fs'

const STATE_SCHEMA_VERSION = 1

type StatePayload = {
  schemaVersion: number
  namespaces: Record<string, unknown>
}

type StateStoreOptions = {
  baseDir?: string
}

const sanitizeName = (input: string) =>
  input.replace(/[^a-z0-9._-]+/gi, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '') || 'default'

export class ExtensionStateStore {
  private filePath: string
  private state: StatePayload = { schemaVersion: STATE_SCHEMA_VERSION, namespaces: {} }
  private dirty = false
  private hydrated = false
  private hydratePromise?: Promise<void>

  constructor(private session: Electron.Session, opts: StateStoreOptions = {}) {
    const baseDir = opts.baseDir || path.join(app.getPath('userData'), 'chrome-extension-api-state')
    const partition = (session as any)?.partition || 'default'
    const filename = `${sanitizeName(partition)}.json`
    this.filePath = path.join(baseDir, filename)
  }

  async hydrate() {
    if (this.hydratePromise) {
      return this.hydratePromise
    }
    this.hydratePromise = this.doHydrate()
    return this.hydratePromise
  }

  private async doHydrate() {
    if (this.hydrated) return
    this.hydrated = true

    let raw: string
    try {
      raw = await fs.readFile(this.filePath, 'utf8')
    } catch {
      return
    }

    try {
      const parsed = JSON.parse(raw)
      if (
        parsed &&
        parsed.schemaVersion === STATE_SCHEMA_VERSION &&
        parsed.namespaces &&
        typeof parsed.namespaces === 'object'
      ) {
        this.state = parsed
        return
      }
    } catch {
      // Ignore malformed files and start clean.
    }

    this.state = { schemaVersion: STATE_SCHEMA_VERSION, namespaces: {} }
    this.dirty = true
  }

  async whenHydrated() {
    await this.hydrate()
  }

  getNamespace<T>(name: string, fallback: T): T {
    const value = this.state.namespaces[name]
    return (value as T) ?? fallback
  }

  setNamespace(name: string, value: unknown) {
    this.state.namespaces[name] = value
    this.dirty = true
  }

  async flush() {
    if (!this.dirty) return
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    await fs.writeFile(this.filePath, JSON.stringify(this.state, null, 2), 'utf8')
    this.dirty = false
  }
}
