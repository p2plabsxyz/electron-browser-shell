import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'

const ISOLATED_WORLD = 1000

function frameId(f: Electron.WebFrameMain) {
  return f === f.top ? 0 : f.frameTreeNodeId
}

function resolveFrame(tab: Electron.WebContents, frameIds?: number[]): Electron.WebFrameMain | null {
  if (!('mainFrame' in tab)) return null
  const main = (tab as Electron.WebContents & { mainFrame: Electron.WebFrameMain }).mainFrame
  if (!main || main.isDestroyed()) return null

  const fid = frameIds?.[0]
  if (fid == null || fid === 0) return main

  const hit = main.framesInSubtree.find((f) => frameId(f) === fid)
  return hit ?? main
}

export class ScriptingAPI {
  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('scripting.insertCSS', this.insertCSS.bind(this), { permission: 'scripting' })
    handle('scripting.executeScript', this.executeScript.bind(this), { permission: 'scripting' })
  }

  private async insertCSS(_event: ExtensionEvent, injection: any): Promise<void> {
    const tabId = injection?.target?.tabId
    const css = injection?.css
    if (typeof tabId !== 'number' || typeof css !== 'string') return

    const tab = this.ctx.store.getTabById(tabId)
    if (!tab || tab.isDestroyed()) {
      throw new Error(`No tab with id: ${tabId}`)
    }

    const frame = resolveFrame(tab, injection?.target?.frameIds as number[] | undefined)
    if (frame && frame.top && frame !== frame.top) {
      const code = `(function(){var e=document.createElement('style');e.textContent=${JSON.stringify(css)};(document.head||document.documentElement).appendChild(e);})()`
      await frame.executeJavaScript(code, true)
      return
    }

    await tab.insertCSS(css)
  }

  private async executeScript(_event: ExtensionEvent, injection: any): Promise<{ result?: unknown }[]> {
    const tabId = injection?.target?.tabId
    if (typeof tabId !== 'number') {
      throw new Error('executeScript: target.tabId is required')
    }

    const tab = this.ctx.store.getTabById(tabId)
    if (!tab || tab.isDestroyed()) {
      throw new Error(`No tab with id: ${tabId}`)
    }

    const funcSrc =
      typeof injection.func === 'string' ? injection.func : String(injection.func ?? '')
    if (!funcSrc.trim()) {
      throw new Error('executeScript: func is required')
    }
    const args = Array.isArray(injection.args) ? injection.args : []
    const frame = resolveFrame(tab, injection?.target?.frameIds as number[] | undefined)
    if (!frame || frame.isDestroyed()) {
      throw new Error('executeScript: frame not available')
    }

    const code = `(function(){ const __a = ${JSON.stringify(args)}; var fn = ${funcSrc}; return fn.apply(null, __a); })()`

    const world = injection.world
    // Chrome defaults to ISOLATED; MAIN must be explicit.
    const isolated = world !== 'MAIN' && world !== 1

    if (isolated && frame === frame.top && typeof tab.executeJavaScriptInIsolatedWorld === 'function') {
      const out = await tab.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code }], true)
      return [{ result: out }]
    }

    const result = await frame.executeJavaScript(code, true)
    return [{ result }]
  }
}
