import { promises as fs } from 'node:fs'
import path from 'node:path'

import { parseFilter, matchesFilter, elementTypes } from 'abp-filter-parser'
import { getDomain } from 'tldts'

import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import type { WebRequestBlockingResponse, WebRequestDetails } from './web-request'

type DNRRule = chrome.declarativeNetRequest.Rule
type RuleCondition = chrome.declarativeNetRequest.RuleCondition

interface InternalRule {
  extensionId: string
  id: number
  priority: number
  action: chrome.declarativeNetRequest.RuleAction
  hostKey: string | null
  parsedUrlFilter: Record<string, unknown> | null
  regex: RegExp | null
  condition: RuleCondition
}

interface ExtensionDNRState {
  staticByRuleset: Map<string, InternalRule[]>
  enabledRulesets: Set<string>
  dynamicRules: Map<number, InternalRule>
  sessionRules: Map<number, InternalRule>
}

function getSessionExtensions(session: Electron.Session) {
  return session.extensions || session
}

function resourceTypeToElementMask(resourceType: string | undefined): number {
  switch (resourceType) {
    case 'main_frame':
      return elementTypes.DOCUMENT
    case 'sub_frame':
      return elementTypes.SUBDOCUMENT
    case 'script':
      return elementTypes.SCRIPT
    case 'image':
    case 'img':
      return elementTypes.IMAGE
    case 'stylesheet':
      return elementTypes.STYLESHEET
    case 'xmlhttprequest':
    case 'xhr':
      return elementTypes.XMLHTTPREQUEST
    case 'object':
      return elementTypes.OBJECT
    default:
      return elementTypes.OTHER
  }
}

function dnrResourceTypeMatches(
  conditionTypes: chrome.declarativeNetRequest.ResourceType[] | undefined,
  normalizedType: string | undefined,
): boolean {
  if (!conditionTypes || conditionTypes.length === 0) return true
  const t = normalizedType || 'other'
  const mapped = t === 'img' ? 'image' : t
  return conditionTypes.some((ct) => ct === mapped || (ct === 'image' && t === 'img'))
}

function hostMatchesDomainList(
  host: string,
  domains: string[] | undefined,
  excluded: string[] | undefined,
): boolean {
  const h = host.toLowerCase()
  if (excluded?.length) {
    for (const d of excluded) {
      const x = d.toLowerCase()
      if (h === x || h.endsWith(`.${x}`)) return false
    }
  }
  if (!domains || domains.length === 0) return true
  return domains.some((d) => {
    const x = d.toLowerCase()
    return h === x || h.endsWith(`.${x}`)
  })
}

