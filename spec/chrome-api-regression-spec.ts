import { expect } from 'chai'
import { EventEmitter } from 'node:events'

import { CommandsAPI } from '../src/browser/api/commands'
import { CookiesAPI } from '../src/browser/api/cookies'
import { PermissionsAPI } from '../src/browser/api/permissions'

const createRouterHarness = () => {
  const handlers = new Map<string, Function>()
  const events: Array<{ extensionId: string; name: string; payload: any }> = []
  return {
    handlers,
    events,
    router: {
      apiHandler: () => (name: string, fn: Function) => handlers.set(name, fn),
      setPermissionResolver: () => null,
      sendEvent: (extensionId: string, name: string, payload: any) =>
        events.push({ extensionId, name, payload }),
      sendEventForEachListener: () => null,
      broadcastEvent: () => null,
    },
  }
}

describe('untested API behavior regressions', () => {
  describe('PermissionsAPI', () => {
    it('removes granted permissions and emits onRemoved', async () => {
      const harness = createRouterHarness()
      const sessionExtensions = new EventEmitter() as any
      sessionExtensions.getAllExtensions = () => [
        {
          id: 'ext-1',
          manifest: {
            permissions: ['tabs', 'storage'],
            host_permissions: ['https://a.example/*'],
          },
        },
      ]
      const ctx: any = {
        router: harness.router,
        session: { extensions: sessionExtensions },
        store: { requestPermissions: async () => true },
      }
      new PermissionsAPI(ctx)

      const extension = {
        id: 'ext-1',
        manifest: {
          permissions: ['tabs', 'storage'],
          optional_permissions: ['bookmarks'],
          host_permissions: ['https://a.example/*'],
          optional_host_permissions: ['https://b.example/*'],
        },
      }

      const removed = await harness.handlers
        .get('permissions.remove')!({ extension }, { permissions: ['storage'] })
      expect(removed).to.equal(true)

      const all = await harness.handlers.get('permissions.getAll')!({ extension })
      expect(all.permissions).to.deep.equal(['tabs'])
      expect(harness.events.find((e) => e.name === 'permissions.onRemoved')?.payload).to.deep.equal(
        { permissions: ['storage'], origins: [] },
      )
    })
  })

  describe('CookiesAPI', () => {
    it('returns the longest-path cookie when multiple cookies match', async () => {
      const harness = createRouterHarness()
      const cookies = {
        addListener: () => null,
        get: async () => [
          { name: 'sid', path: '/', domain: 'example.com', creation: 5 },
          { name: 'sid', path: '/app/deep', domain: 'example.com', creation: 9 },
        ],
        set: async () => null,
        remove: async () => null,
      }
      const ctx: any = {
        router: harness.router,
        session: { cookies },
        store: { tabs: new Set() },
      }
      new CookiesAPI(ctx)

      const result = await harness.handlers
        .get('cookies.get')!({}, { url: 'https://example.com/app/deep', name: 'sid' })

      expect(result).to.be.an('object')
      expect(result.path).to.equal('/app/deep')
    })
  })

  describe('CommandsAPI', () => {
    it('reads existing extension commands and exposes default shortcuts', async () => {
      const harness = createRouterHarness()
      const sessionExtensions = new EventEmitter() as any
      sessionExtensions.getAllExtensions = () => [
        {
          id: 'ext-cmd',
          manifest: {
            commands: {
              toggle: {
                description: 'Toggle action',
                suggested_key: { default: 'Ctrl+Shift+Y' },
              },
            },
          },
        },
      ]
      const ctx: any = {
        router: harness.router,
        session: { extensions: sessionExtensions },
      }
      new CommandsAPI(ctx)

      const commands = await harness.handlers.get('commands.getAll')!({
        extension: { id: 'ext-cmd' },
      })
      expect(commands).to.deep.equal([
        {
          name: 'toggle',
          description: 'Toggle action',
          shortcut: 'Ctrl+Shift+Y',
        },
      ])
    })
  })
})
