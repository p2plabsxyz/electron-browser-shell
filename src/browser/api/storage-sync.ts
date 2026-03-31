import { app, safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'

export class StorageSyncAPI {
  private baseDir: string
  private localBaseDir: string
  private ready: Promise<void>
  private localReady: Promise<void>

  constructor(private ctx: ExtensionContext) {
    this.baseDir = path.join(app.getPath('userData'), 'extension-sync')
    this.localBaseDir = path.join(app.getPath('userData'), 'extension-local')
    this.ready = fs.mkdir(this.baseDir, { recursive: true, mode: 0o700 }).then(() => {})
    this.localReady = fs.mkdir(this.localBaseDir, { recursive: true, mode: 0o700 }).then(() => {})

    const handle = this.ctx.router.apiHandler()
    handle('storage.sync.get', this.get, { permission: 'storage' })
    handle('storage.sync.set', this.set, { permission: 'storage' })
    handle('storage.sync.remove', this.remove, { permission: 'storage' })
    handle('storage.sync.clear', this.clear, { permission: 'storage' })
    handle('storage.sync.getBytesInUse', this.getBytesInUse, { permission: 'storage' })
    handle('storage.local.get', this.localGet, { permission: 'storage' })
    handle('storage.local.set', this.localSet, { permission: 'storage' })
    handle('storage.local.remove', this.localRemove, { permission: 'storage' })
    handle('storage.local.clear', this.localClear, { permission: 'storage' })
    handle('storage.local.getBytesInUse', this.localGetBytesInUse, { permission: 'storage' })
  }

  private getFilePath = (extensionId: string) => {
    return path.join(this.baseDir, `${extensionId}.json`)
  }

  private getLocalFilePath = (extensionId: string) => {
    return path.join(this.localBaseDir, `${extensionId}.json`)
  }

  private load = async (extensionId: string): Promise<Record<string, any>> => {
    await this.ready
    const filePath = this.getFilePath(extensionId)
    let buffer: Buffer
    try {
      buffer = await fs.readFile(filePath)
    } catch (err: any) {
      if (err?.code === 'ENOENT') return {}
      console.error('Failed to load storage sync data', err)
      return {}
    }
    try {
      // Storage files may be written either as plaintext JSON (when OS encryption
      // wasn't available) or as encrypted bytes. `safeStorage.isEncryptionAvailable()`
      // can change across runs, so detect the format from the file contents.
      const utf8 = buffer.toString('utf-8')
      const firstNonWs = utf8.match(/[^\s]/)?.[0]
      if (firstNonWs === '{' || firstNonWs === '[') {
        return JSON.parse(utf8)
      }
      if (safeStorage.isEncryptionAvailable()) {
        return JSON.parse(safeStorage.decryptString(buffer))
      }
      throw new Error('Encrypted storage unavailable')
    } catch (err: any) {
      console.error('Failed to parse storage sync data', err)
      return {}
    }
  }

  private save = async (extensionId: string, data: Record<string, any>) => {
    await this.ready
    let json: string
    try {
      json = JSON.stringify(data)
    } catch (err) {
      throw new Error('Value is not JSON-serializable')
    }
    const content = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(json)
      : json
    const filePath = this.getFilePath(extensionId)
    const tmpPath = `${filePath}.tmp`
    await fs.writeFile(tmpPath, content, { mode: 0o600 })
    await fs.rename(tmpPath, filePath)
  }

  private get = async ({ extension }: ExtensionEvent, keys?: string | string[] | Record<string, any> | null) => {
    const data = await this.load(extension.id)
    if (keys == null) return data

    const result: Record<string, any> = {}
    if (typeof keys === 'string') {
      if (keys in data) result[keys] = data[keys]
    } else if (Array.isArray(keys)) {
      keys.forEach(k => {
        if (k in data) result[k] = data[k]
      })
    } else {
      Object.entries(keys).forEach(([k, defaultVal]) => {
        result[k] = k in data ? data[k] : defaultVal
      })
    }
    return result
  }

  private set = async ({ extension }: ExtensionEvent, items: Record<string, any>) => {
    const data = await this.load(extension.id)
    const changes: Record<string, chrome.storage.StorageChange> = {}

    if (!items || typeof items !== 'object' || Array.isArray(items)) {
      throw new Error('Invalid items')
    }

    Object.entries(items).forEach(([k, v]) => {
      let same = false
      if (typeof v === 'object' && v !== null) {
        try {
          same = JSON.stringify(data[k]) === JSON.stringify(v)
        } catch {
          same = false
        }
      } else {
        same = data[k] === v
      }
      if (!same) {
        changes[k] = { newValue: v }
        if (k in data) changes[k].oldValue = data[k]
        data[k] = v
      }
    })

    if (Object.keys(changes).length > 0) {
      await this.save(extension.id, data)
      this.ctx.router.sendEvent(extension.id, 'storage.onChanged', changes, 'sync')
    }
  }

  private remove = async ({ extension }: ExtensionEvent, keys: string | string[]) => {
    if (!keys) return
    const data = await this.load(extension.id)
    const changes: Record<string, chrome.storage.StorageChange> = {}

    const toDelete = Array.isArray(keys) ? keys : [keys]
    toDelete.forEach(k => {
      if (k in data) {
        changes[k] = { oldValue: data[k] }
        delete data[k]
      }
    })

    if (Object.keys(changes).length > 0) {
      await this.save(extension.id, data)
      this.ctx.router.sendEvent(extension.id, 'storage.onChanged', changes, 'sync')
    }
  }

  private clear = async ({ extension }: ExtensionEvent) => {
    const data = await this.load(extension.id)
    const changes: Record<string, chrome.storage.StorageChange> = {}

    Object.keys(data).forEach(k => {
      changes[k] = { oldValue: data[k] }
    })

    if (Object.keys(changes).length > 0) {
      await this.save(extension.id, {})
      this.ctx.router.sendEvent(extension.id, 'storage.onChanged', changes, 'sync')
    }
  }

  private getBytesInUse = async ({ extension }: ExtensionEvent, keys?: string | string[] | null) => {
    const result = await this.get({ extension } as ExtensionEvent, keys)
    return Buffer.byteLength(JSON.stringify(result))
  }

  private localLoad = async (extensionId: string): Promise<Record<string, any>> => {
    await this.localReady
    const filePath = this.getLocalFilePath(extensionId)
    let buffer: Buffer
    try {
      buffer = await fs.readFile(filePath)
    } catch (err: any) {
      if (err?.code === 'ENOENT') return {}
      console.error('Failed to load storage local data', err)
      return {}
    }
    try {
      // Same format detection as sync storage.
      const utf8 = buffer.toString('utf-8')
      const firstNonWs = utf8.match(/[^\s]/)?.[0]
      if (firstNonWs === '{' || firstNonWs === '[') {
        return JSON.parse(utf8)
      }
      if (safeStorage.isEncryptionAvailable()) {
        return JSON.parse(safeStorage.decryptString(buffer))
      }
      throw new Error('Encrypted storage unavailable')
    } catch (err: any) {
      console.error('Failed to parse storage local data', err)
      return {}
    }
  }

  private localSave = async (extensionId: string, data: Record<string, any>) => {
    await this.localReady
    let json: string
    try {
      json = JSON.stringify(data)
    } catch {
      throw new Error('Value is not JSON-serializable')
    }
    const content = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(json)
      : json
    const filePath = this.getLocalFilePath(extensionId)
    const tmpPath = `${filePath}.tmp`
    await fs.writeFile(tmpPath, content, { mode: 0o600 })
    await fs.rename(tmpPath, filePath)
  }

  private localGet = async ({ extension }: ExtensionEvent, keys?: string | string[] | Record<string, any> | null) => {
    const data = await this.localLoad(extension.id)
    if (keys == null) return data
    const result: Record<string, any> = {}
    if (typeof keys === 'string') {
      if (keys in data) result[keys] = data[keys]
    } else if (Array.isArray(keys)) {
      keys.forEach(k => {
        if (k in data) result[k] = data[k]
      })
    } else {
      Object.entries(keys).forEach(([k, defaultVal]) => {
        result[k] = k in data ? data[k] : defaultVal
      })
    }
    return result
  }

  private localSet = async ({ extension }: ExtensionEvent, items: Record<string, any>) => {
    const data = await this.localLoad(extension.id)
    const changes: Record<string, chrome.storage.StorageChange> = {}

    if (!items || typeof items !== 'object' || Array.isArray(items)) {
      throw new Error('Invalid items')
    }

    Object.entries(items).forEach(([k, v]) => {
      let same = false
      if (typeof v === 'object' && v !== null) {
        try {
          same = JSON.stringify(data[k]) === JSON.stringify(v)
        } catch {
          same = false
        }
      } else {
        same = data[k] === v
      }
      if (!same) {
        changes[k] = { newValue: v }
        if (k in data) changes[k].oldValue = data[k]
        data[k] = v
      }
    })

    if (Object.keys(changes).length > 0) {
      await this.localSave(extension.id, data)
      this.ctx.router.sendEvent(extension.id, 'storage.onChanged', changes, 'local')
    }
  }

  private localRemove = async ({ extension }: ExtensionEvent, keys: string | string[]) => {
    if (!keys) return
    const data = await this.localLoad(extension.id)
    const changes: Record<string, chrome.storage.StorageChange> = {}
    const toDelete = Array.isArray(keys) ? keys : [keys]
    toDelete.forEach(k => {
      if (k in data) {
        changes[k] = { oldValue: data[k] }
        delete data[k]
      }
    })
    if (Object.keys(changes).length > 0) {
      await this.localSave(extension.id, data)
      this.ctx.router.sendEvent(extension.id, 'storage.onChanged', changes, 'local')
    }
  }

  private localClear = async ({ extension }: ExtensionEvent) => {
    const data = await this.localLoad(extension.id)
    const changes: Record<string, chrome.storage.StorageChange> = {}
    Object.keys(data).forEach(k => {
      changes[k] = { oldValue: data[k] }
    })
    if (Object.keys(changes).length > 0) {
      await this.localSave(extension.id, {})
      this.ctx.router.sendEvent(extension.id, 'storage.onChanged', changes, 'local')
    }
  }

  private localGetBytesInUse = async ({ extension }: ExtensionEvent, keys?: string | string[] | null) => {
    const result = await this.localGet({ extension } as ExtensionEvent, keys)
    return Buffer.byteLength(JSON.stringify(result))
  }
}
