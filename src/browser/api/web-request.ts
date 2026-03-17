import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { matchesPattern } from './common'

interface ListenerEntry {
  extensionId: string
  filter: { urls: string[] }
  extraInfoSpec?: string[]
}

export interface WebRequestBlockingResponse {
  cancel?: boolean
  redirectUrl?: string
  requestHeaders?: Record<string, string | string[]>
  responseHeaders?: Record<string, string | string[]>
}

export interface WebRequestDetails {
  url: string
  method: string
  tabId: number
  requestId?: string
  frameId?: number
  parentFrameId?: number
  type?: string
  timeStamp?: number
  initiator?: string
  requestBody?: chrome.webRequest.WebRequestBody
  requestHeaders?: Record<string, string | string[]>
  responseHeaders?: Record<string, string | string[]>
  statusCode?: number
  ip?: string
  fromCache?: boolean
  error?: string
}

interface ElectronRequestDetails {
  id?: string | number
  url?: string
  method?: string
  resourceType?: string
  timestamp?: number
  referrer?: string
  webContentsId?: number
  frameId?: number
  parentFrameId?: number
  uploadData?: Array<{ bytes?: Buffer; file?: string }>
  requestHeaders?: Record<string, string | string[]>
  responseHeaders?: Record<string, string | string[]>
  statusCode?: number
  fromCache?: boolean
  error?: string
  ip?: string
}

interface PendingBlockingRequest<T = WebRequestBlockingResponse> {
  resolve: (result: T) => void
  results: Map<string, any>
  expectedCount: number
  timeoutHandle: ReturnType<typeof setTimeout>
  merge: (results: Map<string, any>) => T
}

const BLOCKING_RESPONSE_TIMEOUT_MS = 2000

export class WebRequestAPI {
  private onBeforeRequestListeners: ListenerEntry[] = []
  private onBeforeSendHeadersListeners: ListenerEntry[] = []
  private onSendHeadersListeners: ListenerEntry[] = []
  private onHeadersReceivedListeners: ListenerEntry[] = []
  private onResponseStartedListeners: ListenerEntry[] = []
  private onCompletedListeners: ListenerEntry[] = []
  private onErrorOccurredListeners: ListenerEntry[] = []

  private requestIdCounter = 0
  private pendingBlocking = new Map<string, PendingBlockingRequest>()

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('webRequest.addOnBeforeRequestListener', this.addOnBeforeRequestListener, {
      permission: 'webRequest',
    })
    handle(
      'webRequest.addOnBeforeSendHeadersListener',
      this.addOnBeforeSendHeadersListener,
      {
        permission: 'webRequest',
      },
    )
    handle('webRequest.addOnSendHeadersListener', this.addOnSendHeadersListener, {
      permission: 'webRequest',
    })
    handle('webRequest.addOnHeadersReceivedListener', this.addOnHeadersReceivedListener, {
      permission: 'webRequest',
    })
    handle(
      'webRequest.addOnResponseStartedListener',
      this.addOnResponseStartedListener,
      {
        permission: 'webRequest',
      },
    )
    handle('webRequest.addOnCompletedListener', this.addOnCompletedListener, {
      permission: 'webRequest',
    })
    handle(
      'webRequest.addOnErrorOccurredListener',
      this.addOnErrorOccurredListener,
      {
        permission: 'webRequest',
      },
    )

    handle('webRequest.onBeforeRequest.response', this.handleBlockingResponse)
    handle('webRequest.onBeforeSendHeaders.response', this.handleBlockingResponse)
    handle('webRequest.onHeadersReceived.response', this.handleBlockingResponse)

