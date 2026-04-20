import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'

export class CommandsAPI {
  private commandMap = new Map</* extensionId */ string, chrome.commands.Command[]>()

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('commands.getAll', this.getAll)

    const sessionExtensions = ctx.session.extensions || ctx.session
    sessionExtensions.getAllExtensions().forEach((extension) => {
      this.processExtension(extension)
    })

    sessionExtensions.on('extension-loaded', (_event, extension) => {
      this.processExtension(extension)
    })

    sessionExtensions.on('extension-unloaded', (_event, extension) => {
      this.removeCommands(extension)
    })
  }

  private processExtension(extension: Electron.Extension) {
    const manifest: chrome.runtime.Manifest = extension.manifest
    if (!manifest.commands) {
      this.commandMap.delete(extension.id)
      return
    }

    const commands: chrome.commands.Command[] = []

    for (const [name, details] of Object.entries(manifest.commands!)) {
      const manifestCommand = details as {
        description?: string
        suggested_key?: { default?: string }
      }
      commands.push({
        name,
        description: manifestCommand.description,
        shortcut: manifestCommand.suggested_key?.default || '',
      })
    }

    this.commandMap.set(extension.id, commands)
  }

  private removeCommands(extension: Electron.Extension) {
    this.commandMap.delete(extension.id)
  }

  private getAll = ({ extension }: ExtensionEvent): chrome.commands.Command[] => {
    return this.commandMap.get(extension.id) || []
  }
}
