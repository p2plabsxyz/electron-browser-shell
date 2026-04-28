import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { app } from 'electron'
import path from 'node:path'

type PersistedDownloadItem = {
  id: number
  extensionId: string
  url: string
  filename: string
  finalUrl: string
  mime: string
  startTime: string
  state: 'in_progress' | 'interrupted' | 'complete'
  bytesReceived: number
  totalBytes: number
  exists: boolean
  byExtensionId: string
  byExtensionName: string
}

type PersistedDownloadsState = {
  nextId: number
  items: PersistedDownloadItem[]
}

type PendingDownloadRequest = {
  extensionId: string
  id: number
  filename?: string
  saveAs?: boolean
}

const DOWNLOADS_STATE_NS = 'downloads'

export class DownloadsAPI {
  private nextId = 1
  private records = new Map<number, PersistedDownloadItem>()
  private pendingByUrl = new Map<string, PendingDownloadRequest[]>()
  private itemIdByDownloadItem = new WeakMap<Electron.DownloadItem, number>()
  private activeItems = new Map<number, Electron.DownloadItem>()
  private restoreReady: Promise<void>

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    // Electron may classify 'downloads' as unknown in some manifests; hosts can
    // still use `setPermissionResolver` so optional/granted downloads access is honored.
    const downloadsPerm = { permission: 'downloads' as const }
    handle('downloads.download', this.download, downloadsPerm)
    handle('downloads.search', this.search, downloadsPerm)
    handle('downloads.pause', this.pause, downloadsPerm)
    handle('downloads.resume', this.resume, downloadsPerm)
    handle('downloads.cancel', this.cancel, downloadsPerm)
    handle('downloads.erase', this.erase, downloadsPerm)
    handle('downloads.acceptDanger', this.unsupported('downloads.acceptDanger'), downloadsPerm)
    handle('downloads.getFileIcon', this.unsupported('downloads.getFileIcon'), downloadsPerm)
    handle('downloads.open', this.unsupported('downloads.open'), downloadsPerm)
    handle('downloads.removeFile', this.unsupported('downloads.removeFile'), downloadsPerm)
    handle('downloads.setUiOptions', this.unsupported('downloads.setUiOptions'), downloadsPerm)
    handle('downloads.show', this.unsupported('downloads.show'), downloadsPerm)
    handle('downloads.showDefaultFolder', this.unsupported('downloads.showDefaultFolder'), downloadsPerm)

