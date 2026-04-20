import { expect } from 'chai'

import { ProxyAPI } from '../src/browser/api/proxy'

describe('chrome.proxy', () => {
  const createHarness = () => {
    const handlers = new Map<string, Function>()
    const setProxyCalls: any[] = []
    const onChangeCalls: Array<{ extensionId: string; details: any }> = []

    const ctx: any = {
      session: {
        setProxy: async (cfg: any) => {
          setProxyCalls.push(cfg)
        },
      },
      router: {
        apiHandler: () => (name: string, fn: Function) => handlers.set(name, fn),
        sendEventForEachListener: (eventName: string, mapArgs: (extensionId: string) => any[]) => {
          if (eventName !== 'proxy.settings.onChange') return
          // Simulate two listeners: the controlling extension and some other extension.
          for (const extensionId of ['ext-1', 'ext-2']) {
            const [details] = mapArgs(extensionId)
            onChangeCalls.push({ extensionId, details })
          }
        },
      },
    }

    new ProxyAPI(ctx)

    const evt = (id: string) => ({ extension: { id } })
    return { handlers, setProxyCalls, onChangeCalls, evt }
  }

  it('settings.get returns system config and controllable state', async () => {
    const { handlers, evt } = createHarness()
    const out = await handlers.get('proxy.settings.get')!(evt('ext-1'))
    expect(out.value).to.deep.equal({ mode: 'system' })
    expect(out.levelOfControl).to.equal('controllable_by_this_extension')
    expect(out.incognitoSpecific).to.equal(false)
  })

  it('settings.set applies config and updates levelOfControl', async () => {
    const { handlers, setProxyCalls, onChangeCalls, evt } = createHarness()
    await handlers.get('proxy.settings.set')!(evt('ext-1'), { value: { mode: 'direct' } })

    expect(setProxyCalls[0]).to.deep.equal({ mode: 'direct' })
    // onChange is delivered per-listener; ensure controlling extension sees "controlled_by_this_extension".
    const controlling = onChangeCalls.find((c) => c.extensionId === 'ext-1')!.details
    const other = onChangeCalls.find((c) => c.extensionId === 'ext-2')!.details
    expect(controlling.value.mode).to.equal('direct')
    expect(controlling.levelOfControl).to.equal('controlled_by_this_extension')
    expect(other.levelOfControl).to.equal('controlled_by_other_extensions')

    const out = await handlers.get('proxy.settings.get')!(evt('ext-1'))
    expect(out.levelOfControl).to.equal('controlled_by_this_extension')
  })

  it('settings.clear resets to system only for controlling extension', async () => {
    const { handlers, setProxyCalls, onChangeCalls, evt } = createHarness()
    await handlers.get('proxy.settings.set')!(evt('ext-1'), { value: { mode: 'direct' } })
    onChangeCalls.length = 0

    await handlers.get('proxy.settings.clear')!(evt('ext-2'))
    expect(setProxyCalls).to.have.length(1) // clear ignored

    await handlers.get('proxy.settings.clear')!(evt('ext-1'))
    expect(setProxyCalls[1]).to.deep.equal({ mode: 'system' })
    const controlling = onChangeCalls.find((c) => c.extensionId === 'ext-1')!.details
    expect(controlling.value.mode).to.equal('system')
    expect(controlling.levelOfControl).to.equal('controllable_by_this_extension')
  })

  it('fixed_servers maps to Electron proxyRules / bypass list', async () => {
    const { handlers, setProxyCalls, evt } = createHarness()
    await handlers.get('proxy.settings.set')!(evt('ext-1'), {
      value: {
        mode: 'fixed_servers',
        rules: {
          singleProxy: { scheme: 'http', host: '127.0.0.1', port: 8888 },
          bypassList: ['localhost', '127.0.0.1'],
        },
      },
    })

    expect(setProxyCalls[0]).to.deep.equal({
      mode: 'fixed_servers',
      proxyRules: 'http=127.0.0.1:8888;https=127.0.0.1:8888;ftp=127.0.0.1:8888',
      proxyBypassRules: 'localhost,127.0.0.1',
    })
  })
})

