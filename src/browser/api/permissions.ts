import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'

/**
 * This is a very basic implementation of the permissions API. Likely
 * more work will be needed to integrate with the native permissions.
 */
export class PermissionsAPI {
  private permissionMap = new Map<
    /* extensionId */ string,
    {
      permissions: chrome.runtime.ManifestPermissions[]
      origins: string[]
    }
  >()

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('permissions.contains', this.contains)
    handle('permissions.getAll', this.getAll)
    handle('permissions.remove', this.remove)
    handle('permissions.request', this.request)
    this.ctx.router.setPermissionResolver(this.hasPermission)

    const sessionExtensions = ctx.session.extensions || ctx.session
    sessionExtensions.getAllExtensions().forEach((ext) => this.processExtension(ext))

    sessionExtensions.on('extension-loaded', (_event, extension) => {
      this.processExtension(extension)
    })

    sessionExtensions.on('extension-unloaded', (_event, extension) => {
      this.permissionMap.delete(extension.id)
    })
  }

  private processExtension(extension: Electron.Extension) {
    const manifest: chrome.runtime.Manifest = extension.manifest
    this.permissionMap.set(extension.id, {
      permissions: (manifest.permissions || []) as chrome.runtime.ManifestPermissions[],
      origins: manifest.host_permissions || [],
    })
  }

  private hasPermission = (
    extensionId: string,
    permission: chrome.runtime.ManifestPermissions,
  ): boolean => {
    const currentPermissions = this.permissionMap.get(extensionId)
    return !!currentPermissions?.permissions.includes(permission)
  }

  private contains = (
    { extension }: ExtensionEvent,
    permissions: chrome.permissions.Permissions,
  ) => {
    const currentPermissions = this.permissionMap.get(extension.id)
    if (!currentPermissions) return false
    const hasPermissions = permissions.permissions
      ? permissions.permissions.every((permission) =>
          currentPermissions.permissions.includes(permission),
        )
      : true
    const hasOrigins = permissions.origins
      ? permissions.origins.every((origin) => currentPermissions.origins.includes(origin))
      : true
    return hasPermissions && hasOrigins
  }

  private getAll = ({ extension }: ExtensionEvent) => {
    const current = this.permissionMap.get(extension.id)
    if (!current) {
      return { permissions: [], origins: [] }
    }
    return {
      permissions: [...current.permissions],
      origins: [...current.origins],
    }
  }

  private remove = ({ extension }: ExtensionEvent, permissions: chrome.permissions.Permissions) => {
    const current = this.permissionMap.get(extension.id)
    if (!current) return false

    const removedPermissions: chrome.runtime.ManifestPermissions[] = []
    const removedOrigins: string[] = []

    if (Array.isArray(permissions.permissions)) {
      for (const permission of permissions.permissions) {
        const index = current.permissions.indexOf(permission)
        if (index !== -1) {
          current.permissions.splice(index, 1)
          removedPermissions.push(permission)
        }
      }
    }

    if (Array.isArray(permissions.origins)) {
      for (const origin of permissions.origins) {
        const index = current.origins.indexOf(origin)
        if (index !== -1) {
          current.origins.splice(index, 1)
          removedOrigins.push(origin)
        }
      }
    }

    if (removedPermissions.length > 0 || removedOrigins.length > 0) {
      this.ctx.router.sendEvent(extension.id, 'permissions.onRemoved', {
        permissions: removedPermissions,
        origins: removedOrigins,
      })
      return true
    }

    return false
  }

  private request = async (
    { extension }: ExtensionEvent,
    request: chrome.permissions.Permissions,
  ) => {
    const declaredPermissions = new Set([
      ...(extension.manifest.permissions || []),
      ...(extension.manifest.optional_permissions || []),
    ])
    const declaredOrigins = new Set([
      ...(extension.manifest.host_permissions || []),
      ...((extension.manifest as chrome.runtime.ManifestV3).optional_host_permissions || []),
    ])

    if (request.permissions && !request.permissions.every((p) => declaredPermissions.has(p))) {
      throw new Error('Permissions request includes undeclared permission')
    }
    if (request.origins && !request.origins.every((o) => declaredOrigins.has(o))) {
      throw new Error('Permissions request includes undeclared origin')
    }

    const granted = await this.ctx.store.requestPermissions(extension, request)
    if (!granted) return false

    const permissions = this.permissionMap.get(extension.id)
    if (!permissions) return false
    const addedPermissions: chrome.runtime.ManifestPermissions[] = []
    const addedOrigins: string[] = []

    if (request.origins) {
      for (const origin of request.origins) {
        if (!permissions.origins.includes(origin)) {
          permissions.origins.push(origin)
          addedOrigins.push(origin)
        }
      }
    }
    if (request.permissions) {
      for (const permission of request.permissions) {
        if (!permissions.permissions.includes(permission)) {
          permissions.permissions.push(permission)
          addedPermissions.push(permission)
        }
      }
    }
    if (addedPermissions.length > 0 || addedOrigins.length > 0) {
      this.ctx.router.sendEvent(extension.id, 'permissions.onAdded', {
        permissions: addedPermissions,
        origins: addedOrigins,
      })
    }
    return true
  }
}