    const sessionExtensions = this.ctx.session.extensions || this.ctx.session
    sessionExtensions.on('extension-unloaded', (_event, extension) => {
      const id = extension.id
      this.onBeforeRequestListeners = this.onBeforeRequestListeners.filter((e) => e.extensionId !== id)
      this.onBeforeSendHeadersListeners = this.onBeforeSendHeadersListeners.filter(
        (e) => e.extensionId !== id,
      )
      this.onSendHeadersListeners = this.onSendHeadersListeners.filter((e) => e.extensionId !== id)
      this.onHeadersReceivedListeners = this.onHeadersReceivedListeners.filter(
        (e) => e.extensionId !== id,
      )
      this.onResponseStartedListeners = this.onResponseStartedListeners.filter(
        (e) => e.extensionId !== id,
      )
      this.onCompletedListeners = this.onCompletedListeners.filter((e) => e.extensionId !== id)
      this.onErrorOccurredListeners = this.onErrorOccurredListeners.filter(
        (e) => e.extensionId !== id,
      )
    })
  }

  private addOnBeforeRequestListener = (
    { extension }: ExtensionEvent,
    filter: { urls: string[] },
    extraInfoSpec?: string[],
  ) => {
    if (!filter?.urls || !Array.isArray(filter.urls)) return
    this.onBeforeRequestListeners.push({
      extensionId: extension.id,
      filter: { urls: filter.urls },
      extraInfoSpec,
    })
  }

  private addOnBeforeSendHeadersListener = (
    { extension }: ExtensionEvent,
    filter: { urls: string[] },
    extraInfoSpec?: string[],
  ) => {
    if (!filter?.urls || !Array.isArray(filter.urls)) return
    this.onBeforeSendHeadersListeners.push({
      extensionId: extension.id,
      filter: { urls: filter.urls },
      extraInfoSpec,
    })
  }

  private addOnSendHeadersListener = (
    { extension }: ExtensionEvent,
    filter: { urls: string[] },
    extraInfoSpec?: string[],
  ) => {
    if (!filter?.urls || !Array.isArray(filter.urls)) return
    this.onSendHeadersListeners.push({
      extensionId: extension.id,
      filter: { urls: filter.urls },
      extraInfoSpec,
    })
  }

  private addOnHeadersReceivedListener = (
    { extension }: ExtensionEvent,
    filter: { urls: string[] },
    extraInfoSpec?: string[],
  ) => {
    if (!filter?.urls || !Array.isArray(filter.urls)) return
    this.onHeadersReceivedListeners.push({
      extensionId: extension.id,
      filter: { urls: filter.urls },
      extraInfoSpec,
    })
  }

  private addOnResponseStartedListener = (
    { extension }: ExtensionEvent,
    filter: { urls: string[] },
    extraInfoSpec?: string[],
  ) => {
    if (!filter?.urls || !Array.isArray(filter.urls)) return
    this.onResponseStartedListeners.push({
      extensionId: extension.id,
      filter: { urls: filter.urls },
      extraInfoSpec,
    })
  }

  private addOnCompletedListener = (
    { extension }: ExtensionEvent,
    filter: { urls: string[] },
    extraInfoSpec?: string[],
  ) => {
    if (!filter?.urls || !Array.isArray(filter.urls)) return
    this.onCompletedListeners.push({
      extensionId: extension.id,
      filter: { urls: filter.urls },
      extraInfoSpec,
    })
  }

  private addOnErrorOccurredListener = (
    { extension }: ExtensionEvent,
    filter: { urls: string[] },
    extraInfoSpec?: string[],
  ) => {
    if (!filter?.urls || !Array.isArray(filter.urls)) return
    this.onErrorOccurredListeners.push({
      extensionId: extension.id,
      filter: { urls: filter.urls },
      extraInfoSpec,
    })
  }

  private handleBlockingResponse = (
    { extension }: ExtensionEvent,
    requestId: string,
    result: WebRequestBlockingResponse | undefined,
  ) => {
    const pending = this.pendingBlocking.get(requestId)
    if (!pending) return
    pending.results.set(extension.id, result || {})
    if (pending.results.size >= pending.expectedCount) {
      this.settlePending(requestId)
    }
  }

  private settlePending(requestId: string): void {
    const pending = this.pendingBlocking.get(requestId)
    if (!pending) return
    clearTimeout(pending.timeoutHandle)
    this.pendingBlocking.delete(requestId)
    const merged = pending.merge(pending.results)
    pending.resolve(merged)
  }

  private mergeCancelOrRedirect(
    results: Map<string, WebRequestBlockingResponse>,
  ): WebRequestBlockingResponse {
    for (const r of results.values()) {
      if (r.cancel === true) return { cancel: true }
    }
    for (const r of results.values()) {
      if (r.redirectUrl && r.redirectUrl.length > 0) return { redirectUrl: r.redirectUrl }
    }
    return {}
  }

  private normalizeResourceType(resourceType?: string): string {
    switch (resourceType) {
      case 'mainFrame':
        return 'main_frame'
      case 'subFrame':
        return 'sub_frame'
      case 'xhr':
      case 'xmlhttprequest':
        return 'xmlhttprequest'
      case 'script':
      case 'img':
      case 'image':
      case 'stylesheet':
      case 'font':
      case 'media':
      case 'fetch':
        return resourceType.toLowerCase()
      default:
        return 'other'
    }
  }

  private filterDetailsForListener(
    details: WebRequestDetails,
    extraInfoSpec?: string[],
  ): WebRequestDetails {
    if (!Array.isArray(extraInfoSpec) || extraInfoSpec.length === 0) {
      const { requestHeaders, responseHeaders, requestBody, ...rest } = details
      return { ...rest }
    }

    const includes = (key: string) => extraInfoSpec.includes(key)

    const includeReqHeaders = includes('requestHeaders') || includes('extraHeaders')
    const includeResHeaders = includes('responseHeaders') || includes('extraHeaders')
    const includeRequestBody = includes('requestBody')

    const clone: WebRequestDetails = { ...details }

    if (!includeReqHeaders && 'requestHeaders' in clone) {
      delete clone.requestHeaders
    }
    if (!includeResHeaders && 'responseHeaders' in clone) {
      delete clone.responseHeaders
    }
    if (!includeRequestBody && 'requestBody' in clone) {
      delete clone.requestBody
    }

    return clone
  }

  private getOrCreateRequestId(details: ElectronRequestDetails): string | undefined {
    if (details.id != null) {
      return String(details.id)
    }
    return undefined
  }

  private buildDetails(details: ElectronRequestDetails): WebRequestDetails {
    const rawWebContentsId = (details as any).webContentsId
    const tabId =
      typeof rawWebContentsId === 'number'
        ? this.ctx.store.getTabIdForWebContentsId(rawWebContentsId)
        : -1

    const requestId = this.getOrCreateRequestId(details)

    return {
      url: details.url || '',
      method: details.method || 'GET',
      tabId,
      requestId,
      frameId: typeof details.frameId === 'number' ? details.frameId : 0,
      parentFrameId:
        typeof details.parentFrameId === 'number' ? details.parentFrameId : -1,
      type: this.normalizeResourceType(details.resourceType),
      timeStamp: details.timestamp != null ? details.timestamp : Date.now(),
      initiator: details.referrer || undefined,
      requestBody: this.normalizeRequestBody(details),
      requestHeaders: details.requestHeaders,
      responseHeaders: details.responseHeaders,
      statusCode: details.statusCode,
      ip: details.ip,
      fromCache: details.fromCache,
      error: details.error,
    }
  }

  private normalizeRequestBody(
    details: ElectronRequestDetails,
  ): chrome.webRequest.WebRequestBody | undefined {
    const method = (details.method || 'GET').toUpperCase()
    const hasBodyMethod = method === 'POST' || method === 'PUT' || method === 'PATCH'
    if (!hasBodyMethod) return undefined

    const uploadData = details.uploadData
    if (!uploadData || uploadData.length === 0) return undefined

    const buffers: Buffer[] = []
    for (const part of uploadData) {
      if (part.bytes && Buffer.isBuffer(part.bytes) && part.bytes.length > 0) {
        buffers.push(part.bytes)
      }
    }

    if (buffers.length === 0) return undefined

    const combined = Buffer.concat(buffers)
    const uint8 = new Uint8Array(combined.buffer, combined.byteOffset, combined.byteLength)

    const body: chrome.webRequest.WebRequestBody & {
      formData?: Record<string, string[]>
    } = {
      raw: [
        {
          bytes: uint8.buffer as ArrayBuffer,
        },
      ],
    } as any

    try {
      const text = combined.toString('utf8')

      if (text.includes('=') && (text.includes('&') || !text.includes('\n'))) {
        const params = new URLSearchParams(text)
        const formData: Record<string, string[]> = {}
        for (const [key, value] of params.entries()) {
          if (!formData[key]) formData[key] = []
          formData[key].push(value)
        }
        if (Object.keys(formData).length > 0) {
          body.formData = formData
        }
      } else if (text.includes('Content-Disposition: form-data')) {
        // Best-effort multipart/form-data parsing.
        const firstLineEnd = text.indexOf('\r\n')
        const firstLine =
          firstLineEnd !== -1 ? text.slice(0, firstLineEnd) : ''
        const boundaryMatch = firstLine.match(/^-+([^\r\n]+)/)
        const boundary = boundaryMatch && boundaryMatch[1]
        if (boundary) {
          const parts = text.split(`--${boundary}`)
          const formData: Record<string, string[]> = {}
          for (const part of parts) {
            if (!part || part === '--\r\n' || part === '--') continue
            const [rawHeaders, ...rest] = part.split('\r\n\r\n')
            if (!rawHeaders || rest.length === 0) continue
            const nameMatch = rawHeaders.match(/name="([^"]+)"/)
            if (!nameMatch) continue
            const name = nameMatch[1]
            const value = rest.join('\r\n\r\n').replace(/\r\n--\s*$/, '').trim()
            if (!formData[name]) formData[name] = []
            formData[name].push(value)
          }
          if (Object.keys(formData).length > 0) {
            body.formData = formData
          }
        }
      }
    } catch {
      // Keep raw body if parsing fails.
    }

    return body as any
  }

  private findMatchingListeners(list: ListenerEntry[], url: string): ListenerEntry[] {
    return list.filter((entry) => {
      const urls = entry.filter?.urls
      return urls && urls.length > 0 && urls.some((pattern) => matchesPattern(pattern, url))
    })
  }

  private mergeRequestHeaders(
    original: Record<string, string | string[]> | undefined,
    results: Map<string, any>,
  ): { requestHeaders?: Record<string, string | string[]> } {
    const base: Record<string, string | string[]> = { ...(original || {}) }

    for (const r of results.values()) {
      if (r && r.requestHeaders) {
        Object.assign(base, r.requestHeaders as Record<string, string | string[]>)
      }
    }

    return Object.keys(base).length > 0 ? { requestHeaders: base } : {}
  }

  private mergeResponseHeaders(
    original: Record<string, string | string[]> | undefined,
    results: Map<string, any>,
  ): { responseHeaders?: Record<string, string | string[]> } {
    const base: Record<string, string | string[]> = { ...(original || {}) }

    for (const r of results.values()) {
      if (r && r.responseHeaders) {
        Object.assign(base, r.responseHeaders as Record<string, string | string[]>)
      }
    }

    return Object.keys(base).length > 0 ? { responseHeaders: base } : {}
  }

  async notifyOnBeforeRequest(
    details: Electron.OnBeforeRequestListenerDetails,
  ): Promise<WebRequestBlockingResponse> {
    const url = details.url
    if (!url) return {}

    const payloadBase = this.buildDetails(details as unknown as ElectronRequestDetails)
    const matching = this.findMatchingListeners(this.onBeforeRequestListeners, url)

    if (matching.length === 0) return {}

    const hasBlocking = matching.some((e) =>
      Array.isArray(e.extraInfoSpec) && e.extraInfoSpec.includes('blocking'),
    )

    if (!hasBlocking) {
      for (const entry of matching) {
        const filtered = this.filterDetailsForListener(
          payloadBase,
          entry.extraInfoSpec,
        )
        this.ctx.router.sendEvent(
          entry.extensionId,
          'webRequest.onBeforeRequest',
          filtered,
        )
      }
      return {}
    }

    const requestId =
      payloadBase.requestId || `wr-${++this.requestIdCounter}`
    const payloadWithId = { ...payloadBase, requestId }

    return new Promise<WebRequestBlockingResponse>((resolve) => {
      const timeoutHandle = setTimeout(() => {
        this.settlePending(requestId)
      }, BLOCKING_RESPONSE_TIMEOUT_MS)

      this.pendingBlocking.set(requestId, {
        resolve,
        results: new Map(),
        expectedCount: matching.length,
        timeoutHandle,
        merge: (results) => this.mergeCancelOrRedirect(results as Map<string, WebRequestBlockingResponse>),
      })

      for (const entry of matching) {
        const filtered = this.filterDetailsForListener(
          payloadWithId,
          entry.extraInfoSpec,
        )
        this.ctx.router.sendEvent(
          entry.extensionId,
          'webRequest.onBeforeRequest',
          filtered,
        )
      }
    })
  }

  async notifyOnBeforeSendHeaders(
    details: Electron.OnBeforeSendHeadersListenerDetails,
  ): Promise<{ requestHeaders?: Record<string, string | string[]> }> {
    const url = details.url
    if (!url) return {}

    const baseDetails = this.buildDetails(details as unknown as ElectronRequestDetails)
    const payloadBase: WebRequestDetails = {
      ...baseDetails,
      requestHeaders: details.requestHeaders as any,
    }

    const matching = this.findMatchingListeners(this.onBeforeSendHeadersListeners, url)
    if (matching.length === 0) return {}

    const hasBlocking = matching.some((e) => {
      if (!Array.isArray(e.extraInfoSpec)) return false
      return e.extraInfoSpec.includes('blocking') || e.extraInfoSpec.includes('requestHeaders')
    })

    if (!hasBlocking) {
      for (const entry of matching) {
        const filtered = this.filterDetailsForListener(
          payloadBase,
          entry.extraInfoSpec,
        )
        this.ctx.router.sendEvent(
          entry.extensionId,
          'webRequest.onBeforeSendHeaders',
          filtered,
        )
      }
      return {}
    }

    const requestId =
      payloadBase.requestId || `wr-${++this.requestIdCounter}`
    const payloadWithId: WebRequestDetails = { ...payloadBase, requestId }

    return new Promise<{ requestHeaders?: Record<string, string | string[]> }>((resolve) => {
      const timeoutHandle = setTimeout(() => {
        this.settlePending(requestId)
      }, BLOCKING_RESPONSE_TIMEOUT_MS)

      this.pendingBlocking.set(requestId, {
        resolve,
        results: new Map(),
        expectedCount: matching.length,
        timeoutHandle,
        merge: (results) =>
          this.mergeRequestHeaders(details.requestHeaders as any, results),
      })

      for (const entry of matching) {
        const filtered = this.filterDetailsForListener(
          payloadWithId,
          entry.extraInfoSpec,
        )
        this.ctx.router.sendEvent(
          entry.extensionId,
          'webRequest.onBeforeSendHeaders',
          filtered,
        )
      }
    })
  }

  async notifyOnSendHeaders(details: Electron.OnSendHeadersListenerDetails): Promise<void> {
    const url = details.url
    if (!url) return

    const payloadBase: WebRequestDetails = {
      ...this.buildDetails(details as unknown as ElectronRequestDetails),
      requestHeaders: details.requestHeaders as any,
    }

    const matching = this.findMatchingListeners(this.onSendHeadersListeners, url)
    if (matching.length === 0) return

    for (const entry of matching) {
      const filtered = this.filterDetailsForListener(
        payloadBase,
        entry.extraInfoSpec,
      )
      this.ctx.router.sendEvent(
        entry.extensionId,
        'webRequest.onSendHeaders',
        filtered,
      )
    }
  }

  async notifyOnHeadersReceived(
    details: Electron.OnHeadersReceivedListenerDetails,
  ): Promise<{ responseHeaders?: Record<string, string | string[]> }> {
    const url = details.url
    if (!url) return {}

    const baseDetails = this.buildDetails(details as unknown as ElectronRequestDetails)
    const payloadBase: WebRequestDetails = {
      ...baseDetails,
      statusCode: (details as any).statusCode,
      responseHeaders: details.responseHeaders as any,
    }

    const matching = this.findMatchingListeners(this.onHeadersReceivedListeners, url)
    if (matching.length === 0) return {}

    const hasBlocking = matching.some((e) => {
      if (!Array.isArray(e.extraInfoSpec)) return false
      return e.extraInfoSpec.includes('blocking') || e.extraInfoSpec.includes('responseHeaders')
    })

    if (!hasBlocking) {
      for (const entry of matching) {
        const filtered = this.filterDetailsForListener(
          payloadBase,
          entry.extraInfoSpec,
        )
        this.ctx.router.sendEvent(
          entry.extensionId,
          'webRequest.onHeadersReceived',
          filtered,
        )
      }
      return {}
    }

    const requestId =
      payloadBase.requestId || `wr-${++this.requestIdCounter}`
    const payloadWithId: WebRequestDetails = { ...payloadBase, requestId }

    return new Promise<{ responseHeaders?: Record<string, string | string[]> }>((resolve) => {
      const timeoutHandle = setTimeout(() => {
        this.settlePending(requestId)
      }, BLOCKING_RESPONSE_TIMEOUT_MS)

      this.pendingBlocking.set(requestId, {
        resolve,
        results: new Map(),
        expectedCount: matching.length,
        timeoutHandle,
        merge: (results) =>
          this.mergeResponseHeaders(details.responseHeaders as any, results),
      })

      for (const entry of matching) {
        const filtered = this.filterDetailsForListener(
          payloadWithId,
          entry.extraInfoSpec,
        )
        this.ctx.router.sendEvent(
          entry.extensionId,
          'webRequest.onHeadersReceived',
          filtered,
        )
      }
    })
  }

  async notifyOnResponseStarted(
    details: Electron.OnResponseStartedListenerDetails,
  ): Promise<void> {
    const url = details.url
    if (!url) return

    const payloadBase: WebRequestDetails = {
      ...this.buildDetails(details as unknown as ElectronRequestDetails),
      statusCode: (details as any).statusCode,
      responseHeaders: details.responseHeaders as any,
      ip: (details as any).ip,
      fromCache: (details as any).fromCache,
    }

    const matching = this.findMatchingListeners(this.onResponseStartedListeners, url)
    if (matching.length === 0) return

    for (const entry of matching) {
      const filtered = this.filterDetailsForListener(
        payloadBase,
        entry.extraInfoSpec,
      )
      this.ctx.router.sendEvent(
        entry.extensionId,
        'webRequest.onResponseStarted',
        filtered,
      )
    }
  }

  async notifyOnCompleted(details: Electron.OnCompletedListenerDetails): Promise<void> {
    const url = details.url
    if (!url) return

    const payloadBase: WebRequestDetails = {
      ...this.buildDetails(details as unknown as ElectronRequestDetails),
      statusCode: (details as any).statusCode,
      responseHeaders: details.responseHeaders as any,
      ip: (details as any).ip,
      fromCache: (details as any).fromCache,
    }

    const matching = this.findMatchingListeners(this.onCompletedListeners, url)
    if (matching.length === 0) return

    for (const entry of matching) {
      const filtered = this.filterDetailsForListener(
        payloadBase,
        entry.extraInfoSpec,
      )
      this.ctx.router.sendEvent(
        entry.extensionId,
        'webRequest.onCompleted',
        filtered,
      )
    }
  }

  async notifyOnErrorOccurred(
    details: Electron.OnErrorOccurredListenerDetails,
  ): Promise<void> {
    const url = details.url
    if (!url) return

    const payloadBase: WebRequestDetails = {
      ...this.buildDetails(details as unknown as ElectronRequestDetails),
      error: (details as any).error,
    }

    const matching = this.findMatchingListeners(this.onErrorOccurredListeners, url)
    if (matching.length === 0) return

    for (const entry of matching) {
      const filtered = this.filterDetailsForListener(
        payloadBase,
        entry.extraInfoSpec,
      )
      this.ctx.router.sendEvent(
        entry.extensionId,
        'webRequest.onErrorOccurred',
        filtered,
      )
    }
  }
}
