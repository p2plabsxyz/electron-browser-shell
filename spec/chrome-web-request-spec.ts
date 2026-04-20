import { expect } from 'chai'
import { EventEmitter } from 'node:events'

import { WebRequestAPI } from '../src/browser/api/web-request'

describe('chrome.webRequest', () => {
  const createHarness = () => {
    const handlers = new Map<string, Function>()
    const sentEvents: Array<{ extensionId: string; name: string; payload: any }> = []
    const sessionExtensions = new EventEmitter() as any
    sessionExtensions.on = sessionExtensions.addListener.bind(sessionExtensions)
    const ctx: any = {
      router: {
        apiHandler: () => (name: string, fn: Function) => handlers.set(name, fn),
        sendEvent: (extensionId: string, name: string, payload: any) =>
          sentEvents.push({ extensionId, name, payload }),
      },
      session: { extensions: sessionExtensions },
      store: {
        getTabIdForWebContentsId: () => 1,
        getWindowIdForWebContentsId: () => 11,
        getDocumentId: () => 'doc-1',
      },
    }
    const api = new WebRequestAPI(ctx)
    return { api, handlers, sentEvents }
  }

  const extensionEvent = (extensionId: string, permissions: string[] = ['webRequest']) => ({
    extension: {
      id: extensionId,
      manifest: { permissions },
    },
  })

  const requestDetails = (url: string) =>
    ({
      id: `req-${Math.random().toString(16).slice(2)}`,
      url,
      method: 'GET',
      resourceType: 'script',
      webContentsId: 1,
      frameId: 0,
      parentFrameId: -1,
      timestamp: Date.now(),
      referrer: 'https://origin.example/',
    }) as any

  it('delivers non-blocking onBeforeRequest events', async () => {
    const { api, handlers, sentEvents } = createHarness()
    handlers.get('webRequest.addOnBeforeRequestListener')!(
      extensionEvent('ext-a'),
      { urls: ['*://*/*'] },
      [],
    )

    const result = await api.notifyOnBeforeRequest(requestDetails('https://example.com/asset.js'))
    expect(result).to.deep.equal({})
    expect(sentEvents).to.have.length(1)
    expect(sentEvents[0].name).to.equal('webRequest.onBeforeRequest')
    expect(sentEvents[0].payload.url).to.equal('https://example.com/asset.js')
  })

  it('supports blocking cancellation and redirect responses', async () => {
    const { api, handlers, sentEvents } = createHarness()
    handlers.get('webRequest.addOnBeforeRequestListener')!(
      extensionEvent('ext-a', ['webRequest', 'webRequestBlocking']),
      { urls: ['*://*/*'] },
      ['blocking'],
    )

    const cancelPromise = api.notifyOnBeforeRequest(requestDetails('https://example.com/blocked.js'))
    const cancelPayload = sentEvents[sentEvents.length - 1].payload
    handlers.get('webRequest.onBeforeRequest.response')!(
      extensionEvent('ext-a'),
      cancelPayload.requestId,
      cancelPayload.listenerId,
      { cancel: true },
    )
    expect(await cancelPromise).to.deep.equal({ cancel: true })

    const redirectPromise = api.notifyOnBeforeRequest(requestDetails('https://example.com/start.js'))
    const redirectPayload = sentEvents[sentEvents.length - 1].payload
    handlers.get('webRequest.onBeforeRequest.response')!(
      extensionEvent('ext-a'),
      redirectPayload.requestId,
      redirectPayload.listenerId,
      { redirectUrl: 'https://example.com/redirected.js' },
    )
    expect(await redirectPromise).to.deep.equal({
      redirectUrl: 'https://example.com/redirected.js',
    })
  })

  it('honors add/remove listener lifecycle for multiple listeners', async () => {
    const { api, handlers, sentEvents } = createHarness()
    handlers.get('webRequest.addOnBeforeRequestListener')!(
      extensionEvent('ext-a'),
      { urls: ['*://*/*'] },
      [],
    )
    handlers.get('webRequest.addOnBeforeRequestListener')!(
      extensionEvent('ext-b'),
      { urls: ['*://*/*'] },
      [],
    )

    await api.notifyOnBeforeRequest(requestDetails('https://example.com/one.js'))
    const firstEventTargets = sentEvents.map((e) => e.extensionId)
    expect(firstEventTargets).to.include.members(['ext-a', 'ext-b'])

    sentEvents.length = 0
    handlers.get('webRequest.removeOnBeforeRequestListener')!(extensionEvent('ext-a'))
    await api.notifyOnBeforeRequest(requestDetails('https://example.com/two.js'))

    expect(sentEvents.map((e) => e.extensionId)).to.deep.equal(['ext-b'])
  })
})
