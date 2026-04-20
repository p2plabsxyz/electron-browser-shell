import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'

enum CookieStoreID {
  Default = '0',
  Incognito = '1',
}

const onChangedCauseTranslation: { [key: string]: string } = {
  'expired-overwrite': 'expired_overwrite',
}

const createCookieDetails = (cookie: Electron.Cookie): chrome.cookies.Cookie => ({
  ...cookie,
  domain: cookie.domain || '',
  hostOnly: Boolean(cookie.hostOnly),
  session: Boolean(cookie.session),
  path: cookie.path || '',
  httpOnly: Boolean(cookie.httpOnly),
  secure: Boolean(cookie.secure),
  storeId: CookieStoreID.Default,
})

const isSupportedStore = (storeId?: string) =>
  storeId == null || storeId === CookieStoreID.Default

const selectBestCookieMatch = (cookies: Electron.Cookie[]): Electron.Cookie | null => {
  if (cookies.length === 0) return null
  const ranked = cookies
    .map((cookie, index) => ({ cookie, index }))
    .sort((a, b) => {
      const aPathLength = (a.cookie.path || '').length
      const bPathLength = (b.cookie.path || '').length
      if (aPathLength !== bPathLength) return bPathLength - aPathLength

      const aCreation = Number((a.cookie as any).creation ?? 0)
      const bCreation = Number((b.cookie as any).creation ?? 0)
      if (!Number.isNaN(aCreation) && !Number.isNaN(bCreation) && aCreation !== bCreation) {
        return aCreation - bCreation
      }

      return a.index - b.index
    })
  return ranked[0].cookie
}

export class CookiesAPI {
  private get cookies() {
    return this.ctx.session.cookies
  }

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('cookies.get', this.get.bind(this))
    handle('cookies.getAll', this.getAll.bind(this))
    handle('cookies.set', this.set.bind(this))
    handle('cookies.remove', this.remove.bind(this))
    handle('cookies.getAllCookieStores', this.getAllCookieStores.bind(this))

    this.cookies.addListener('changed', this.onChanged)
  }

  private async get(
    event: ExtensionEvent,
    details: chrome.cookies.CookieDetails,
  ): Promise<chrome.cookies.Cookie | null> {
    if (!isSupportedStore(details.storeId)) return null

    const cookies = await this.cookies.get({
      url: details.url,
      name: details.name,
    })

    const best = selectBestCookieMatch(cookies)
    return best ? createCookieDetails(best) : null
  }

  private async getAll(
    event: ExtensionEvent,
    details: chrome.cookies.GetAllDetails,
  ): Promise<chrome.cookies.Cookie[]> {
    if (!isSupportedStore(details.storeId)) return []

    const cookies = await this.cookies.get({
      url: details.url,
      name: details.name,
      domain: details.domain,
      path: details.path,
      secure: details.secure,
      session: details.session,
    })

    return cookies.map(createCookieDetails)
  }

  private async set(
    event: ExtensionEvent,
    details: chrome.cookies.SetDetails,
  ): Promise<chrome.cookies.Cookie | null> {
    if (!isSupportedStore(details.storeId)) return null

    await this.cookies.set(details)
    const cookies = await this.cookies.get(details)
    const best = selectBestCookieMatch(cookies)
    return best ? createCookieDetails(best) : null
  }

  private async remove(
    event: ExtensionEvent,
    details: chrome.cookies.CookieDetails,
  ): Promise<chrome.cookies.CookieDetails | null> {
    if (!isSupportedStore(details.storeId)) return null

    try {
      await this.cookies.remove(details.url, details.name)
    } catch {
      return null
    }
    return {
      url: details.url,
      name: details.name,
      storeId: CookieStoreID.Default,
    }
  }

  private async getAllCookieStores(event: ExtensionEvent): Promise<chrome.cookies.CookieStore[]> {
    const tabIds = Array.from(this.ctx.store.tabs)
      .map((tab) => (tab.isDestroyed() ? undefined : tab.id))
      .filter(Boolean) as number[]
    return [{ id: CookieStoreID.Default, tabIds }]
  }

  private onChanged = (
    event: Electron.Event,
    cookie: Electron.Cookie,
    cause: string,
    removed: boolean,
  ) => {
    const changeInfo: chrome.cookies.CookieChangeInfo = {
      cause: onChangedCauseTranslation[cause] || cause,
      cookie: createCookieDetails(cookie),
      removed,
    }

    this.ctx.router.broadcastEvent('cookies.onChanged', changeInfo)
  }
}
