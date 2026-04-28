import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { getAllWindows, matchesPattern, matchesTitlePattern, TabContents } from './common'
import { WindowsAPI } from './windows'
import debug from 'debug'

const d = debug('electron-chrome-extensions:tabs')

const validateExtensionUrl = (url: string, extension: Electron.Extension) => {
  // Convert relative URLs to absolute if needed
  try {
    url = new URL(url, extension.url).href
  } catch (e) {
    throw new Error('Invalid URL')
  }

  // Prevent creating chrome://kill or other debug commands
  if (url.startsWith('chrome:') || url.startsWith('javascript:')) {
    throw new Error('Invalid URL')
  }

  return url
}

export class TabsAPI {
  static TAB_ID_NONE = -1
  static WINDOW_ID_NONE = -1
  static WINDOW_ID_CURRENT = -2
  private tabZoomSettings = new Map<number, chrome.tabs.ZoomSettings>()
  private tabZoomFactors = new Map<number, number>()
  private originZoomFactors = new Map<string, number>()
  private highlightedTabsByWindow = new Map<number, Set<number>>()
  private tabOrderByWindow = new Map<number, number[]>()

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('tabs.get', this.get.bind(this))
    handle('tabs.getAllInWindow', this.getAllInWindow.bind(this))
    handle('tabs.getCurrent', this.getCurrent.bind(this))
    handle('tabs.create', this.create.bind(this))
    handle('tabs.insertCSS', this.insertCSS.bind(this))
    handle('tabs.query', this.query.bind(this))
    handle('tabs.reload', this.reload.bind(this))
    handle('tabs.update', this.update.bind(this))
    handle('tabs.remove', this.remove.bind(this))
    handle('tabs.move', this.move.bind(this))
    handle('tabs.highlight', this.highlight.bind(this))
    handle('tabs.goForward', this.goForward.bind(this))
    handle('tabs.goBack', this.goBack.bind(this))
    handle('tabs.duplicate', this.duplicate.bind(this))
    handle('tabs.getZoom', this.getZoom.bind(this))
    handle('tabs.setZoom', this.setZoom.bind(this))
    handle('tabs.getZoomSettings', this.getZoomSettings.bind(this))
    handle('tabs.setZoomSettings', this.setZoomSettings.bind(this))
    handle('tabs.captureVisibleTab', this.captureVisibleTab.bind(this), { permission: 'tabs' })

