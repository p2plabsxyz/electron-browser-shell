import { expect } from 'chai'
import { useExtensionBrowser, useServer } from './hooks'

describe('chrome.extension', () => {
  const server = useServer()
  const browser = useExtensionBrowser({
    url: server.getUrl,
    extensionName: 'rpc',
  })

  it('getViews returns best-effort view metadata list', async () => {
    const result = await browser.crx.exec('extension.getViews')
    expect(result).to.be.an('array')
    expect(result.length).to.be.greaterThan(0)
    const first = result[0]
    expect(first).to.be.an('object')
    expect(first).to.have.property('id')
    expect(first).to.have.property('type')
  })
})
