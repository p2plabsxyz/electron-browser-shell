import { BrowserWindow } from 'electron'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'

const redirectDomain = 'chromiumapp.org'

/** Chromium: https://<id>.chromiumapp.org/ is resolved internally (no real DNS). Electron resolves normally → ERR_NAME_NOT_RESOLVED (-105). */
const ERR_NAME_NOT_RESOLVED = -105

/** Chrome extension OAuth redirect URL prefix: https://<extensionId>.chromiumapp.org/ */
function getRedirectUrlPrefix(extensionId: string): string {
  return `https://${extensionId}.${redirectDomain}/`
}

/** Allow https everywhere; allow http only on loopback (common OAuth dev / local test servers). */
function isAllowedLaunchWebAuthFlowUrl(u: URL): boolean {
  if (u.protocol === 'https:') return true
  if (u.protocol === 'http:') {
    const h = u.hostname.toLowerCase()
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1'
  }
  return false
}

export class IdentityAPI {
  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()

    handle('identity.launchWebAuthFlow', this.launchWebAuthFlow, {
      extensionContext: true,
      permission: 'identity',
    })
    handle('identity.getAuthToken', this.getAuthToken, {
      extensionContext: true,
      permission: 'identity',
    })
  }

  private launchWebAuthFlow = async (
    { extension }: ExtensionEvent,
    options: { url: string; interactive?: boolean },
  ): Promise<string> => {
    const { url } = options ?? {}
    if (!url || typeof url !== 'string') {
      throw new Error('chrome.identity.launchWebAuthFlow: options.url is required')
    }
    let parsedUrl: URL
    try {
      parsedUrl = new URL(url)
    } catch {
      throw new Error('chrome.identity.launchWebAuthFlow: options.url must be a valid URL')
    }
    if (!isAllowedLaunchWebAuthFlowUrl(parsedUrl)) {
      throw new Error(
        'chrome.identity.launchWebAuthFlow: options.url must be https, or http on localhost/127.0.0.1 only',
      )
    }

    const extensionId = extension.id
    const redirectPrefix = getRedirectUrlPrefix(extensionId)

    return new Promise<string>((resolve, reject) => {
      const shouldShow = options?.interactive !== false
      const win = new BrowserWindow({
        width: 500,
        height: 600,
        show: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          session: this.ctx.session,
        },
      })

      const cleanup = () => {
        if (win && !win.isDestroyed()) {
          win.removeListener('closed', onClosed)
          const wc = win.webContents
          if (wc && !wc.isDestroyed()) {
            wc.removeListener('will-redirect', onRedirect)
            wc.removeListener('will-navigate', onWillNavigate)
            wc.removeListener('did-navigate', onNavigate)
            wc.removeListener('did-fail-load', onDidFailLoad)
          }
          win.destroy()
        }
      }

      const callbackHost = `${extensionId}.${redirectDomain}`

      const checkRedirect = (targetUrl: string): boolean => {
        if (!targetUrl || typeof targetUrl !== 'string') return false
        if (targetUrl.startsWith(redirectPrefix)) return true
        try {
          return new URL(targetUrl).hostname === callbackHost
        } catch {
          return false
        }
      }

      const captureAndResolve = (callbackUrl: string) => {
        cleanup()
        resolve(callbackUrl)
      }

      const onRedirect = (
        _event: Electron.Event,
        urlRedirect: string,
        _isInPlace: boolean,
        _isMainFrame: boolean,
      ) => {
        if (checkRedirect(urlRedirect)) captureAndResolve(urlRedirect)
      }

      /** Intercept client-side redirects before loading the chromiumapp.org URL. */
      const onWillNavigate = (event: Electron.Event, navUrl: string) => {
        if (checkRedirect(navUrl)) {
          event.preventDefault()
          captureAndResolve(navUrl)
        }
      }

      const onNavigate = (_event: Electron.Event, navUrl: string) => {
        if (checkRedirect(navUrl)) captureAndResolve(navUrl)
      }

      /** When the redirect target is *.chromiumapp.org, DNS fails before will-redirect in some cases; validated URL is still the OAuth callback. */
      const onDidFailLoad = (
        _event: Electron.Event,
        errorCode: number,
        _errorDescription: string,
        validatedURL: string,
        isMainFrame: boolean,
      ) => {
        if (!isMainFrame) return
        if (errorCode !== ERR_NAME_NOT_RESOLVED) return
        if (checkRedirect(validatedURL)) captureAndResolve(validatedURL)
      }

      const onClosed = () => {
        cleanup()
        reject(new Error('User closed the OAuth window'))
      }

      win.webContents.on('will-redirect', onRedirect)
      win.webContents.on('will-navigate', onWillNavigate)
      win.webContents.on('did-navigate', onNavigate)
      win.webContents.on('did-fail-load', onDidFailLoad)
      win.on('closed', onClosed)

      if (shouldShow) {
        win.webContents.once('did-finish-load', () => {
          if (!win.isDestroyed()) {
            win.show()
            win.focus()
          }
        })
      }

      win.loadURL(parsedUrl.toString()).catch((err) => {
        cleanup()
        reject(new Error(`Failed to load OAuth URL: ${err.message}`))
      })
    })
  }

  private getAuthToken = async (
    _event: ExtensionEvent,
    _options?: { interactive?: boolean },
  ): Promise<never> => {
    throw new Error(
      'chrome.identity.getAuthToken is not supported in Peersky. Use chrome.identity.launchWebAuthFlow for OAuth flows.',
    )
  }
}
