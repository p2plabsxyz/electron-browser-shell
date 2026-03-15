import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { matchesPattern } from './common'

/** Stored entry for one onBeforeRequest listener. */
interface ListenerEntry {
  extensionId: string
  filter: { urls: string[] }
  extraInfoSpec?: string[]
}

/** Details object we send to extension (Chrome webRequest.OnBeforeRequestDetails-like). */
export interface WebRequestDetails {
  url: string
  method: string
  tabId: number
  requestId?: string
  frameId?: number
  parentFrameId?: number
  type?: string
  timeStamp?: number
}

export class WebRequestAPI {
  private onBeforeRequestListeners: ListenerEntry[] = []

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('webRequest.addOnBeforeRequestListener', this.addOnBeforeRequestListener, {
      permission: 'webRequest',
    })

    const sessionExtensions = this.ctx.session.extensions || this.ctx.session
    sessionExtensions.on('extension-unloaded', (_event, extension) => {
      this.onBeforeRequestListeners = this.onBeforeRequestListeners.filter(
        (e) => e.extensionId !== extension.id,
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

  
  // Called by the app when a request is about to be made. Match filters and dispatch to extension listeners.
   
  notifyOnBeforeRequest(details: Electron.OnBeforeRequestListenerDetails): void {
    const url = details.url
    if (!url) return

    const payload: WebRequestDetails = {
      url: details.url,
      method: details.method || 'GET',
      tabId: -1,
    }

    for (const entry of this.onBeforeRequestListeners) {
      const matches =
        entry.filter.urls.length > 0 &&
        entry.filter.urls.some((pattern) => matchesPattern(pattern, url))
      if (matches) {
        this.ctx.router.sendEvent(entry.extensionId, 'webRequest.onBeforeRequest', payload)
      }
    }
  }
}
