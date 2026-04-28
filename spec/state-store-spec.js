const { expect } = require('chai')
const os = require('node:os')
const path = require('node:path')
const { promises: fs } = require('node:fs')

const { ExtensionStateStore } = require('../src/browser/state-store')

describe('ExtensionStateStore', () => {
  const tempRoot = path.join(os.tmpdir(), `pce-state-store-${Date.now()}`)

  after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true })
  })

  it('persists namespace data across instances', async () => {
    const session = { partition: 'persist:test-roundtrip' }
    const first = new ExtensionStateStore(session, { baseDir: tempRoot })
    await first.hydrate()
    first.setNamespace('alarms', [{ name: 'ping', when: Date.now() + 1000 }])
    await first.flush()

    const second = new ExtensionStateStore(session, { baseDir: tempRoot })
    await second.hydrate()
    const alarms = second.getNamespace('alarms', [])

    expect(alarms).to.be.an('array')
    expect(alarms).to.have.length(1)
    expect(alarms[0].name).to.equal('ping')
  })

  it('resets invalid schema payloads to defaults', async () => {
    const session = { partition: 'persist:test-schema' }
    const filename = 'persist_test-schema.json'
    const statePath = path.join(tempRoot, filename)

    await fs.mkdir(tempRoot, { recursive: true })
    await fs.writeFile(
      statePath,
      JSON.stringify({
        schemaVersion: 9999,
        namespaces: { alarms: [{ name: 'stale' }] },
      }),
      'utf8',
    )

    const store = new ExtensionStateStore(session, { baseDir: tempRoot })
    await store.hydrate()
    expect(store.getNamespace('alarms', [])).to.deep.equal([])
  })
})