    this.ctx.store.on('tab-added', this.observeTab.bind(this))
  }

  private getWindowTabs(win: Electron.BaseWindow | undefined) {
    if (!win || win.isDestroyed()) return []
    const tabs = Array.from(this.ctx.store.tabs).filter((tab) => {
      if (tab.isDestroyed()) return false
      const tabWindow = this.ctx.store.tabToWindow.get(tab)
      return !!tabWindow && !tabWindow.isDestroyed() && tabWindow.id === win.id
    })
    const order = this.tabOrderByWindow.get(win.id)
    if (!order?.length) return tabs
    const orderMap = new Map(order.map((id, idx) => [id, idx]))
    return tabs.sort((a, b) => {
      const ai = orderMap.has(a.id) ? (orderMap.get(a.id) as number) : Number.MAX_SAFE_INTEGER
      const bi = orderMap.has(b.id) ? (orderMap.get(b.id) as number) : Number.MAX_SAFE_INTEGER
      return ai - bi
    })
  }

  private resolveCurrentWindow(event: ExtensionEvent) {
    const mappedWindow = this.ctx.store.getCurrentWindowForExtension(event.extension.id)
    if (mappedWindow && !mappedWindow.isDestroyed()) return mappedWindow

    const senderAny = event.sender as any
    const senderId = typeof senderAny?.id === 'number' ? senderAny.id : undefined
    const senderTab = typeof senderId === 'number' ? this.ctx.store.getTabById(senderId) : undefined
    const senderWindow =
      typeof senderId === 'number'
        ? this.ctx.store.getWindowById(senderId) ||
          (senderTab ? this.ctx.store.tabToWindow.get(senderTab) : undefined) ||
          null
        : null
    if (senderWindow && !senderWindow.isDestroyed()) {
      const parentWindow = senderWindow.getParentWindow?.()
      const resolved =
        parentWindow && !parentWindow.isDestroyed() ? parentWindow : this.ctx.store.getWindowById(senderWindow.id)
      if (resolved && !resolved.isDestroyed()) {
        const active = this.ctx.store.getActiveTabFromWindow(resolved)
        if (active && !active.isDestroyed()) {
          this.ctx.store.setActivationContext(event.extension.id, resolved.id, active.id)
        }
        return resolved
      }
    }

    const fallback = this.ctx.store.getCurrentWindow()
    return fallback && !fallback.isDestroyed() ? fallback : null
  }

  private resolveTabIndex(tab: TabContents, win: Electron.BaseWindow | undefined) {
    if (!win || win.isDestroyed()) return -1

    if (typeof this.ctx.store.impl.getTabIndex === 'function') {
      const index = this.ctx.store.impl.getTabIndex(tab, win)
      if (typeof index === 'number' && index >= 0) return index
    }

    return this.getWindowTabs(win).findIndex((candidate) => candidate.id === tab.id)
  }

  private moveTabOrder(winId: number, tabId: number, toIndex: number) {
    const current = [...(this.tabOrderByWindow.get(winId) || [])]
    const from = current.indexOf(tabId)
    if (from < 0) return
    const [removed] = current.splice(from, 1)
    const clamped = Math.max(0, Math.min(toIndex, current.length))
    current.splice(clamped, 0, removed)
    this.tabOrderByWindow.set(winId, current)
  }

  private refreshWindowTabIndexes(win: Electron.BaseWindow | undefined) {
    if (!win || win.isDestroyed()) return
    const tabs = this.getWindowTabs(win)
    tabs.forEach((windowTab, index) => {
      const cached = this.ctx.store.tabDetailsCache.get(windowTab.id)
      if (cached) {
        cached.index = index
      }
    })
  }

  private observeTab(tab: TabContents) {
    const tabId = tab.id
    const win = this.ctx.store.tabToWindow.get(tab)
    if (win && !win.isDestroyed()) {
      const order = this.tabOrderByWindow.get(win.id) || []
      if (!order.includes(tabId)) {
        order.push(tabId)
        this.tabOrderByWindow.set(win.id, order)
      }
    }

    const updateEvents = [
      'page-title-updated', // title
      'did-start-loading', // status
      'did-stop-loading', // status
      'media-started-playing', // audible
      'media-paused', // audible
      'did-start-navigation', // url
      'did-redirect-navigation', // url
      'did-navigate-in-page', // url

      // Listen for 'tab-updated' to handle all other cases which don't have
      // an official Electron API such as discarded tabs. App developers can
      // emit this event to trigger chrome.tabs.onUpdated if a property has
      // changed.
      'tab-updated',
    ]

    const updateHandler = () => {
      this.applyStoredZoomForTab(tab)
      this.onUpdated(tabId)
    }

    updateEvents.forEach((eventName) => {
      tab.on(eventName as any, updateHandler)
    })

    const faviconHandler = (event: Electron.Event, favicons: string[]) => {
      ;(tab as TabContents).favicon = favicons[0]
      this.onUpdated(tabId)
    }
    tab.on('page-favicon-updated', faviconHandler)

    tab.once('destroyed', () => {
      updateEvents.forEach((eventName) => {
        tab.off(eventName as any, updateHandler)
      })
      tab.off('page-favicon-updated', faviconHandler)

      this.ctx.store.removeTab(tab)
      this.tabZoomSettings.delete(tabId)
      this.tabZoomFactors.delete(tabId)
      this.onRemoved(tabId)
    })

    this.onCreated(tabId)
    this.applyStoredZoomForTab(tab)
    this.onActivated(tabId)

    d(`Observing tab[${tabId}][${tab.getType()}] ${tab.getURL()}`)
  }

  private createTabDetails(tab: TabContents) {
    const tabId = tab.id
    const activeTab = this.ctx.store.getActiveTabFromWebContents(tab)
    let win = this.ctx.store.tabToWindow.get(tab)
    if (win?.isDestroyed()) win = undefined
    const [width = 0, height = 0] = win ? win.getSize() : []

    const details: chrome.tabs.Tab = {
      active: activeTab?.id === tabId,
      audible: tab.isCurrentlyAudible(),
      autoDiscardable: true,
      discarded: false,
      favIconUrl: tab.favicon || undefined,
      frozen: false,
      height,
      highlighted: win ? this.highlightedTabsByWindow.get(win.id)?.has(tabId) ?? false : false,
      id: tabId,
      incognito: false,
      index: this.resolveTabIndex(tab, win),
      groupId: -1, // TODO(mv3): implement?
      mutedInfo: { muted: tab.audioMuted },
      pinned: false,
      selected: true,
      status: tab.isLoading() ? 'loading' : 'complete',
      title: tab.getTitle(),
      url: tab.getURL(), // TODO: tab.mainFrame.url (Electron 12)
      width,
      windowId: win ? win.id : -1,
    }

    if (typeof this.ctx.store.impl.assignTabDetails === 'function') {
      this.ctx.store.impl.assignTabDetails(details, tab)
    }

    this.ctx.store.tabDetailsCache.set(tab.id, details)
    return details
  }

  private getTabDetails(tab: TabContents) {
    if (this.ctx.store.tabDetailsCache.has(tab.id)) {
      return this.ctx.store.tabDetailsCache.get(tab.id)
    }
    const details = this.createTabDetails(tab)
    return details
  }

  private get(event: ExtensionEvent, tabId: number) {
    const tab = this.ctx.store.getTabById(tabId)
    if (!tab) return { id: TabsAPI.TAB_ID_NONE }
    return this.getTabDetails(tab)
  }

  private getAllInWindow(event: ExtensionEvent, windowId: number = TabsAPI.WINDOW_ID_CURRENT) {
    if (windowId === TabsAPI.WINDOW_ID_CURRENT) {
      const currentWin = this.resolveCurrentWindow(event)
      windowId = currentWin?.id ?? this.ctx.store.lastFocusedWindowId!
    }

    const tabs = Array.from(this.ctx.store.tabs).filter((tab) => {
      if (tab.isDestroyed()) return false

      const browserWindow = this.ctx.store.tabToWindow.get(tab)
      if (!browserWindow || browserWindow.isDestroyed()) return

      return browserWindow.id === windowId
    })

    return tabs.map(this.getTabDetails.bind(this))
  }

  private getCurrent(event: ExtensionEvent) {
    const currentWin = this.resolveCurrentWindow(event)
    const tab = currentWin
      ? this.ctx.store.getActiveTabFromWindow(currentWin)
      : this.ctx.store.getActiveTabOfCurrentWindow()
    return tab ? this.getTabDetails(tab) : undefined
  }

  /**
   * Capture the visible area of the active tab as a data URL.
   * Uses Electron's webContents.capturePage(); nothing is written to disk.
   */
  private async captureVisibleTab(
    event: ExtensionEvent,
    windowIdOrOptions?: number | null | { format?: 'png' | 'jpeg'; quality?: number },
    options?: { format?: 'png' | 'jpeg'; quality?: number },
  ): Promise<string | undefined> {
    let windowId: number | null | undefined
    let opts: { format?: 'png' | 'jpeg'; quality?: number } | undefined
    if (typeof windowIdOrOptions === 'number' || windowIdOrOptions === null) {
      windowId = windowIdOrOptions as number | null
      opts = options
    } else if (windowIdOrOptions && typeof windowIdOrOptions === 'object' && !Array.isArray(windowIdOrOptions)) {
      windowId = null
      opts = windowIdOrOptions
    } else {
      windowId = null
      opts = options
    }

    const store = this.ctx.store
    let win: Electron.BaseWindow | null

    if (windowId == null || windowId === TabsAPI.WINDOW_ID_CURRENT) {
      win = this.resolveCurrentWindow(event)
    } else {
      win = store.getWindowById(windowId)
    }

    const webContents = win ? store.getActiveTabFromWindow(win) : undefined
    if (!webContents || webContents.isDestroyed()) {
      return undefined
    }

    const image = await webContents.capturePage()
    if (!image || image.isEmpty()) {
      return undefined
    }

    const format = opts?.format ?? 'png'
    const qualityRaw = opts?.quality ?? 92
    const quality =
      typeof qualityRaw === 'number' && Number.isFinite(qualityRaw)
        ? Math.max(0, Math.min(100, Math.round(qualityRaw)))
        : 92

    if (format === 'jpeg') {
      const buf = image.toJPEG(quality)
      return `data:image/jpeg;base64,${buf.toString('base64')}`
    }
    return image.toDataURL()
  }

  private async create(event: ExtensionEvent, details: chrome.tabs.CreateProperties = {}) {
    const url = details.url ? validateExtensionUrl(details.url, event.extension) : undefined
    const tab = await this.ctx.store.createTab({ ...details, url })
    const tabDetails = this.getTabDetails(tab)
    if (details.active) {
      queueMicrotask(() => this.onActivated(tab.id))
    }
    return tabDetails
  }

  private insertCSS(event: ExtensionEvent, tabId: number, details: chrome.tabs.InjectDetails) {
    const tab = this.ctx.store.getTabById(tabId)
    if (!tab) return

    // TODO: move to webFrame in renderer?
    if (details.code) {
      tab.insertCSS(details.code)
    }
  }

  private query(event: ExtensionEvent, info: chrome.tabs.QueryInfo = {}) {
    const isSet = (value: any) => typeof value !== 'undefined'

    // Resolve the effective "current window" for this extension, preferring
    // its browser-action activation context over the OS-focused window.
    const currentWin = this.resolveCurrentWindow(event)
    const effectiveCurrentWindowId = currentWin?.id ?? this.ctx.store.lastFocusedWindowId

    const filteredTabs = Array.from(this.ctx.store.tabs)
      .map(this.getTabDetails.bind(this) as any)
      .filter((tab) => {
        const t = tab as any
        if (!t) return false
        if (isSet(info.active) && info.active !== t.active) return false
        if (isSet(info.pinned) && info.pinned !== t.pinned) return false
        if (isSet(info.audible) && info.audible !== t.audible) return false
        if (isSet(info.muted) && info.muted !== t.mutedInfo?.muted) return false
        if (isSet(info.highlighted) && info.highlighted !== t.highlighted) return false
        if (isSet(info.discarded) && info.discarded !== t.discarded) return false
        if (isSet(info.autoDiscardable) && info.autoDiscardable !== t.autoDiscardable)
          return false
        if (isSet(info.currentWindow)) {
          const inCurrentWindow = effectiveCurrentWindowId === t.windowId
          if (info.currentWindow !== inCurrentWindow) return false
        }
        if (isSet(info.frozen) && info.frozen !== t.frozen) return false
        if (isSet(info.groupId) && info.groupId !== t.groupId) return false
        if (isSet(info.status) && info.status !== t.status) return false
        if (isSet(info.title) && typeof info.title === 'string' && typeof t.title === 'string') {
          if (!matchesTitlePattern(info.title, t.title)) return false
        }
        if (isSet(info.url) && typeof t.url === 'string') {
          if (typeof info.url === 'string' && !matchesPattern(info.url, t.url!)) {
            return false
          } else if (
            Array.isArray(info.url) &&
            !info.url.some((pattern) => matchesPattern(pattern, t.url!))
          ) {
            return false
          }
        }
        if (isSet(info.windowId)) {
          if (info.windowId === TabsAPI.WINDOW_ID_CURRENT) {
            if (effectiveCurrentWindowId !== t.windowId) return false
          } else if (info.windowId !== t.windowId) {
            return false
          }
        }
        // if (isSet(info.windowType) && info.windowType !== tab.windowType) return false
        if (isSet(info.index) && info.index !== t.index) return false
        return true
      })
    return filteredTabs
  }

  private reload(event: ExtensionEvent, arg1?: unknown, arg2?: unknown) {
    const tabId: number | undefined = typeof arg1 === 'number' ? arg1 : undefined
    const reloadProperties: chrome.tabs.ReloadProperties | null =
      typeof arg1 === 'object' ? arg1 : typeof arg2 === 'object' ? arg2 : {}

    const tab = tabId
      ? this.ctx.store.getTabById(tabId)
      : this.ctx.store.getActiveTabOfCurrentWindow()
    if (!tab) return

    if (reloadProperties?.bypassCache) {
      tab.reloadIgnoringCache()
    } else {
      tab.reload()
    }
  }

  private async update(event: ExtensionEvent, arg1?: unknown, arg2?: unknown) {
    let tabId = typeof arg1 === 'number' ? arg1 : undefined
    const updateProperties: chrome.tabs.UpdateProperties =
      (typeof arg1 === 'object' ? (arg1 as any) : (arg2 as any)) || {}

    const tab = tabId
      ? this.ctx.store.getTabById(tabId)
      : this.ctx.store.getActiveTabOfCurrentWindow()
    if (!tab) return

    tabId = tab.id

    const props = updateProperties

    const url = props.url ? validateExtensionUrl(props.url, event.extension) : undefined
    if (url) await tab.loadURL(url)

    if (typeof props.muted === 'boolean') tab.setAudioMuted(props.muted)

    if (props.active) this.onActivated(tabId)

    this.onUpdated(tabId)

    return this.createTabDetails(tab)
  }

  private remove(event: ExtensionEvent, id: number | number[]) {
    const ids = Array.isArray(id) ? id : [id]

    ids.forEach((tabId) => {
      const tab = this.ctx.store.getTabById(tabId)
      if (tab) this.ctx.store.removeTab(tab)
      this.onRemoved(tabId)
    })
  }

  private async move(
    event: ExtensionEvent,
    tabIds: number | number[],
    moveProperties: chrome.tabs.MoveProperties,
  ) {
    const ids = Array.isArray(tabIds) ? tabIds : [tabIds]
    if (!ids.length) return []
    if (!moveProperties || typeof moveProperties.index !== 'number') {
      throw new Error('tabs.move requires a destination index')
    }
    const rawIndex = moveProperties.index
    // Chrome: index -1 moves tab(s) to the end of the window; only -1 is valid among negatives.
    if (rawIndex < -1) {
      throw new Error('tabs.move index must be >= -1')
    }

    const tabs = ids
      .map((tabId) => this.ctx.store.getTabById(tabId))
      .filter((tab): tab is TabContents => !!tab && !tab.isDestroyed())
    if (!tabs.length) return Array.isArray(tabIds) ? [] : undefined

    const first = tabs[0]
    const sourceWindow = this.ctx.store.tabToWindow.get(first)
    if (!sourceWindow || sourceWindow.isDestroyed()) {
      throw new Error('Unable to resolve source window for tabs.move')
    }

    const destinationWindow =
      typeof moveProperties.windowId === 'number' && moveProperties.windowId > -1
        ? this.ctx.store.getWindowById(moveProperties.windowId)
        : sourceWindow
    if (!destinationWindow || destinationWindow.isDestroyed()) {
      throw new Error('Unable to resolve destination window for tabs.move')
    }
    if (destinationWindow.id !== sourceWindow.id) {
      throw new Error('tabs.move across windows is not currently supported')
    }

    const moved: chrome.tabs.Tab[] = []
    const currentWindowTabs = this.getWindowTabs(sourceWindow)
    const len = currentWindowTabs.length
    const n = tabs.length
    const startIndex =
      rawIndex === -1 ? Math.max(0, len - n) : rawIndex

    for (let i = 0; i < tabs.length; i++) {
      const tab = tabs[i]
      const fromIndex = this.resolveTabIndex(tab, sourceWindow)
      if (fromIndex < 0) continue
      const destinationIndex = Math.max(0, Math.min(startIndex + i, len - 1))

      if (typeof this.ctx.store.impl.moveTab === 'function') {
        const implToIndex = await this.ctx.store.impl.moveTab(tab, sourceWindow, destinationIndex)
        this.moveTabOrder(
          sourceWindow.id,
          tab.id,
          typeof implToIndex === 'number' && implToIndex >= 0 ? implToIndex : destinationIndex,
        )
      } else {
        this.moveTabOrder(sourceWindow.id, tab.id, destinationIndex)
      }

      this.refreshWindowTabIndexes(sourceWindow)
      const details = this.createTabDetails(tab)
      const toIndex = this.resolveTabIndex(tab, sourceWindow)

      this.ctx.router.broadcastEvent('tabs.onMoved', tab.id, {
        windowId: sourceWindow.id,
        fromIndex,
        toIndex,
      } satisfies chrome.tabs.TabMoveInfo)

      moved.push(details)
    }

    return Array.isArray(tabIds) ? moved : moved[0]
  }

  private async highlight(event: ExtensionEvent, highlightInfo: chrome.tabs.HighlightInfo) {
    const targetWindow =
      typeof highlightInfo?.windowId === 'number' && highlightInfo.windowId > -1
        ? this.ctx.store.getWindowById(highlightInfo.windowId)
        : this.resolveCurrentWindow(event)
    if (!targetWindow || targetWindow.isDestroyed()) return

    const windowTabs = this.getWindowTabs(targetWindow)
    const indexes = Array.isArray(highlightInfo.tabs) ? highlightInfo.tabs : [highlightInfo.tabs]
    const selectedTabs = indexes
      .map((idx) => windowTabs[idx])
      .filter((tab): tab is TabContents => !!tab && !tab.isDestroyed())
    if (!selectedTabs.length) return

    const requestedIds = selectedTabs.map((tab) => tab.id)
    const activeTabId = requestedIds[0]
    const actualIds =
      typeof this.ctx.store.impl.highlightTabs === 'function'
        ? (await this.ctx.store.impl.highlightTabs(targetWindow, requestedIds, activeTabId)) || requestedIds
        : requestedIds

    this.highlightedTabsByWindow.set(targetWindow.id, new Set(actualIds))
    this.ctx.store.tabDetailsCache.forEach((tabInfo) => {
      if (tabInfo.windowId === targetWindow.id) {
        tabInfo.highlighted = actualIds.includes(tabInfo.id!)
      }
    })

    if (typeof activeTabId === 'number') {
      this.onActivated(activeTabId)
    }

    this.ctx.router.broadcastEvent('tabs.onHighlighted', {
      windowId: targetWindow.id,
      tabIds: actualIds,
    } satisfies chrome.tabs.TabHighlightInfo)

    return {
      id: targetWindow.id,
      focused: targetWindow.isFocused(),
    } as chrome.windows.Window
  }

  private goForward(event: ExtensionEvent, arg1?: unknown) {
    const tabId = typeof arg1 === 'number' ? arg1 : undefined
    const tab = tabId
      ? this.ctx.store.getTabById(tabId)
      : this.ctx.store.getActiveTabOfCurrentWindow()
    if (!tab) return
    tab.navigationHistory.goForward()
  }

  private goBack(event: ExtensionEvent, arg1?: unknown) {
    const tabId = typeof arg1 === 'number' ? arg1 : undefined
    const tab = tabId
      ? this.ctx.store.getTabById(tabId)
      : this.ctx.store.getActiveTabOfCurrentWindow()
    if (!tab) return
    tab.navigationHistory.goBack()
  }

  private async duplicate(event: ExtensionEvent, tabId: number) {
    const tab = this.ctx.store.getTabById(tabId)
    if (!tab) {
      throw new Error(`No tab with id ${tabId}`)
    }

    const tabDetails = this.getTabDetails(tab)
    const rawUrl = tab.getURL()
    const cachedUrl = tabDetails.url
    const resolvedUrl =
      (typeof rawUrl === 'string' && rawUrl.length > 0 ? rawUrl : undefined) ||
      (typeof cachedUrl === 'string' && cachedUrl.length > 0 ? cachedUrl : undefined)

    let openUrl: string | undefined
    if (resolvedUrl) {
      try {
        openUrl = validateExtensionUrl(resolvedUrl, event.extension)
      } catch {
        openUrl = resolvedUrl
      }
    }

    const duplicateTab = await this.ctx.store.createTab({
      url: openUrl,
      active: true,
      windowId: tabDetails.windowId,
    })
    const details = this.getTabDetails(duplicateTab)
    const urlForResult = (openUrl || resolvedUrl || details.url || '').trim()
    if (urlForResult) {
      details.url = urlForResult
    }
    return details
  }

  private getOriginKey(tab: TabContents): string | undefined {
    const rawUrl = tab.getURL()
    if (!rawUrl || typeof rawUrl !== 'string') return undefined
    try {
      const parsed = new URL(rawUrl)
      if (parsed.origin === 'null') return undefined
      return parsed.origin
    } catch {
      return undefined
    }
  }

  private getTabZoomSettings(tabId: number): chrome.tabs.ZoomSettings {
    const settings = this.tabZoomSettings.get(tabId)
    if (settings) return settings
    return {
      mode: 'automatic',
      scope: 'per-origin',
      defaultZoomFactor: 1,
    }
  }

  private setTabZoomFactor(tab: TabContents, factor: number) {
    tab.setZoomFactor(factor)
    this.tabZoomFactors.set(tab.id, factor)
  }

  private emitZoomChange(
    tab: TabContents,
    oldZoomFactor: number,
    newZoomFactor: number,
    zoomSettings: chrome.tabs.ZoomSettings,
  ) {
    this.ctx.router.broadcastEvent('tabs.onZoomChange', {
      tabId: tab.id,
      oldZoomFactor,
      newZoomFactor,
      zoomSettings,
    } satisfies chrome.tabs.ZoomChangeInfo)
  }

  private applyStoredZoomForTab(tab: TabContents) {
    if (!tab || tab.isDestroyed()) return
    const settings = this.getTabZoomSettings(tab.id)
    if (settings.mode === 'disabled') return

    let nextZoom: number | undefined
    if (settings.scope === 'per-tab') {
      nextZoom = this.tabZoomFactors.get(tab.id)
    } else {
      const origin = this.getOriginKey(tab)
      if (origin) nextZoom = this.originZoomFactors.get(origin)
    }

    if (typeof nextZoom === 'number' && Number.isFinite(nextZoom) && nextZoom > 0) {
      const current = tab.getZoomFactor()
      if (Math.abs(current - nextZoom) >= 0.0001) {
        this.setTabZoomFactor(tab, nextZoom)
      }
    }
  }

  private getZoom(event: ExtensionEvent, tabId?: number) {
    const tab = typeof tabId === 'number' ? this.ctx.store.getTabById(tabId) : this.ctx.store.getActiveTabOfCurrentWindow()
    if (!tab) return 1
    const factor = tab.getZoomFactor()
    return typeof factor === 'number' && Number.isFinite(factor) ? factor : 1
  }

  private setZoom(event: ExtensionEvent, tabIdOrFactor?: number, maybeFactor?: number) {
    const hasTabId = typeof maybeFactor === 'number'
    const tabId = hasTabId ? (tabIdOrFactor as number) : undefined
    let factor = (hasTabId ? maybeFactor : tabIdOrFactor) as number
    const tab = typeof tabId === 'number' ? this.ctx.store.getTabById(tabId) : this.ctx.store.getActiveTabOfCurrentWindow()
    if (!tab) {
      throw new Error('No active tab available to set zoom')
    }
    const settings = this.getTabZoomSettings(tab.id)
    if (settings.mode === 'disabled') {
      throw new Error('tabs.setZoom is not available when zoom mode is disabled')
    }
    if (typeof factor !== 'number' || !Number.isFinite(factor) || factor < 0) {
      throw new Error('tabs.setZoom requires a non-negative numeric zoom factor')
    }
    if (factor === 0) {
      factor = settings.defaultZoomFactor ?? 1
    }
    if (!Number.isFinite(factor) || factor <= 0) {
      throw new Error('tabs.setZoom requires a positive zoom factor')
    }

    const oldZoomFactor = tab.getZoomFactor()
    if (settings.scope === 'per-tab') {
      this.setTabZoomFactor(tab, factor)
    } else {
      const origin = this.getOriginKey(tab)
      if (origin) {
        this.originZoomFactors.set(origin, factor)
        const sameOriginTabs = Array.from(this.ctx.store.tabs).filter((candidate) => {
          if (candidate.isDestroyed()) return false
          return this.getOriginKey(candidate) === origin
        })
        sameOriginTabs.forEach((candidate) => this.setTabZoomFactor(candidate, factor))
      } else {
        this.setTabZoomFactor(tab, factor)
      }
    }
    this.emitZoomChange(tab, oldZoomFactor, factor, settings)
  }

  private getZoomSettings(event: ExtensionEvent, tabId?: number): chrome.tabs.ZoomSettings {
    const tab = typeof tabId === 'number' ? this.ctx.store.getTabById(tabId) : this.ctx.store.getActiveTabOfCurrentWindow()
    if (!tab) {
      return {
        mode: 'automatic',
        scope: 'per-origin',
        defaultZoomFactor: 1,
      }
    }
    const current = this.getTabZoomSettings(tab.id)
    const defaultZoomFactor =
      typeof current.defaultZoomFactor === 'number' && current.defaultZoomFactor > 0
        ? current.defaultZoomFactor
        : 1
    return { ...current, defaultZoomFactor }
  }

  private setZoomSettings(
    event: ExtensionEvent,
    tabIdOrSettings?: number | chrome.tabs.ZoomSettings,
    maybeSettings?: chrome.tabs.ZoomSettings,
  ) {
    const tabId = typeof tabIdOrSettings === 'number' ? tabIdOrSettings : undefined
    const settings =
      typeof tabIdOrSettings === 'number' ? maybeSettings : (tabIdOrSettings as chrome.tabs.ZoomSettings)
    if (!settings) return
    const tab =
      typeof tabId === 'number' ? this.ctx.store.getTabById(tabId) : this.ctx.store.getActiveTabOfCurrentWindow()
    if (!tab) return

    if (settings.mode && !['automatic', 'manual', 'disabled'].includes(settings.mode)) {
      throw new Error(`tabs.setZoomSettings mode "${settings.mode}" is not supported`)
    }
    if (settings.scope && !['per-origin', 'per-tab'].includes(settings.scope)) {
      throw new Error(`tabs.setZoomSettings scope "${settings.scope}" is not supported`)
    }
    if (
      typeof settings.defaultZoomFactor !== 'undefined' &&
      (!Number.isFinite(settings.defaultZoomFactor) || settings.defaultZoomFactor <= 0)
    ) {
      throw new Error('tabs.setZoomSettings defaultZoomFactor must be a positive number')
    }

    const prev = this.getTabZoomSettings(tab.id)
    const next: chrome.tabs.ZoomSettings = {
      mode: settings.mode ?? prev.mode ?? 'automatic',
      scope: settings.scope ?? prev.scope ?? 'per-origin',
      defaultZoomFactor: settings.defaultZoomFactor ?? prev.defaultZoomFactor ?? 1,
    }
    this.tabZoomSettings.set(tab.id, next)
    this.applyStoredZoomForTab(tab)
  }

  onCreated(tabId: number) {
    const tab = this.ctx.store.getTabById(tabId)
    if (!tab) return
    this.refreshWindowTabIndexes(this.ctx.store.tabToWindow.get(tab))
    const tabDetails = this.getTabDetails(tab)
    this.ctx.router.broadcastEvent('tabs.onCreated', tabDetails)
  }

  onUpdated(tabId: number) {
    const tab = this.ctx.store.getTabById(tabId)
    if (!tab) return

    let prevDetails
    if (this.ctx.store.tabDetailsCache.has(tab.id)) {
      prevDetails = this.ctx.store.tabDetailsCache.get(tab.id)
    }
    if (!prevDetails) return

    const details = this.createTabDetails(tab)

    const compareProps: (keyof chrome.tabs.Tab)[] = [
      'audible',
      'autoDiscardable',
      'discarded',
      'favIconUrl',
      'frozen',
      'groupId',
      'pinned',
      'status',
      'title',
      'url',
    ]

    let didUpdate = false
    const changeInfo: chrome.tabs.TabChangeInfo = {}

    for (const prop of compareProps) {
      if (details[prop] !== prevDetails[prop]) {
        ;(changeInfo as any)[prop] = details[prop]
        didUpdate = true
      }
    }

    if (details.mutedInfo?.muted !== prevDetails.mutedInfo?.muted) {
      changeInfo.mutedInfo = details.mutedInfo
      didUpdate = true
    }

    if (!didUpdate) return

    this.ctx.router.broadcastEvent('tabs.onUpdated', tab.id, changeInfo, details)
  }

  onRemoved(tabId: number) {
    const details = this.ctx.store.tabDetailsCache.has(tabId)
      ? this.ctx.store.tabDetailsCache.get(tabId)
      : null
    this.ctx.store.tabDetailsCache.delete(tabId)

    const windowId = details ? details.windowId : WindowsAPI.WINDOW_ID_NONE
    const win =
      typeof windowId !== 'undefined' && windowId > -1
        ? getAllWindows().find((win) => win.id === windowId)
        : null

    this.ctx.router.broadcastEvent('tabs.onRemoved', tabId, {
      windowId,
      isWindowClosing: win ? win.isDestroyed() : false,
    })

    if (typeof windowId === 'number' && windowId > -1) {
      const order = this.tabOrderByWindow.get(windowId)
      if (order) {
        this.tabOrderByWindow.set(
          windowId,
          order.filter((id) => id !== tabId),
        )
      }
      const highlighted = this.highlightedTabsByWindow.get(windowId)
      if (highlighted) {
        highlighted.delete(tabId)
        if (highlighted.size === 0) this.highlightedTabsByWindow.delete(windowId)
      }
    }

    this.refreshWindowTabIndexes(win || undefined)
  }

  onActivated(tabId: number) {
    const tab = this.ctx.store.getTabById(tabId)
    if (!tab) return

    const activeTab = this.ctx.store.getActiveTabFromWebContents(tab)
    const activeChanged = activeTab?.id !== tabId
    if (!activeChanged) return

    const win = this.ctx.store.tabToWindow.get(tab)

    this.ctx.store.setActiveTab(tab)

    if (win && !win.isDestroyed()) {
      this.highlightedTabsByWindow.set(win.id, new Set([tabId]))
    }

    // invalidate cache since 'active' has changed
    this.ctx.store.tabDetailsCache.forEach((tabInfo, cacheTabId) => {
      tabInfo.active = tabId === cacheTabId
      if (win && !win.isDestroyed() && tabInfo.windowId === win.id) {
        tabInfo.highlighted = tabId === cacheTabId
      }
    })

    this.ctx.router.broadcastEvent('tabs.onActivated', {
      tabId,
      windowId: win?.id,
    })
  }
}
