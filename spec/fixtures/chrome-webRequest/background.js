/* global chrome */

const sendIpc = ({ tabId, name }) => {
  chrome.tabs.sendMessage(tabId, { type: 'send-ipc', args: [name] })
}

const transformArgs = (args, sender) => {
  const tabId = sender.tab.id

  const transformArg = (arg) => {
    if (arg && typeof arg === 'object') {
      if ('__IPC_FN__' in arg) {
        return () => {
          sendIpc({ tabId, name: arg.__IPC_FN__ })
        }
      } else {
        for (const key of Object.keys(arg)) {
          if (Object.prototype.hasOwnProperty.call(arg, key)) {
            arg[key] = transformArg(arg[key])
          }
        }
      }
    }

    return arg
  }

  return args.map(transformArg)
}

let mode = 'none'
let listener = null
let observed = []

function removeCurrentListener() {
  if (listener) {
    chrome.webRequest.onBeforeRequest.removeListener(listener)
    listener = null
  }
}

function installListener(nextMode) {
  removeCurrentListener()
  mode = nextMode || 'none'
  if (mode === 'none') return

  listener = (details) => {
    observed.push({
      url: details.url,
      method: details.method,
      type: details.type,
    })

    if (mode === 'cancel' && details.url.includes('/blocked')) {
      return { cancel: true }
    }

    if (mode === 'redirect' && details.url.includes('/blocked')) {
      return { redirectUrl: details.url.replace('/blocked', '/redirected') }
    }

    return undefined
  }

  const extras = mode === 'observe' ? [] : ['blocking']
  chrome.webRequest.onBeforeRequest.addListener(listener, { urls: ['<all_urls>'] }, extras)
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.__WEB_REQUEST_TEST__) {
    const payload = message.__WEB_REQUEST_TEST__
    switch (payload.action) {
      case 'configure':
        installListener(payload.mode)
        reply({ ok: true, mode })
        return false
      case 'clear':
        observed = []
        reply({ ok: true })
        return false
      case 'remove':
        installListener('none')
        reply({ ok: true })
        return false
      case 'events':
        reply({ events: observed.slice() })
        return false
      default:
        reply({ ok: false, error: 'Unknown action' })
        return false
    }
  }

  switch (message.type) {
    case 'api': {
      const { method, args } = message
      const [apiName, subMethod] = method.split('.')

      if (typeof chrome[apiName][subMethod] === 'function') {
        const transformedArgs = transformArgs(args, sender)
        chrome[apiName][subMethod](...transformedArgs, reply)
      }

      break
    }
    case 'event-once': {
      const { name } = message
      const [apiName, eventName] = name.split('.')

      if (typeof chrome[apiName][eventName] === 'object') {
        const event = chrome[apiName][eventName]
        event.addListener(function callback(...args) {
          reply(args)
          event.removeListener(callback)
        })
      }
      break
    }
  }

  return true
})

console.log('background-script-evaluated')
