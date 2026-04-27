import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'

type PersistedAlarm = {
  name: string
  scheduledTime: number
  periodInMinutes?: number
}

type AlarmMap = Map<string, PersistedAlarm>

const ALARMS_STATE_NS = 'alarms'

export class AlarmsAPI {
  private alarmsByExtension = new Map<string, AlarmMap>()
  private timers = new Map<string, NodeJS.Timeout>()
  private restoreReady: Promise<void>

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('alarms.create', this.create, { permission: 'alarms' })
    handle('alarms.get', this.get, { permission: 'alarms' })
    handle('alarms.getAll', this.getAll, { permission: 'alarms' })
    handle('alarms.clear', this.clear, { permission: 'alarms' })
    handle('alarms.clearAll', this.clearAll, { permission: 'alarms' })

    this.restoreReady = this.restoreFromState()

    const sessionExtensions = ctx.session.extensions || ctx.session
    sessionExtensions.on('extension-unloaded', (_event, extension) => {
      this.clearExtension(extension.id, true)
    })
  }

  private getState(): Record<string, PersistedAlarm[]> {
    return this.ctx.stateStore.getNamespace<Record<string, PersistedAlarm[]>>(ALARMS_STATE_NS, {})
  }

  private saveState() {
    const nextState: Record<string, PersistedAlarm[]> = {}
    for (const [extensionId, alarms] of this.alarmsByExtension) {
      nextState[extensionId] = Array.from(alarms.values())
    }
    this.ctx.stateStore.setNamespace(ALARMS_STATE_NS, nextState)
    void this.ctx.stateStore.flush().catch(() => {})
  }

  private async restoreFromState() {
    await this.ctx.stateStore.whenHydrated()
    const persisted = this.getState()
    for (const [extensionId, alarms] of Object.entries(persisted)) {
      if (!Array.isArray(alarms) || alarms.length === 0) continue
      const map: AlarmMap = new Map()
      for (const alarm of alarms) {
        if (!alarm || typeof alarm.scheduledTime !== 'number') continue
        const name = typeof alarm.name === 'string' ? alarm.name : ''
        const saved: PersistedAlarm = {
          name,
          scheduledTime: alarm.scheduledTime,
          periodInMinutes:
            typeof alarm.periodInMinutes === 'number' ? alarm.periodInMinutes : undefined,
        }
        map.set(name, saved)
        this.scheduleAlarm(extensionId, saved)
      }
      if (map.size > 0) {
        this.alarmsByExtension.set(extensionId, map)
      }
    }
  }

  private key(extensionId: string, alarmName: string) {
    return `${extensionId}:${alarmName}`
  }

  private toChromeAlarm(alarm: PersistedAlarm): chrome.alarms.Alarm {
    const out: chrome.alarms.Alarm = {
      name: alarm.name,
      scheduledTime: alarm.scheduledTime,
    }
    if (typeof alarm.periodInMinutes === 'number') {
      out.periodInMinutes = alarm.periodInMinutes
    }
    return out
  }

  private scheduleAlarm(extensionId: string, alarm: PersistedAlarm) {
    const timerKey = this.key(extensionId, alarm.name)
    const existing = this.timers.get(timerKey)
    if (existing) {
      clearTimeout(existing)
      this.timers.delete(timerKey)
    }

    const delay = Math.max(0, alarm.scheduledTime - Date.now())
    const timer = setTimeout(() => {
      this.fireAlarm(extensionId, alarm.name)
    }, delay)
    this.timers.set(timerKey, timer)
  }

  private fireAlarm(extensionId: string, alarmName: string) {
    const alarmMap = this.alarmsByExtension.get(extensionId)
    if (!alarmMap) return

    const alarm = alarmMap.get(alarmName)
    if (!alarm) return

    this.ctx.router.sendEvent(extensionId, 'alarms.onAlarm', this.toChromeAlarm(alarm))

    if (typeof alarm.periodInMinutes === 'number' && alarm.periodInMinutes > 0) {
      alarm.scheduledTime = Date.now() + alarm.periodInMinutes * 60 * 1000
      alarmMap.set(alarmName, alarm)
      this.scheduleAlarm(extensionId, alarm)
      this.saveState()
      return
    }

    this.clearForExtension(extensionId, alarmName)
  }

  private clearTimer(extensionId: string, alarmName: string) {
    const timerKey = this.key(extensionId, alarmName)
    const existing = this.timers.get(timerKey)
    if (existing) {
      clearTimeout(existing)
      this.timers.delete(timerKey)
    }
  }

  private clearForExtension(extensionId: string, alarmName: string) {
    this.clearTimer(extensionId, alarmName)
    const alarmMap = this.alarmsByExtension.get(extensionId)
    if (!alarmMap) return false

    const didDelete = alarmMap.delete(alarmName)
    if (alarmMap.size === 0) {
      this.alarmsByExtension.delete(extensionId)
    }
    if (didDelete) {
      this.saveState()
    }
    return didDelete
  }

  private clearExtension(extensionId: string, persist: boolean) {
    const alarmMap = this.alarmsByExtension.get(extensionId)
    if (!alarmMap) return
    for (const name of alarmMap.keys()) {
      this.clearTimer(extensionId, name)
    }
    this.alarmsByExtension.delete(extensionId)
    if (persist) {
      this.saveState()
    }
  }

  private create = async (
    { extension }: ExtensionEvent,
    alarmNameOrInfo?: string | chrome.alarms.AlarmCreateInfo,
    maybeInfo?: chrome.alarms.AlarmCreateInfo,
  ) => {
    await this.restoreReady
    const alarmName = typeof alarmNameOrInfo === 'string' ? alarmNameOrInfo : ''
    const alarmInfo =
      typeof alarmNameOrInfo === 'object' && alarmNameOrInfo !== null
        ? alarmNameOrInfo
        : maybeInfo || {}

    let scheduledTime = typeof alarmInfo.when === 'number' ? alarmInfo.when : Date.now()
    if (typeof alarmInfo.delayInMinutes === 'number') {
      scheduledTime = Date.now() + alarmInfo.delayInMinutes * 60 * 1000
    } else if (typeof alarmInfo.when !== 'number' && typeof alarmInfo.periodInMinutes === 'number') {
      scheduledTime = Date.now() + alarmInfo.periodInMinutes * 60 * 1000
    }

    const next: PersistedAlarm = {
      name: alarmName,
      scheduledTime,
      periodInMinutes:
        typeof alarmInfo.periodInMinutes === 'number' ? alarmInfo.periodInMinutes : undefined,
    }

    const extensionId = extension.id
    const alarmMap = this.alarmsByExtension.get(extensionId) || new Map()
    alarmMap.set(alarmName, next)
    this.alarmsByExtension.set(extensionId, alarmMap)
    this.scheduleAlarm(extensionId, next)
    this.saveState()
  }

  private get = async (
    { extension }: ExtensionEvent,
    name?: string,
  ): Promise<chrome.alarms.Alarm | undefined> => {
    await this.restoreReady
    const alarmName = typeof name === 'string' ? name : ''
    const alarmMap = this.alarmsByExtension.get(extension.id)
    const alarm = alarmMap?.get(alarmName)
    return alarm ? this.toChromeAlarm(alarm) : undefined
  }

  private getAll = async ({ extension }: ExtensionEvent): Promise<chrome.alarms.Alarm[]> => {
    await this.restoreReady
    const alarmMap = this.alarmsByExtension.get(extension.id)
    if (!alarmMap) return []
    return Array.from(alarmMap.values()).map((alarm) => this.toChromeAlarm(alarm))
  }

  private clear = async ({ extension }: ExtensionEvent, name?: string): Promise<boolean> => {
    await this.restoreReady
    const alarmName = typeof name === 'string' ? name : ''
    return this.clearForExtension(extension.id, alarmName)
  }

  private clearAll = async ({ extension }: ExtensionEvent): Promise<boolean> => {
    await this.restoreReady
    const alarmMap = this.alarmsByExtension.get(extension.id)
    if (!alarmMap || alarmMap.size === 0) return false
    this.clearExtension(extension.id, true)
    return true
  }
}
