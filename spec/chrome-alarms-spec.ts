import { expect } from 'chai'
import { useExtensionBrowser, useServer } from './hooks'

describe('chrome.alarms', () => {
  const server = useServer()
  const browser = useExtensionBrowser({
    url: server.getUrl,
    extensionName: 'chrome-alarms',
  })

  afterEach(async () => {
    try {
      await browser.crx.exec('alarms.clearAll')
    } catch {
      // Ignore cleanup errors when the host is already torn down.
    }
  })

  it('creates and returns an alarm by name', async () => {
    await browser.crx.exec('alarms.create', 'tick', { delayInMinutes: 0.1 })
    const alarm = await browser.crx.exec('alarms.get', 'tick')

    expect(alarm).to.be.an('object')
    expect(alarm.name).to.equal('tick')
    expect(alarm.scheduledTime).to.be.a('number')
  })

  it('returns all alarms', async () => {
    await browser.crx.exec('alarms.create', 'one', { delayInMinutes: 0.2 })
    await browser.crx.exec('alarms.create', 'two', { delayInMinutes: 0.2 })

    const alarms = await browser.crx.exec('alarms.getAll')
    expect(alarms).to.be.an('array')
    expect(alarms.map((alarm: chrome.alarms.Alarm) => alarm.name)).to.include.members(['one', 'two'])
  })

  it('clears named alarms', async () => {
    await browser.crx.exec('alarms.create', 'clear-me', { delayInMinutes: 0.1 })
    const cleared = await browser.crx.exec('alarms.clear', 'clear-me')
    const alarm = await browser.crx.exec('alarms.get', 'clear-me')

    expect(cleared).to.equal(true)
    // Callback RPC transport returns null for undefined values.
    expect(alarm).to.equal(null)
  })

  it('emits onAlarm events', async () => {
    await browser.crx.exec('alarms.create', 'soon', { periodInMinutes: 0.01 })
    const [alarm] = await browser.crx.eventOnce('alarms.onAlarm')

    expect(alarm).to.be.an('object')
    expect(alarm.name).to.equal('soon')
  })
})
