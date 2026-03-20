import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'

type ProxySettingDetails = {
  value: chrome.proxy.ProxyConfig
  levelOfControl: chrome.types.LevelOfControl
  incognitoSpecific: boolean
}

const PAC_DATA_MIME_TYPE = 'application/x-ns-proxy-autoconfig'

export class ProxyAPI {
  private currentConfig: chrome.proxy.ProxyConfig = { mode: 'system' }
  private controllingExtensionId?: string

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('proxy.settings.get', this.settingsGet, {
      extensionContext: true,
      permission: 'proxy',
    })
    handle('proxy.settings.set', this.settingsSet, {
      extensionContext: true,
      permission: 'proxy',
    })
    handle('proxy.settings.clear', this.settingsClear, {
      extensionContext: true,
      permission: 'proxy',
    })
  }

  private settingsGet = async (
    { extension }: ExtensionEvent,
    _details?: chrome.types.ChromeSettingGetDetails,
  ): Promise<ProxySettingDetails> => {
    const levelOfControl: chrome.types.LevelOfControl =
      !this.controllingExtensionId
        ? 'controllable_by_this_extension'
        : this.controllingExtensionId === extension.id
          ? 'controlled_by_this_extension'
          : 'controlled_by_other_extensions'

    return {
      value: this.currentConfig,
      levelOfControl,
      incognitoSpecific: false,
    }
  }

  private settingsSet = async (
    { extension }: ExtensionEvent,
    details: chrome.types.ChromeSettingSetDetails<chrome.proxy.ProxyConfig>,
  ): Promise<void> => {
    const config = (details?.value || { mode: 'system' }) as chrome.proxy.ProxyConfig
    await this.applyProxyConfig(config)
    this.currentConfig = config
    this.controllingExtensionId = extension.id
    this.emitSettingsChange(extension.id)
  }

  private settingsClear = async (): Promise<void> => {
    await this.ctx.session.setProxy({ mode: 'system' })
    this.currentConfig = { mode: 'system' }
    this.controllingExtensionId = undefined
    this.emitSettingsChange()
  }

  private async applyProxyConfig(config: chrome.proxy.ProxyConfig): Promise<void> {
    const mode = config?.mode || 'system'

    if (mode === 'direct') {
      await this.ctx.session.setProxy({ mode: 'direct' })
      return
    }

    if (mode === 'system') {
      await this.ctx.session.setProxy({ mode: 'system' })
      return
    }

    if (mode === 'pac_script') {
      const pacScript = this.resolvePacScript(config.pacScript)
      await this.ctx.session.setProxy({
        mode: 'pac_script',
        pacScript,
      })
      return
    }

    if (mode === 'fixed_servers') {
      const proxyRules = this.resolveProxyRules(config.rules)
      await this.ctx.session.setProxy({
        mode: 'fixed_servers',
        proxyRules,
        proxyBypassRules: this.resolveBypassRules(config.rules),
      })
      return
    }

    await this.ctx.session.setProxy({ mode: mode as Electron.ProxyConfig['mode'] })
  }

  private resolvePacScript(
    pacScript?: chrome.proxy.PacScript,
  ): string | undefined {
    if (!pacScript) return undefined
    if (pacScript.url) return pacScript.url
    if (!pacScript.data) return undefined

    const base64Data = Buffer.from(pacScript.data, 'utf8').toString('base64')
    return `data:${PAC_DATA_MIME_TYPE};base64,${base64Data}`
  }

  private resolveProxyRules(rules?: chrome.proxy.ProxyRules): string | undefined {
    if (!rules) return undefined

    const singleProxyRule = this.formatSingleProxy(rules.singleProxy)
    if (singleProxyRule) return singleProxyRule

    const segments: string[] = []

    const httpRule = this.formatSchemeProxy(rules.proxyForHttp)
    if (httpRule) segments.push(`http=${httpRule}`)

    const httpsRule = this.formatSchemeProxy(rules.proxyForHttps)
    if (httpsRule) segments.push(`https=${httpsRule}`)

    const ftpRule = this.formatSchemeProxy(rules.proxyForFtp)
    if (ftpRule) segments.push(`ftp=${ftpRule}`)

    const fallbackServer = rules.fallbackProxy
    const fallbackRule = this.formatSchemeProxy(fallbackServer)
    if (fallbackRule) {
      if (fallbackServer?.scheme === 'socks4' || fallbackServer?.scheme === 'socks5') {
        segments.push(`socks=${fallbackRule}`)
      } else {
        segments.push(fallbackRule)
      }
    }

    if (segments.length === 0) return undefined
    return segments.join(';')
  }

  private resolveBypassRules(rules?: chrome.proxy.ProxyRules): string | undefined {
    const bypassList = rules?.bypassList
    if (!bypassList || bypassList.length === 0) return undefined
    return bypassList.join(',')
  }

  private formatHostPort(server?: chrome.proxy.ProxyServer): string | undefined {
    if (!server?.host) return undefined

    const isIpv6 = server.host.includes(':') && !server.host.startsWith('[')
    const host = isIpv6 ? `[${server.host}]` : server.host
    const port = typeof server.port === 'number' ? `:${server.port}` : ''
    return `${host}${port}`
  }

  private formatSingleProxy(server?: chrome.proxy.ProxyServer): string | undefined {
    const hostPort = this.formatHostPort(server)
    if (!hostPort) return undefined

    if (server?.scheme === 'socks4' || server?.scheme === 'socks5') {
      return `${server.scheme}://${hostPort}`
    }

    return hostPort
  }

  private formatSchemeProxy(server?: chrome.proxy.ProxyServer): string | undefined {
    const hostPort = this.formatHostPort(server)
    if (!hostPort) return undefined

    if (server?.scheme === 'socks4' || server?.scheme === 'socks5') {
      return `${server.scheme}://${hostPort}`
    }

    return hostPort
  }

  private emitSettingsChange(targetExtensionId?: string): void {
    const levelOfControl: chrome.types.LevelOfControl =
      targetExtensionId && this.controllingExtensionId === targetExtensionId
        ? 'controlled_by_this_extension'
        : 'controllable_by_this_extension'

    this.ctx.router.sendEvent(targetExtensionId, 'proxy.settings.onChange', {
      value: this.currentConfig,
      levelOfControl,
      incognitoSpecific: false,
    })
  }
}