    this.restoreReady = this.restore()
    this.observeSessionDownloads()
  }

  private async restore() {
    await this.ctx.stateStore.whenHydrated()
    const state = this.ctx.stateStore.getNamespace<PersistedDownloadsState>(DOWNLOADS_STATE_NS, {
      nextId: 1,
      items: [],
    })
    this.nextId = Math.max(1, Number(state?.nextId || 1))
    for (const item of state?.items || []) {
      if (!item || typeof item.id !== 'number') continue
      this.records.set(item.id, item)
    }
  }

  private persist() {
    const state: PersistedDownloadsState = {
      nextId: this.nextId,
      items: Array.from(this.records.values()),
    }
    this.ctx.stateStore.setNamespace(DOWNLOADS_STATE_NS, state)
    void this.ctx.stateStore.flush().catch(() => {})
  }

  private observeSessionDownloads() {
    this.ctx.session.on('will-download', (_event, item) => {
      const url = item.getURL()
      const pending = this.consumePending(url)
      if (!pending) return
      const { extensionId, id, filename, saveAs } = pending

      const extension = (this.ctx.session.extensions || this.ctx.session).getExtension(extensionId)
      if (!extension) return

      if (filename) {
        const defaultPath = path.join(app.getPath('downloads'), path.basename(filename))
        const itemAny = item as any
        if (saveAs && typeof itemAny.setSaveDialogOptions === 'function') {
          itemAny.setSaveDialogOptions({ defaultPath })
        } else {
          item.setSavePath(defaultPath)
        }
      }

      this.itemIdByDownloadItem.set(item, id)
      this.activeItems.set(id, item)

      const record: PersistedDownloadItem = {
        id,
        extensionId,
        url,
        filename: item.getFilename(),
        finalUrl: item.getURL(),
        mime: item.getMimeType() || '',
        startTime: new Date().toISOString(),
        state: 'in_progress',
        bytesReceived: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
        exists: true,
        byExtensionId: extensionId,
        byExtensionName: extension.name,
      }

      this.records.set(id, record)
      this.persist()
      this.ctx.router.sendEvent(extensionId, 'downloads.onCreated', { ...record })

      item.on('updated', () => {
        const previousState = record.state
        const previousBytes = record.bytesReceived
        record.bytesReceived = item.getReceivedBytes()
        record.totalBytes = item.getTotalBytes()
        record.filename = item.getFilename()

        let nextState = previousState
        const itemState = item.getState()
        if (itemState === 'interrupted') nextState = 'interrupted'
        if (itemState === 'progressing' && !item.isPaused()) nextState = 'in_progress'
        record.state = nextState

        const delta: Record<string, any> = { id }
        if (record.state !== previousState) {
          delta.state = { previous: previousState, current: record.state }
        }
        if (record.bytesReceived !== previousBytes) {
          delta.bytesReceived = { previous: previousBytes, current: record.bytesReceived }
        }
        if (Object.keys(delta).length > 1) {
          this.ctx.router.sendEvent(extensionId, 'downloads.onChanged', delta)
        }
      })

      item.once('done', (_ev, doneState) => {
        const previousState = record.state
        if (doneState === 'completed') {
          record.state = 'complete'
        } else {
          record.state = 'interrupted'
        }
        record.bytesReceived = item.getReceivedBytes()
        record.totalBytes = item.getTotalBytes()
        this.persist()
        this.ctx.router.sendEvent(extensionId, 'downloads.onChanged', {
          id,
          state: { previous: previousState, current: record.state },
          bytesReceived: { current: record.bytesReceived },
        })
        this.activeItems.delete(id)
      })
    })
  }

  private consumePending(url: string): PendingDownloadRequest | undefined {
    const queue = this.pendingByUrl.get(url)
    if (!queue || queue.length === 0) return undefined
    const pending = queue.shift()
    if (queue.length === 0) {
      this.pendingByUrl.delete(url)
    } else {
      this.pendingByUrl.set(url, queue)
    }
    return pending
  }

  private enqueuePending(url: string, pending: PendingDownloadRequest) {
    const queue = this.pendingByUrl.get(url) || []
    queue.push(pending)
    this.pendingByUrl.set(url, queue)
  }

  private download = async (
    { extension }: ExtensionEvent,
    options: chrome.downloads.DownloadOptions,
  ): Promise<number> => {
    await this.restoreReady
    const url = options?.url
    if (!url || typeof url !== 'string') {
      throw new Error('downloads.download requires a valid URL')
    }

    const id = this.nextId++
    this.enqueuePending(url, {
      extensionId: extension.id,
      id,
      filename: options?.filename,
      saveAs: options?.saveAs,
    })
    const sessionAny = this.ctx.session as any
    if (typeof sessionAny.downloadURL === 'function') {
      sessionAny.downloadURL(url)
      this.persist()
      return id
    }

    throw new Error('downloads.download is not supported by this Electron session')
  }

  private search = async (
    { extension }: ExtensionEvent,
    query: chrome.downloads.DownloadQuery = {},
  ): Promise<PersistedDownloadItem[]> => {
    await this.restoreReady
    let items = Array.from(this.records.values()).filter((item) => item.extensionId === extension.id)

    if (typeof query.id === 'number') {
      items = items.filter((item) => item.id === query.id)
    }
    if (typeof query.state === 'string') {
      items = items.filter((item) => item.state === query.state)
    }
    if (typeof query.filename === 'string') {
      items = items.filter((item) => item.filename.includes(query.filename as string))
    }
    if (typeof query.url === 'string') {
      items = items.filter((item) => item.url.includes(query.url as string))
    }

    return items.map((item) => ({ ...item }))
  }

  private findRecordForExtension(extensionId: string, id: number): PersistedDownloadItem | undefined {
    const record = this.records.get(id)
    if (!record || record.extensionId !== extensionId) return undefined
    return record
  }

  private pause = async ({ extension }: ExtensionEvent, id: number): Promise<void> => {
    await this.restoreReady
    const record = this.findRecordForExtension(extension.id, id)
    if (!record) throw new Error(`No download with id ${id}`)
    const item = this.activeItems.get(id)
    if (!item) throw new Error(`Download ${id} is not active`)
    item.pause()
  }

  private resume = async ({ extension }: ExtensionEvent, id: number): Promise<void> => {
    await this.restoreReady
    const record = this.findRecordForExtension(extension.id, id)
    if (!record) throw new Error(`No download with id ${id}`)
    const item = this.activeItems.get(id)
    if (!item) throw new Error(`Download ${id} is not active`)
    item.resume()
  }

  private cancel = async ({ extension }: ExtensionEvent, id: number): Promise<void> => {
    await this.restoreReady
    const record = this.findRecordForExtension(extension.id, id)
    if (!record) throw new Error(`No download with id ${id}`)
    const item = this.activeItems.get(id)
    if (!item) throw new Error(`Download ${id} is not active`)
    item.cancel()
  }

  private erase = async ({ extension }: ExtensionEvent, query: chrome.downloads.DownloadQuery = {}) => {
    await this.restoreReady
    const erasedIds: number[] = []
    for (const record of this.records.values()) {
      if (record.extensionId !== extension.id) continue
      if (typeof query.id === 'number' && record.id !== query.id) continue
      this.records.delete(record.id)
      this.activeItems.delete(record.id)
      erasedIds.push(record.id)
      this.ctx.router.sendEvent(extension.id, 'downloads.onErased', record.id)
    }
    if (erasedIds.length > 0) {
      this.persist()
    }
    return erasedIds
  }

  private unsupported = (method: string) => {
    return async (..._args: unknown[]) => {
      // Probe-style API: Chrome often surfaces "no icon" as null rather than failing the call.
      if (method === 'downloads.getFileIcon') {
        return null
      }
      throw new Error(`${method} is not supported yet`)
    }
  }
}