function safeHostname(urlStr: string): string {
  try {
    return new URL(urlStr).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * Same registrable domain (eTLD+1 / schemeful site) using the bundled public suffix list.
 * Matches browser behavior for sibling subdomains (e.g. static.* vs www.* on grammarly.com).
 */
function sameRegistrableDomain(hostnameA: string, hostnameB: string): boolean {
  if (!hostnameA || !hostnameB) return false
  if (hostnameA === hostnameB) return true
  const da = getDomain(hostnameA)
  const db = getDomain(hostnameB)
  return da != null && db != null && da === db
}

/**
 * Electron often lacks Referer; without a reliable initiator, Ghostery-style rules can
 * block same-site scripts/XHR. Chrome applies DNR in a document-aware pipeline; we
 * approximate by not cancelling "block" for same-site subresources (non top-level doc).
 */
function shouldSkipNetworkBlockAsSameSite(
  requestUrl: string,
  initiatorUrl: string | undefined,
  resourceType: string | undefined,
): boolean {
  if (resourceType === 'main_frame') return false
  if (!initiatorUrl) return false
  const rh = safeHostname(requestUrl)
  const ih = safeHostname(initiatorUrl)
  if (!rh || !ih) return false
  return sameRegistrableDomain(rh, ih)
}

function normalizeResourceTypeForDnr(type: string | undefined): string {
  const t = type || 'other'
  if (t === 'img') return 'image'
  if (t === 'fetch') return 'xmlhttprequest'
  return t
}

function conditionMatchesRequest(
  condition: RuleCondition,
  details: {
    url: string
    method: string
    tabId: number
    type: string
    initiator?: string
  },
  elementTypeMask: number,
  parsedUrlFilter: Record<string, unknown> | null,
  regex: RegExp | null,
): boolean {
  if (!dnrResourceTypeMatches(condition.resourceTypes, details.type)) return false

  if (condition.requestMethods?.length) {
    const m = (details.method || 'GET').toLowerCase()
    if (!condition.requestMethods.some((rm) => String(rm).toLowerCase() === m)) return false
  }

  if (condition.tabIds?.length) {
    if (!condition.tabIds.includes(details.tabId)) return false
  }

  const reqHost = safeHostname(details.url)

  const reqDomains = (condition as RuleCondition & { requestDomains?: string[] }).requestDomains
  const exReqDomains = (condition as RuleCondition & { excludedRequestDomains?: string[] })
    .excludedRequestDomains
  if (reqDomains?.length || exReqDomains?.length) {
    if (!hostMatchesDomainList(reqHost, reqDomains, exReqDomains)) return false
  }

  const legacyDomain = (condition as RuleCondition & { domain?: string }).domain
  const legacyEx = (condition as RuleCondition & { excludedDomains?: string[] }).excludedDomains
  if (legacyDomain || legacyEx?.length) {
    const doms = legacyDomain ? [legacyDomain] : undefined
    if (!hostMatchesDomainList(reqHost, doms, legacyEx)) return false
  }

  const initDomains = (condition as RuleCondition & { initiatorDomains?: string[] }).initiatorDomains
  const exInitDomains = (condition as RuleCondition & { excludedInitiatorDomains?: string[] })
    .excludedInitiatorDomains
  if (initDomains?.length || exInitDomains?.length) {
    const ih = details.initiator ? safeHostname(details.initiator) : ''
    if (!ih || !hostMatchesDomainList(ih, initDomains, exInitDomains)) return false
  }

  if (regex) {
    if (!regex.test(details.url)) return false
  } else if (parsedUrlFilter) {
    if (!matchesFilter(parsedUrlFilter, details.url, { elementTypeMask })) return false
  }

  return true
}

function compileRule(extensionId: string, rule: DNRRule): InternalRule | null {
  const priority = rule.priority ?? 1
  const c = rule.condition
  let parsedUrlFilter: Record<string, unknown> | null = null
  let regex: RegExp | null = null
  let hostKey: string | null = null

  if (c.regexFilter) {
    try {
      regex = new RegExp(c.regexFilter)
    } catch {
      return null
    }
  } else if (c.urlFilter) {
    const parsed: Record<string, unknown> = {}
    if (!parseFilter(c.urlFilter, parsed)) return null
    parsedUrlFilter = parsed
    if (parsed.hostAnchored && typeof parsed.host === 'string') {
      hostKey = parsed.host as string
    }
  }

  return {
    extensionId,
    id: rule.id,
    priority,
    action: rule.action,
    hostKey,
    parsedUrlFilter,
    regex,
    condition: c,
  }
}

function collectHostSuffixes(hostname: string): string[] {
  const out: string[] = []
  let rest = hostname.toLowerCase()
  while (rest) {
    out.push(rest)
    const i = rest.indexOf('.')
    if (i === -1) break
    rest = rest.slice(i + 1)
  }
  return out
}

function isRegexSupportedChromeSubset(regex: string): { isSupported: boolean; reason?: string } {
  if (regex.length > 1000) return { isSupported: false, reason: 'Regex too long' }
  const bad = ['\\1', '\\2', '(?<', '(?P<', '(?!', '(?<!', '(?<=', '(?=', '(?#', '\\k<', '\\g{']
  for (const b of bad) {
    if (regex.includes(b)) return { isSupported: false, reason: `Unsupported construct: ${b}` }
  }
  try {
    new RegExp(regex)
    return { isSupported: true }
  } catch (e) {
    return { isSupported: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

export class DeclarativeNetRequestAPI {
  private byExtension = new Map<string, ExtensionDNRState>()
  private hostIndex = new Map<string, InternalRule[]>()
  private genericRules: InternalRule[] = []

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('declarativeNetRequest.getDynamicRules', this.getDynamicRules, {
      permission: 'declarativeNetRequest',
    })
    handle('declarativeNetRequest.updateDynamicRules', this.updateDynamicRules, {
      permission: 'declarativeNetRequest',
    })
    handle('declarativeNetRequest.getSessionRules', this.getSessionRules, {
      permission: 'declarativeNetRequest',
    })
    handle('declarativeNetRequest.updateSessionRules', this.updateSessionRules, {
      permission: 'declarativeNetRequest',
    })
    handle('declarativeNetRequest.getEnabledRulesets', this.getEnabledRulesets, {
      permission: 'declarativeNetRequest',
    })
    handle('declarativeNetRequest.updateEnabledRulesets', this.updateEnabledRulesets, {
      permission: 'declarativeNetRequest',
    })
    handle('declarativeNetRequest.isRegexSupported', this.isRegexSupported, {
      permission: 'declarativeNetRequest',
    })
    handle('declarativeNetRequest.getMatchedRules', this.getMatchedRules, {
      permission: 'declarativeNetRequest',
    })

    const sessionExtensions = getSessionExtensions(this.ctx.session)
    const getAll = (sessionExtensions as any).getAllExtensions
    if (typeof getAll === 'function') {
      const list = getAll.call(sessionExtensions) || []
      for (const ext of list) {
        void this.loadExtensionRules(ext)
      }
    }

    sessionExtensions.on('extension-loaded', (_event, extension: Electron.Extension) => {
      void this.loadExtensionRules(extension)
    })

    sessionExtensions.on('extension-unloaded', (_event, extension: Electron.Extension) => {
      this.byExtension.delete(extension.id)
      this.rebuildGlobalIndexes()
    })
  }

  private ensureState(extensionId: string): ExtensionDNRState {
    let s = this.byExtension.get(extensionId)
    if (!s) {
      s = {
        staticByRuleset: new Map(),
        enabledRulesets: new Set(),
        dynamicRules: new Map(),
        sessionRules: new Map(),
      }
      this.byExtension.set(extensionId, s)
    }
    return s
  }

  private async loadExtensionRules(extension: Electron.Extension) {
    const manifest = extension.manifest as chrome.runtime.ManifestV3
    const dnr = manifest.declarative_net_request
    if (!dnr?.rule_resources?.length) return

    const state = this.ensureState(extension.id)
    state.staticByRuleset.clear()

    for (const res of dnr.rule_resources) {
      try {
        const fullPath = path.join(extension.path, res.path)
        const raw = await fs.readFile(fullPath, 'utf8')
        const data = JSON.parse(raw)
        const arr: DNRRule[] = Array.isArray(data) ? data : data.rules
        if (!Array.isArray(arr)) continue
        const compiled: InternalRule[] = []
        for (const rule of arr) {
          const c = compileRule(extension.id, rule)
          if (c) compiled.push(c)
        }
        state.staticByRuleset.set(res.id, compiled)
      } catch (e) {
        console.warn(
          `[declarativeNetRequest] Failed to load ruleset "${res.id}" for ${extension.id}:`,
          e instanceof Error ? e.message : e,
        )
      }
    }

    this.rebuildGlobalIndexes()
  }

  private rebuildGlobalIndexes() {
    this.hostIndex.clear()
    this.genericRules = []

    for (const [, state] of this.byExtension) {
      const rules: InternalRule[] = []
      for (const rulesetId of state.enabledRulesets) {
        const chunk = state.staticByRuleset.get(rulesetId)
        if (chunk) rules.push(...chunk)
      }
      rules.push(...state.dynamicRules.values())
      rules.push(...state.sessionRules.values())

      for (const r of rules) {
        if (r.hostKey) {
          const list = this.hostIndex.get(r.hostKey) || []
          list.push(r)
          this.hostIndex.set(r.hostKey, list)
        } else {
          this.genericRules.push(r)
        }
      }
    }
  }

  private candidateRulesForUrl(requestUrl: string): InternalRule[] {
    const host = safeHostname(requestUrl)
    if (!host) return [...this.genericRules]
    const seen = new Set<string>()
    const out: InternalRule[] = []
    const key = (r: InternalRule) => `${r.extensionId}:${r.id}`
    for (const suffix of collectHostSuffixes(host)) {
      const bucket = this.hostIndex.get(suffix)
      if (!bucket) continue
      for (const r of bucket) {
        const k = key(r)
        if (!seen.has(k)) {
          seen.add(k)
          out.push(r)
        }
      }
    }
    for (const r of this.genericRules) {
      const k = key(r)
      if (!seen.has(k)) {
        seen.add(k)
        out.push(r)
      }
    }
    return out
  }

  evaluateOnBeforeRequest(details: WebRequestDetails): WebRequestBlockingResponse | null {
    const dnrType = normalizeResourceTypeForDnr(details.type)
    const elementTypeMask = resourceTypeToElementMask(dnrType)
    const probe = {
      url: details.url,
      method: details.method,
      tabId: details.tabId,
      type: dnrType,
      initiator: details.initiator,
    }

    const candidates = this.candidateRulesForUrl(details.url)
    let best: InternalRule | null = null

    for (const r of candidates) {
      if (
        !conditionMatchesRequest(
          r.condition,
          probe,
          elementTypeMask,
          r.parsedUrlFilter,
          r.regex,
        )
      ) {
        continue
      }
      if (
        !best ||
        r.priority > best.priority ||
        (r.priority === best.priority && r.id > best.id)
      ) {
        best = r
      }
    }

    if (!best) return null
    const response = this.actionToBlockingResponse(best, details.url)
    if (
      response?.cancel === true &&
      shouldSkipNetworkBlockAsSameSite(details.url, details.initiator, details.type)
    ) {
      return null
    }
    return response
  }

  private actionToBlockingResponse(
    rule: InternalRule,
    requestUrl: string,
  ): WebRequestBlockingResponse | null {
    const a = rule.action
    switch (a.type) {
      case 'block':
        return { cancel: true }
      case 'allow':
      case 'allowAllRequests':
        return null
      case 'upgradeScheme': {
        try {
          const u = new URL(requestUrl)
          if (u.protocol !== 'http:') return null
          u.protocol = 'https:'
          return { redirectUrl: u.href }
        } catch {
          return null
        }
      }
      case 'redirect': {
        const red = a.redirect
        if (!red) return null
        if (red.url) return { redirectUrl: red.url }
        if (red.extensionPath) {
          const p = red.extensionPath.replace(/^\//, '')
          return { redirectUrl: `chrome-extension://${rule.extensionId}/${p}` }
        }
        if (red.transform?.scheme === 'https') {
          try {
            const u = new URL(requestUrl)
            if (u.protocol === 'http:') {
              u.protocol = 'https:'
              return { redirectUrl: u.href }
            }
          } catch {
            return null
          }
        }
        return null
      }
      default:
        return null
    }
  }

  private getDynamicRules = ({ extension }: ExtensionEvent, filter?: { ruleIds?: number[] }) => {
    if (!extension) return []
    const state = this.byExtension.get(extension.id)
    if (!state) return []
    const rules = [...state.dynamicRules.values()].map((r) => this.internalToApiRule(r))
    if (filter?.ruleIds?.length) {
      const set = new Set(filter.ruleIds)
      return rules.filter((r) => set.has(r.id))
    }
    return rules
  }

  private getSessionRules = ({ extension }: ExtensionEvent, filter?: { ruleIds?: number[] }) => {
    if (!extension) return []
    const state = this.byExtension.get(extension.id)
    if (!state) return []
    const rules = [...state.sessionRules.values()].map((r) => this.internalToApiRule(r))
    if (filter?.ruleIds?.length) {
      const set = new Set(filter.ruleIds)
      return rules.filter((r) => set.has(r.id))
    }
    return rules
  }

  private internalToApiRule(r: InternalRule): DNRRule {
    return {
      id: r.id,
      priority: r.priority,
      action: r.action,
      condition: r.condition,
    }
  }

  private updateDynamicRules = async (
    { extension }: ExtensionEvent,
    options: chrome.declarativeNetRequest.UpdateRuleOptions,
  ) => {
    if (!extension) return
    const state = this.ensureState(extension.id)
    const remove = new Set(options.removeRuleIds || [])
    for (const id of remove) {
      state.dynamicRules.delete(id)
    }
    for (const rule of options.addRules || []) {
      const c = compileRule(extension.id, rule)
      if (c) state.dynamicRules.set(rule.id, c)
    }
    this.rebuildGlobalIndexes()
  }

  private updateSessionRules = async (
    { extension }: ExtensionEvent,
    options: chrome.declarativeNetRequest.UpdateRuleOptions,
  ) => {
    if (!extension) return
    const state = this.ensureState(extension.id)
    const remove = new Set(options.removeRuleIds || [])
    for (const id of remove) {
      state.sessionRules.delete(id)
    }
    for (const rule of options.addRules || []) {
      const c = compileRule(extension.id, rule)
      if (c) state.sessionRules.set(rule.id, c)
    }
    this.rebuildGlobalIndexes()
  }

  private getEnabledRulesets = ({ extension }: ExtensionEvent): string[] => {
    if (!extension) return []
    const state = this.byExtension.get(extension.id)
    if (!state) return []
    return [...state.enabledRulesets]
  }

  private updateEnabledRulesets = async (
    { extension }: ExtensionEvent,
    options: chrome.declarativeNetRequest.UpdateRulesetOptions,
  ) => {
    if (!extension) return
    const state = this.ensureState(extension.id)
    for (const id of options.disableRulesetIds || []) {
      state.enabledRulesets.delete(id)
    }
    for (const id of options.enableRulesetIds || []) {
      state.enabledRulesets.add(id)
    }
    this.rebuildGlobalIndexes()
  }

  private isRegexSupported = (
    _event: ExtensionEvent,
    regexOptions: chrome.declarativeNetRequest.RegexOptions,
  ): chrome.declarativeNetRequest.IsRegexSupportedResult => {
    const r = isRegexSupportedChromeSubset(regexOptions.regex)
    return r as chrome.declarativeNetRequest.IsRegexSupportedResult
  }

  private getMatchedRules = async (
    _event: ExtensionEvent,
    _filter?: chrome.declarativeNetRequest.MatchedRulesFilter,
  ): Promise<chrome.declarativeNetRequest.RulesMatchedDetails> => {
    return { rulesMatchedInfo: [] }
  }
}
