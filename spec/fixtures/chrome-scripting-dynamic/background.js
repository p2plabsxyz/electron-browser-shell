/* global chrome */

const sendIpc = ({ tabId, name }) => {
  chrome.tabs.sendMessage(tabId, { type: 'send-ipc', args: [name] })
}

const transformArgs = (args, sender) => {
  const tabId = sender.tab?.id

  const transformArg = (arg) => {
    if (arg && typeof arg === 'object') {
      if ('__IPC_FN__' in arg) {
        return () => {
          if (typeof tabId === 'number') {
            sendIpc({ tabId, name: arg.__IPC_FN__ })
          }
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

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  switch (message.type) {
    case 'api': {
      const { method, args } = message
      const [apiName, subMethod] = method.split('.')

      if (typeof chrome[apiName]?.[subMethod] === 'function') {
        const transformedArgs = transformArgs(args, sender)
        chrome[apiName][subMethod](...transformedArgs, reply)
      } else {
        reply(null)
      }
      break
    }

    case 'event-once': {
      const { name } = message
      const [apiName, eventName] = name.split('.')
      if (typeof chrome[apiName]?.[eventName] === 'object') {
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
