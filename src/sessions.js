const { Client, LocalAuth } = require('whatsapp-web.js')
// Pull official injected helpers to force-load when needed
let ExposeStore, ExposeLegacyStore, LoadUtils
try {
  ({ ExposeStore } = require('whatsapp-web.js/src/util/Injected/Store'))
  ;({ ExposeLegacyStore } = require('whatsapp-web.js/src/util/Injected/LegacyStore'))
  ;({ LoadUtils } = require('whatsapp-web.js/src/util/Injected/Utils'))
} catch (_) { /* optional; fallback to our light shims */ }
const fs = require('fs')
const path = require('path')
const sessions = new Map()
const { baseWebhookURL, sessionFolderPath, maxAttachmentSize, setMessagesAsSeen, webVersion, webVersionCacheType, recoverSessions, chromeBin, headless, releaseBrowserLock, emitSelf } = require('./config')
const { triggerWebhook, waitForNestedObject, isEventEnabled, sendMessageSeenStatus, sleep } = require('./utils')
const { logger } = require('./logger')
const { initWebSocketServer, terminateWebSocketServer, triggerWebSocket } = require('./websocket')

// Function to validate if the session is ready
const validateSession = async (sessionId) => {
  try {
    const returnData = { success: false, state: null, message: '' }

    // Session not Connected 😢
    if (!sessions.has(sessionId) || !sessions.get(sessionId)) {
      returnData.message = 'session_not_found'
      return returnData
    }

    const client = sessions.get(sessionId)
    // wait until the client is created
    await waitForNestedObject(client, 'pupPage')
      .catch((err) => { return { success: false, state: null, message: err.message } })

    // Wait for client.pupPage to be evaluable
    let maxRetry = 0
    while (true) {
      try {
        if (client.pupPage.isClosed()) {
          return { success: false, state: null, message: 'browser tab closed' }
        }
        await Promise.race([
          client.pupPage.evaluate('1'),
          new Promise(resolve => setTimeout(resolve, 1000))
        ])
        break
      } catch (error) {
        if (maxRetry === 2) {
          return { success: false, state: null, message: 'session closed' }
        }
        maxRetry++
      }
    }

    const state = await client.getState()
    returnData.state = state
    if (state !== 'CONNECTED') {
      returnData.message = 'session_not_connected'
      return returnData
    }

    // Session Connected 🎉
    returnData.success = true
    returnData.message = 'session_connected'
    return returnData
  } catch (error) {
    logger.error({ sessionId, err: error }, 'Failed to validate session')
    return { success: false, state: null, message: error.message }
  }
}

// Function to handle client session restoration
const restoreSessions = () => {
  try {
    if (!fs.existsSync(sessionFolderPath)) {
      fs.mkdirSync(sessionFolderPath) // Create the session directory if it doesn't exist
    }
    // Read the contents of the folder
    fs.readdir(sessionFolderPath, async (_, files) => {
      // Iterate through the files in the parent folder
      for (const file of files) {
        // Use regular expression to extract the string from the folder name
        const match = file.match(/^session-(.+)$/)
        if (match) {
          const sessionId = match[1]
          logger.warn({ sessionId }, 'Existing session detected')
          await setupSession(sessionId)
        }
      }
    })
  } catch (error) {
    logger.error(error, 'Failed to restore sessions')
  }
}

// Setup Session
const setupSession = async (sessionId) => {
  try {
    if (sessions.has(sessionId)) {
      return { success: false, message: `Session already exists for: ${sessionId}`, client: sessions.get(sessionId) }
    }
    logger.info({ sessionId }, 'Session is being initiated')
    // Disable the delete folder from the logout function (will be handled separately)
    const localAuth = new LocalAuth({ clientId: sessionId, dataPath: sessionFolderPath })
    delete localAuth.logout
    localAuth.logout = () => { }

  const clientOptions = {
      puppeteer: {
        executablePath: chromeBin,
        headless,
        args: [
          '--autoplay-policy=user-gesture-required',
          '--disable-background-networking',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-breakpad',
          '--disable-client-side-phishing-detection',
          '--disable-component-update',
          '--disable-default-apps',
          '--disable-dev-shm-usage',
          '--disable-domain-reliability',
          '--disable-extensions',
          '--disable-features=AudioServiceOutOfProcess',
          '--disable-hang-monitor',
          '--disable-ipc-flooding-protection',
          '--disable-notifications',
          '--disable-offer-store-unmasked-wallet-cards',
          '--disable-popup-blocking',
          '--disable-print-preview',
          '--disable-prompt-on-repost',
          '--disable-renderer-backgrounding',
          '--disable-speech-api',
          '--disable-sync',
          '--disable-gpu',
          '--disable-accelerated-2d-canvas',
          '--hide-scrollbars',
          '--ignore-gpu-blacklist',
          '--metrics-recording-only',
          '--mute-audio',
          '--no-default-browser-check',
          '--no-first-run',
          '--no-pings',
          '--no-zygote',
          '--password-store=basic',
          '--use-gl=swiftshader',
          '--use-mock-keychain',
          '--disable-setuid-sandbox',
          '--no-sandbox',
          '--disable-blink-features=AutomationControlled'
        ]
  },
  authStrategy: localAuth,
  // make sure 'message' event fires for self messages when requested
  emitSelf
    }

    if (webVersion) {
      clientOptions.webVersion = webVersion
      switch (webVersionCacheType.toLowerCase()) {
        case 'local':
          clientOptions.webVersionCache = {
            type: 'local'
          }
          break
        case 'remote':
          clientOptions.webVersionCache = {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/' + webVersion + '.html'
          }
          break
        default:
          clientOptions.webVersionCache = {
            type: 'none'
          }
      }
    }

    const client = new Client(clientOptions)
    if (releaseBrowserLock) {
      // See https://github.com/puppeteer/puppeteer/issues/4860
      const singletonLockPath = path.resolve(path.join(sessionFolderPath, `session-${sessionId}`, 'SingletonLock'))
      const singletonLockExists = await fs.promises.lstat(singletonLockPath).then(() => true).catch(() => false)
      if (singletonLockExists) {
        logger.warn({ sessionId }, 'Browser lock file exists, removing')
        await fs.promises.unlink(singletonLockPath)
      }
    }

    // helper to inject WWebJS.getChat safely
    const injectGetChat = () => client.pupPage?.evaluate(() => {
      try {
        window.Store.FindOrCreateChat = window.require('WAWebFindChatAction')
      } catch (e) {
        // ignore if module is not present
      }
      try {
        window.Store.WidFactory = window.Store.WidFactory || window.require('WAWebWidFactory')
      } catch (_) { }
      // Ensure namespace exists
      window.WWebJS = window.WWebJS || {}
      window.Store = window.Store || {}
      // Ensure User module (provides getMaybeMeUser) exists
      try {
        if (!window.Store.User || typeof window.Store.User.getMaybeMeUser !== 'function') {
          window.Store.User = window.require('WAWebUserPrefsMeUser')
        }
      } catch (_) { }
      // Polyfill missing me getters from ContactCollection if still absent
      try {
        if (!window.Store.User) window.Store.User = {}
        if (typeof window.Store.User.getMaybeMeUser !== 'function') {
          window.Store.User.getMaybeMeUser = () => {
            try {
              const me = window.Store.ContactCollection?.getMeContact?.()
              if (me?.id) return me.id
            } catch (_) {}
            return null
          }
        }
        if (typeof window.Store.User.getMaybeMeLidUser !== 'function') {
          window.Store.User.getMaybeMeLidUser = () => {
            try {
              const me = window.Store.ContactCollection?.getMeContact?.()
              if (me?.id) {
                if (typeof me.id.isLid === 'function' && me.id.isLid()) return me.id
                const user = me.id.user || (me.id._serialized?.split('@')[0])
                if (user && window.Store.WidFactory?.createWid) return window.Store.WidFactory.createWid(`${user}@lid`)
              }
            } catch (_) {}
            return null
          }
        }
      } catch (_) { }
      // Ensure base collections (including Chat) are present
      try {
        const collections = window.require('WAWebCollections')
        if (collections) {
          Object.keys(collections).forEach((key) => {
            if (!(key in window.Store)) {
              window.Store[key] = collections[key]
            }
          })
        }
      } catch (_) { }
      // Shim AppState access between Store and AuthStore, and provide safe default
      try {
        window.AuthStore = window.AuthStore || {}
        if (!window.Store.AppState && window.AuthStore?.AppState) {
          window.Store.AppState = window.AuthStore.AppState
        }
        if (!window.AuthStore.AppState && window.Store?.AppState) {
          window.AuthStore.AppState = window.Store.AppState
        }
        if (!window.Store.AppState) {
          window.Store.AppState = { state: 'UNKNOWN' }
        }
      } catch (_) { }
      // Ensure Store.SendSeen exists
      try {
        if (!window.Store.SendSeen && window.mR?.findModule) {
          const mod = window.mR.findModule('sendSeen')
          if (Array.isArray(mod) && mod[0]) {
            window.Store.SendSeen = mod[0]
          }
        }
      } catch (_) { }
  if (!window.WWebJS.getChat && window.Store?.WidFactory?.createWid && (window.Store?.Chat?.get || window.Store?.Chat?.find)) {
        window.WWebJS.getChat = async (chatId, { getAsModel = true } = {}) => {
          const isChannel = /@\w*newsletter\b/.test(chatId)
          const chatWid = window.Store.WidFactory.createWid(chatId)
          let chat

          if (isChannel) {
            try {
              chat = window.Store.NewsletterCollection.get(chatId)
              if (!chat) {
                await window.Store.ChannelUtils.loadNewsletterPreviewChat(chatId)
                chat = await window.Store.NewsletterCollection.find(chatWid)
              }
            } catch (err) {
              chat = null
            }
          } else {
            chat = window.Store.Chat.get(chatWid) || (await window.Store.Chat.find(chatWid))
          }

          return getAsModel && chat && window.WWebJS.getChatModel
            ? await window.WWebJS.getChatModel(chat, { isChannel })
            : chat
        }
      }
  if (!window.WWebJS.sendSeen) {
        window.WWebJS.sendSeen = async (chatId) => {
          try {
            const chat = await window.WWebJS.getChat?.(chatId, { getAsModel: false })
            if (!chat) return false
            if (window.Store?.SendSeen?.sendSeen) {
              await window.Store.SendSeen.sendSeen(chat)
              return true
            }
            return false
          } catch (_) {
            return false
          }
        }
      }
    }).catch(() => { })

    try {
      // set listener before initialize to avoid missing the event
      client.on('ready', () => injectGetChat())
      await client.initialize()
      // also inject immediately (idempotent) in case ready already fired
      await injectGetChat()
      // Proactively load official Store/Utils if not yet injected by the library
      try {
        if (ExposeStore) await client.pupPage?.evaluate(ExposeStore)
      } catch (_) { }
      try {
        if (ExposeLegacyStore) await client.pupPage?.evaluate(ExposeLegacyStore)
      } catch (_) { }
      try {
        if (LoadUtils) await client.pupPage?.evaluate(LoadUtils)
      } catch (_) { }
    } catch (error) {
      logger.error({ sessionId, err: error }, 'Initialize error')
      throw error
    }

    initWebSocketServer(sessionId)
    initializeEvents(client, sessionId)

    // Save the session to the Map
    sessions.set(sessionId, client)
    return { success: true, message: 'Session initiated successfully', client }
  } catch (error) {
    return { success: false, message: error.message, client: null }
  }
}

const initializeEvents = (client, sessionId) => {
  // check if the session webhook is overridden
  const sessionWebhook = process.env[sessionId.toUpperCase() + '_WEBHOOK_URL'] || baseWebhookURL

  if (recoverSessions) {
    waitForNestedObject(client, 'pupPage').then(() => {
      const restartSession = async (sessionId) => {
        sessions.delete(sessionId)
        await client.destroy().catch(e => { })
        await setupSession(sessionId)
      }
      client.pupPage.once('close', function () {
        // emitted when the page closes
        logger.warn({ sessionId }, 'Browser page closed. Restoring')
        restartSession(sessionId)
      })
      client.pupPage.once('error', function () {
        // emitted when the page crashes
        logger.warn({ sessionId }, 'Error occurred on browser page. Restoring')
        restartSession(sessionId)
      })
    }).catch(e => { })
  }

  if (isEventEnabled('auth_failure')) {
    client.on('auth_failure', (msg) => {
  try { logger.warn({ sessionId, msg }, 'Auth failure') } catch (_) {}
  ;(async () => { try { await triggerWebhook(sessionWebhook, sessionId, 'status', { msg }) } catch (_) {} })()
      triggerWebSocket(sessionId, 'status', { msg })
    })
  }

    // Log enabled/disabled events snapshot for diagnostics
    try {
      logger.info({
        sessionId,
        events: {
          message: isEventEnabled('message'),
          message_create: isEventEnabled('message_create'),
          message_ack: isEventEnabled('message_ack'),
          message_reaction: isEventEnabled('message_reaction'),
          message_edit: isEventEnabled('message_edit'),
          message_ciphertext: isEventEnabled('message_ciphertext')
        }
      }, 'Events enabled state')
    } catch (_) {}

  if (isEventEnabled('authenticated')) {
    client.qr = null
    client.on('authenticated', () => {
  try { logger.info({ sessionId }, 'Authenticated') } catch (_) {}
  ;(async () => { try { await triggerWebhook(sessionWebhook, sessionId, 'authenticated') } catch (_) {} })()
      triggerWebSocket(sessionId, 'authenticated')
    })
  }

  if (isEventEnabled('call')) {
    client.on('call', (call) => {
  try { logger.info({ sessionId, id: call?._serialized || call?.id, isGroup: !!call?.isGroup, isVideo: !!call?.isVideo }, 'Incoming call event') } catch (_) {}
  ;(async () => { try { await triggerWebhook(sessionWebhook, sessionId, 'call', { call }) } catch (_) {} })()
      triggerWebSocket(sessionId, 'call', { call })
    })
  }

  if (isEventEnabled('change_state')) {
    client.on('change_state', state => {
  try { logger.info({ sessionId, state }, 'State changed') } catch (_) {}
  ;(async () => { try { await triggerWebhook(sessionWebhook, sessionId, 'change_state', { state }) } catch (_) {} })()
      triggerWebSocket(sessionId, 'change_state', { state })
    })
  }

  if (isEventEnabled('disconnected')) {
    client.on('disconnected', (reason) => {
  try { logger.warn({ sessionId, reason }, 'Disconnected') } catch (_) {}
  ;(async () => { try { await triggerWebhook(sessionWebhook, sessionId, 'disconnected', { reason }) } catch (_) {} })()
      triggerWebSocket(sessionId, 'disconnected', { reason })
    })
  }

  if (isEventEnabled('group_join')) {
    client.on('group_join', (notification) => {
  try { logger.info({ sessionId, chatId: notification?.id?.remote }, 'Group join') } catch (_) {}
  ;(async () => { try { await triggerWebhook(sessionWebhook, sessionId, 'group_join', { notification }) } catch (_) {} })()
      triggerWebSocket(sessionId, 'group_join', { notification })
    })
  }

  if (isEventEnabled('group_leave')) {
    client.on('group_leave', (notification) => {
  try { logger.info({ sessionId, chatId: notification?.id?.remote }, 'Group leave') } catch (_) {}
  ;(async () => { try { await triggerWebhook(sessionWebhook, sessionId, 'group_leave', { notification }) } catch (_) {} })()
      triggerWebSocket(sessionId, 'group_leave', { notification })
    })
  }

  if (isEventEnabled('group_admin_changed')) {
    client.on('group_admin_changed', (notification) => {
  try { logger.info({ sessionId, chatId: notification?.id?.remote }, 'Group admin changed') } catch (_) {}
  ;(async () => { try { await triggerWebhook(sessionWebhook, sessionId, 'group_admin_changed', { notification }) } catch (_) {} })()
      triggerWebSocket(sessionId, 'group_admin_changed', { notification })
    })
  }

  if (isEventEnabled('group_membership_request')) {
    client.on('group_membership_request', (notification) => {
  try { logger.info({ sessionId, chatId: notification?.id?.remote }, 'Group membership request') } catch (_) {}
  ;(async () => { try { await triggerWebhook(sessionWebhook, sessionId, 'group_membership_request', { notification }) } catch (_) {} })()
      triggerWebSocket(sessionId, 'group_membership_request', { notification })
    })
  }

  if (isEventEnabled('group_update')) {
    client.on('group_update', (notification) => {
  try { logger.info({ sessionId, chatId: notification?.id?.remote }, 'Group update') } catch (_) {}
  ;(async () => { try { await triggerWebhook(sessionWebhook, sessionId, 'group_update', { notification }) } catch (_) {} })()
      triggerWebSocket(sessionId, 'group_update', { notification })
    })
  }

  if (isEventEnabled('loading_screen')) {
    client.on('loading_screen', (percent, message) => {
  try { logger.info({ sessionId, percent, message }, 'Loading screen') } catch (_) {}
  ;(async () => { try { await triggerWebhook(sessionWebhook, sessionId, 'loading_screen', { percent, message }) } catch (_) {} })()
      triggerWebSocket(sessionId, 'loading_screen', { percent, message })
    })
  }

  if (isEventEnabled('media_uploaded')) {
    client.on('media_uploaded', (message) => {
  try { logger.info({ sessionId, id: message?.id?._serialized }, 'Media uploaded') } catch (_) {}
  ;(async () => { try { await triggerWebhook(sessionWebhook, sessionId, 'media_uploaded', { message }) } catch (_) {} })()
      triggerWebSocket(sessionId, 'media_uploaded', { message })
    })
  }

  client.on('message', async (message) => {
    try {
      const { logIncomingBodies } = require('./config')
      logger.info({
        sessionId,
        event: 'message',
        fromMe: !!message?.fromMe,
        id: message?.id?._serialized,
        chatId: message?.from,
        type: message?.type,
        hasMedia: !!message?.hasMedia,
        body: logIncomingBodies ? (typeof message?.body === 'string' ? message.body : '') : undefined
      }, 'Message event fired')
    } catch (_) {}
    if (isEventEnabled('message')) {
  ;(async () => { try { await triggerWebhook(sessionWebhook, sessionId, 'message', { message }) } catch (_) {} })()
      triggerWebSocket(sessionId, 'message', { message })
      if (message.hasMedia && message._data?.size < maxAttachmentSize) {
      // custom service event
        if (isEventEnabled('media')) {
          message.downloadMedia().then(messageMedia => {
            ;(async () => { try { await triggerWebhook(sessionWebhook, sessionId, 'media', { messageMedia, message }) } catch (_) {} })()
            triggerWebSocket(sessionId, 'media', { messageMedia, message })
          }).catch(error => {
            logger.error({ sessionId, err: error }, 'Failed to download media')
          })
        }
      }
    }
    // Only mark as seen for incoming messages to avoid unnecessary eval on outgoing
    if (setMessagesAsSeen && message && !message.fromMe) {
      // small delay to ensure the message is processed before sending seen status
      await sleep(1000)
      sendMessageSeenStatus(message)
    }
  })

  if (isEventEnabled('message_ack')) {
    client.on('message_ack', (message, ack) => {
  try { logger.info({ sessionId, id: message?.id?._serialized, ack }, 'Message ack') } catch (_) {}
  ;(async () => { try { await triggerWebhook(sessionWebhook, sessionId, 'message_ack', { message, ack }) } catch (_) {} })()
      triggerWebSocket(sessionId, 'message_ack', { message, ack })
    })
  }

  if (isEventEnabled('message_create')) {
    client.on('message_create', (message) => {
      try {
        const body = typeof message?.body === 'string' ? message.body : ''
        const snippet = body.length > 200 ? body.slice(0, 200) + '…' : body
        logger.info({
          sessionId,
          event: 'message_create',
          fromMe: !!message?.fromMe,
          id: message?.id?._serialized,
          chatId: message?.from,
          type: message?.type,
          hasMedia: !!message?.hasMedia,
          bodyLength: body.length || 0,
          bodySnippet: snippet
        }, 'Message create')
      } catch (_) {}
  ;(async () => { try { await triggerWebhook(sessionWebhook, sessionId, 'message_create', { message }) } catch (_) {} })()
      triggerWebSocket(sessionId, 'message_create', { message })
    })
  }

  if (isEventEnabled('message_reaction')) {
    client.on('message_reaction', (reaction) => {
  try { logger.info({ sessionId, id: reaction?.msgKey?._serialized, emoji: reaction?.reaction || reaction?.text }, 'Message reaction') } catch (_) {}
  ;(async () => { try { await triggerWebhook(sessionWebhook, sessionId, 'message_reaction', { reaction }) } catch (_) {} })()
      triggerWebSocket(sessionId, 'message_reaction', { reaction })
    })
  }

  if (isEventEnabled('message_edit')) {
    client.on('message_edit', (message, newBody, prevBody) => {
  try { logger.info({ sessionId, id: message?.id?._serialized, newLen: (newBody||'').length, prevLen: (prevBody||'').length }, 'Message edit') } catch (_) {}
      ;(async () => { try { await triggerWebhook(sessionWebhook, sessionId, 'message_edit', { message, newBody, prevBody }) } catch (_) {} })()
      triggerWebSocket(sessionId, 'message_edit', { message, newBody, prevBody })
    })
  }

  if (isEventEnabled('message_ciphertext')) {
    client.on('message_ciphertext', (message) => {
  try { logger.info({ sessionId, id: message?.id?._serialized }, 'Message ciphertext') } catch (_) {}
  ;(async () => { try { await triggerWebhook(sessionWebhook, sessionId, 'message_ciphertext', { message }) } catch (_) {} })()
      triggerWebSocket(sessionId, 'message_ciphertext', { message })
    })
  }

  if (isEventEnabled('message_revoke_everyone')) {
    client.on('message_revoke_everyone', (message) => {
  try { logger.info({ sessionId, id: message?.id?._serialized }, 'Message revoke everyone') } catch (_) {}
  ;(async () => { try { await triggerWebhook(sessionWebhook, sessionId, 'message_revoke_everyone', { message }) } catch (_) {} })()
      triggerWebSocket(sessionId, 'message_revoke_everyone', { message })
    })
  }

  if (isEventEnabled('message_revoke_me')) {
    client.on('message_revoke_me', (message, revokedMsg) => {
  try { logger.info({ sessionId, id: message?.id?._serialized, revokedId: revokedMsg?.id?._serialized }, 'Message revoke me') } catch (_) {}
  ;(async () => { try { await triggerWebhook(sessionWebhook, sessionId, 'message_revoke_me', { message, revokedMsg }) } catch (_) {} })()
      triggerWebSocket(sessionId, 'message_revoke_me', { message, revokedMsg })
    })
  }

  client.on('qr', (qr) => {
    // by default QR code is being updated every 20 seconds
    if (client.qrClearTimeout) {
      clearTimeout(client.qrClearTimeout)
    }
    // inject qr code into session
    client.qr = qr
    client.qrClearTimeout = setTimeout(() => {
      if (client.qr) {
        logger.warn({ sessionId }, 'Removing expired QR code')
        client.qr = null
      }
    }, 30000)
    if (isEventEnabled('qr')) {
  try { logger.info({ sessionId }, 'QR updated') } catch (_) {}
  ;(async () => { try { await triggerWebhook(sessionWebhook, sessionId, 'qr', { qr }) } catch (_) {} })()
      triggerWebSocket(sessionId, 'qr', { qr })
    }
  })

  if (isEventEnabled('ready')) {
    client.on('ready', () => {
  try { logger.info({ sessionId }, 'Client ready') } catch (_) {}
  ;(async () => { try { await triggerWebhook(sessionWebhook, sessionId, 'ready') } catch (_) {} })()
      triggerWebSocket(sessionId, 'ready')
    })
  }

  if (isEventEnabled('contact_changed')) {
    client.on('contact_changed', (message, oldId, newId, isContact) => {
  try { logger.info({ sessionId, oldId, newId, isContact }, 'Contact changed') } catch (_) {}
  ;(async () => { try { await triggerWebhook(sessionWebhook, sessionId, 'contact_changed', { message, oldId, newId, isContact }) } catch (_) {} })()
      triggerWebSocket(sessionId, 'contact_changed', { message, oldId, newId, isContact })
    })
  }

  if (isEventEnabled('chat_removed')) {
    client.on('chat_removed', (chat) => {
  try { logger.info({ sessionId, id: chat?.id?._serialized }, 'Chat removed') } catch (_) {}
  ;(async () => { try { await triggerWebhook(sessionWebhook, sessionId, 'chat_removed', { chat }) } catch (_) {} })()
      triggerWebSocket(sessionId, 'chat_removed', { chat })
    })
  }

  if (isEventEnabled('chat_archived')) {
    client.on('chat_archived', (chat, currState, prevState) => {
  try { logger.info({ sessionId, id: chat?.id?._serialized, currState, prevState }, 'Chat archived') } catch (_) {}
  ;(async () => { try { await triggerWebhook(sessionWebhook, sessionId, 'chat_archived', { chat, currState, prevState }) } catch (_) {} })()
      triggerWebSocket(sessionId, 'chat_archived', { chat, currState, prevState })
    })
  }

  if (isEventEnabled('unread_count')) {
    client.on('unread_count', (chat) => {
  try { logger.info({ sessionId, id: chat?.id?._serialized, unreadCount: chat?.unreadCount }, 'Unread count') } catch (_) {}
  ;(async () => { try { await triggerWebhook(sessionWebhook, sessionId, 'unread_count', { chat }) } catch (_) {} })()
      triggerWebSocket(sessionId, 'unread_count', { chat })
    })
  }

  if (isEventEnabled('vote_update')) {
    client.on('vote_update', (vote) => {
  try { logger.info({ sessionId, pollId: vote?.pollUpdateMessageKey?._serialized }, 'Vote update') } catch (_) {}
  ;(async () => { try { await triggerWebhook(sessionWebhook, sessionId, 'vote_update', { vote }) } catch (_) {} })()
      triggerWebSocket(sessionId, 'vote_update', { vote })
    })
  }

  if (isEventEnabled('code')) {
    client.on('code', (code) => {
  try { logger.info({ sessionId }, '2FA code requested') } catch (_) {}
  ;(async () => { try { await triggerWebhook(sessionWebhook, sessionId, 'code', { code }) } catch (_) {} })()
      triggerWebSocket(sessionId, 'code', { code })
    })
  }
}

// Function to delete client session folder
const deleteSessionFolder = async (sessionId) => {
  try {
    const targetDirPath = path.join(sessionFolderPath, `session-${sessionId}`)
    const resolvedTargetDirPath = await fs.promises.realpath(targetDirPath)
    const resolvedSessionPath = await fs.promises.realpath(sessionFolderPath)

    // Ensure the target directory path ends with a path separator
    const safeSessionPath = `${resolvedSessionPath}${path.sep}`

    // Validate the resolved target directory path is a subdirectory of the session folder path
    if (!resolvedTargetDirPath.startsWith(safeSessionPath)) {
      throw new Error('Invalid path: Directory traversal detected')
    }
    await fs.promises.rm(resolvedTargetDirPath, { recursive: true, force: true })
  } catch (error) {
    logger.error({ sessionId, err: error }, 'Folder deletion error')
    throw error
  }
}

// Function to reload client session without removing browser cache
const reloadSession = async (sessionId) => {
  try {
    const client = sessions.get(sessionId)
    if (!client) {
  return
    }
    client.pupPage?.removeAllListeners('close')
    client.pupPage?.removeAllListeners('error')
    try {
      const pages = await client.pupBrowser.pages()
      await Promise.all(pages.map((page) => page.close()))
      await Promise.race([
        client.pupBrowser.close(),
        new Promise(resolve => setTimeout(resolve, 5000))
      ])
    } catch (e) {
      const childProcess = client.pupBrowser.process()
      if (childProcess) {
  childProcess.kill(9)
      }
    }
    sessions.delete(sessionId)
    await setupSession(sessionId)
  } catch (error) {
    logger.error({ sessionId, err: error }, 'Failed to reload session')
    throw error
  }
}

// Ensure helper functions are available inside browser context
const ensurePageHelpers = async (client) => {
  try {
    if (!client?.pupPage) return
    // Try to load the official Store/Utils first; ignore errors (will be retried)
  try { if (ExposeStore) await client.pupPage.evaluate(ExposeStore) } catch (_) { }
  try { if (ExposeLegacyStore) await client.pupPage.evaluate(ExposeLegacyStore) } catch (_) { }
  try { if (LoadUtils) await client.pupPage.evaluate(LoadUtils) } catch (_) { }
    await client.pupPage.evaluate(() => {
      try {
        window.Store.FindOrCreateChat = window.require('WAWebFindChatAction')
      } catch (e) {
        // ignore
      }
      try {
        window.Store.WidFactory = window.Store.WidFactory || window.require('WAWebWidFactory')
      } catch (_) { }
      window.WWebJS = window.WWebJS || {}
      window.Store = window.Store || {}
      try {
        if (!window.Store.User || typeof window.Store.User.getMaybeMeUser !== 'function') {
          window.Store.User = window.require('WAWebUserPrefsMeUser')
        }
      } catch (_) { }
      try {
        if (!window.Store.User) window.Store.User = {}
        if (typeof window.Store.User.getMaybeMeUser !== 'function') {
          window.Store.User.getMaybeMeUser = () => {
            try {
              const me = window.Store.ContactCollection?.getMeContact?.()
              if (me?.id) return me.id
            } catch (_) {}
            return null
          }
        }
        if (typeof window.Store.User.getMaybeMeLidUser !== 'function') {
          window.Store.User.getMaybeMeLidUser = () => {
            try {
              const me = window.Store.ContactCollection?.getMeContact?.()
              if (me?.id) {
                if (typeof me.id.isLid === 'function' && me.id.isLid()) return me.id
                const user = me.id.user || (me.id._serialized?.split('@')[0])
                if (user && window.Store.WidFactory?.createWid) return window.Store.WidFactory.createWid(`${user}@lid`)
              }
            } catch (_) {}
            return null
          }
        }
      } catch (_) { }
      try {
        const collections = window.require('WAWebCollections')
        if (collections) {
          Object.keys(collections).forEach((key) => {
            if (!(key in window.Store)) {
              window.Store[key] = collections[key]
            }
          })
        }
      } catch (_) { }
      try {
        window.AuthStore = window.AuthStore || {}
        if (!window.Store.AppState && window.AuthStore?.AppState) {
          window.Store.AppState = window.AuthStore.AppState
        }
        if (!window.AuthStore.AppState && window.Store?.AppState) {
          window.AuthStore.AppState = window.Store.AppState
        }
        if (!window.Store.AppState) {
          window.Store.AppState = { state: 'UNKNOWN' }
        }
      } catch (_) { }
      try {
        if (!window.Store.SendSeen && window.mR?.findModule) {
          const mod = window.mR.findModule('sendSeen')
          if (Array.isArray(mod) && mod[0]) {
            window.Store.SendSeen = mod[0]
          }
        }
      } catch (_) { }
  if (!window.WWebJS.getChat && window.Store?.WidFactory?.createWid && (window.Store?.Chat?.get || window.Store?.Chat?.find)) {
        window.WWebJS.getChat = async (chatId, { getAsModel = true } = {}) => {
          const isChannel = /@\w*newsletter\b/.test(chatId)
          const chatWid = window.Store.WidFactory.createWid(chatId)
          let chat
          if (isChannel) {
            try {
              chat = window.Store.NewsletterCollection.get(chatId)
              if (!chat) {
                await window.Store.ChannelUtils.loadNewsletterPreviewChat(chatId)
                chat = await window.Store.NewsletterCollection.find(chatWid)
              }
            } catch (err) {
              chat = null
            }
          } else {
            chat = window.Store.Chat.get(chatWid) || (await window.Store.Chat.find(chatWid))
          }
      return getAsModel && chat && window.WWebJS.getChatModel
    ? await window.WWebJS.getChatModel(chat, { isChannel })
    : chat
        }
      }
  if (!window.WWebJS.sendSeen) {
        window.WWebJS.sendSeen = async (chatId) => {
          try {
            const chat = await window.WWebJS.getChat?.(chatId, { getAsModel: false })
            if (!chat) return false
            if (window.Store?.SendSeen?.sendSeen) {
              await window.Store.SendSeen.sendSeen(chat)
              return true
            }
            return false
          } catch (_) {
            return false
          }
        }
      }
    }).catch(() => { })
  } catch (_) { }
}

// Ensure Store.User has getMaybeMeUser/getMaybeMeLidUser available
const ensureWWebUser = async (client) => {
  try {
    if (!client?.pupPage) return false
    return await client.pupPage.evaluate(() => {
      try {
        if (!window.Store) window.Store = {}
        if (!window.Store.User || typeof window.Store.User.getMaybeMeUser !== 'function' || typeof window.Store.User.getMaybeMeLidUser !== 'function') {
          try {
            const mod = window.require && window.require('WAWebUserPrefsMeUser')
            if (mod) {
              window.Store.User = window.Store.User || {}
              // merge without overwriting existing keys
              Object.keys(mod).forEach(k => { if (!(k in window.Store.User)) window.Store.User[k] = mod[k] })
            }
          } catch (_) {}
          if ((!window.Store.User || typeof window.Store.User.getMaybeMeUser !== 'function') && window.mR?.findModule) {
            try {
              const arr = window.mR.findModule('getMaybeMeUser')
              if (Array.isArray(arr) && arr[0]) {
                const mod2 = arr[0]
                window.Store.User = window.Store.User || {}
                Object.keys(mod2).forEach(k => { if (!(k in window.Store.User)) window.Store.User[k] = mod2[k] })
              }
            } catch (_) {}
          }
          // As last resort, polyfill getters via ContactCollection
          try {
            if (!window.Store.User) window.Store.User = {}
            if (typeof window.Store.User.getMaybeMeUser !== 'function') {
              window.Store.User.getMaybeMeUser = () => {
                try {
                  const me = window.Store.ContactCollection?.getMeContact?.()
                  if (me?.id) return me.id
                } catch (_) {}
                return null
              }
            }
            if (typeof window.Store.User.getMaybeMeLidUser !== 'function') {
              window.Store.User.getMaybeMeLidUser = () => {
                try {
                  const me = window.Store.ContactCollection?.getMeContact?.()
                  if (me?.id) {
                    if (typeof me.id.isLid === 'function' && me.id.isLid()) return me.id
                    const user = me.id.user || (me.id._serialized?.split('@')[0])
                    if (user && window.Store.WidFactory?.createWid) return window.Store.WidFactory.createWid(`${user}@lid`)
                  }
                } catch (_) {}
                return null
              }
            }
          } catch (_) { }
        }
      } catch (_) {}
      return !!(window.Store?.User && typeof window.Store.User.getMaybeMeUser === 'function' && typeof window.Store.User.getMaybeMeLidUser === 'function')
    })
  } catch (_) { return false }
}

// Wait until the browser context has Store.WidFactory and WWebJS.getChat available
const ensureWWebReady = async (client, timeoutMs = 5000) => {
  try {
    if (!client?.pupPage) return false
    // Attempt to inject official Store/Utils before waiting
  try { if (ExposeStore) await client.pupPage.evaluate(ExposeStore) } catch (_) { }
  try { if (ExposeLegacyStore) await client.pupPage.evaluate(ExposeLegacyStore) } catch (_) { }
  try { if (LoadUtils) await client.pupPage.evaluate(LoadUtils) } catch (_) { }
    const result = await client.pupPage.evaluate(async (timeoutMs) => {
      const start = Date.now()
      while (true) {
        try {
          if (!window.Store?.User || typeof window.Store.User.getMaybeMeUser !== 'function' || typeof window.Store.User.getMaybeMeLidUser !== 'function') {
            try {
              const mod = window.require && window.require('WAWebUserPrefsMeUser')
              if (mod) {
                window.Store.User = window.Store.User || {}
                Object.keys(mod).forEach(k => { if (!(k in window.Store.User)) window.Store.User[k] = mod[k] })
              }
            } catch (_) {}
            if ((!window.Store.User || typeof window.Store.User.getMaybeMeUser !== 'function') && window.mR?.findModule) {
              try {
                const arr = window.mR.findModule('getMaybeMeUser')
                if (Array.isArray(arr) && arr[0]) {
                  const mod2 = arr[0]
                  window.Store.User = window.Store.User || {}
                  Object.keys(mod2).forEach(k => { if (!(k in window.Store.User)) window.Store.User[k] = mod2[k] })
                }
              } catch (_) {}
            }
            // As last resort, polyfill getters via ContactCollection
            try {
              if (!window.Store.User) window.Store.User = {}
              if (typeof window.Store.User.getMaybeMeUser !== 'function') {
                window.Store.User.getMaybeMeUser = () => {
                  try {
                    const me = window.Store.ContactCollection?.getMeContact?.()
                    if (me?.id) return me.id
                  } catch (_) {}
                  return null
                }
              }
              if (typeof window.Store.User.getMaybeMeLidUser !== 'function') {
                window.Store.User.getMaybeMeLidUser = () => {
                  try {
                    const me = window.Store.ContactCollection?.getMeContact?.()
                    if (me?.id) {
                      if (typeof me.id.isLid === 'function' && me.id.isLid()) return me.id
                      const user = me.id.user || (me.id._serialized?.split('@')[0])
                      if (user && window.Store.WidFactory?.createWid) return window.Store.WidFactory.createWid(`${user}@lid`)
                    }
                  } catch (_) {}
                  return null
                }
              }
            } catch (_) { }
          }
        } catch (_) {}
    // Require WidFactory, Chat collection, and a working getChat helper
    const hasWidFactory = !!window.Store?.WidFactory?.createWid
    const hasChat = !!(window.Store?.Chat && (window.Store.Chat.get || window.Store.Chat.find))
  const hasGetChat = typeof window.WWebJS?.getChat === 'function'
    const hasSendSeen = typeof window.WWebJS?.sendSeen === 'function'
    const hasSendMessage = typeof window.WWebJS?.sendMessage === 'function'
  const hasMeGetter = typeof window.Store?.User?.getMaybeMeUser === 'function'
  const hasMeLidGetter = typeof window.Store?.User?.getMaybeMeLidUser === 'function'
  const ready = hasWidFactory && hasChat && hasGetChat && hasSendSeen && hasSendMessage && hasMeGetter && hasMeLidGetter
        if (ready) return true
        if (Date.now() - start > timeoutMs) return false
        await new Promise(r => setTimeout(r, 100))
      }
    }, timeoutMs)
    if (!result) {
      try {
        const flags = await client.pupPage.evaluate(() => ({
          hasWidFactory: !!window.Store?.WidFactory?.createWid,
          hasChat: !!(window.Store?.Chat && (window.Store.Chat.get || window.Store.Chat.find)),
          hasGetChat: typeof window.WWebJS?.getChat === 'function',
          hasSendSeen: typeof window.WWebJS?.sendSeen === 'function',
          hasSendMessage: typeof window.WWebJS?.sendMessage === 'function',
          hasMeGetter: typeof window.Store?.User?.getMaybeMeUser === 'function',
          hasMeLidGetter: typeof window.Store?.User?.getMaybeMeLidUser === 'function',
          version: window.Debug?.VERSION
        }))
        // eslint-disable-next-line no-console
        console.warn('WWeb readiness flags', flags)
      } catch (_) { }
    }
    return !!result
  } catch (_) { return false }
}

const destroySession = async (sessionId) => {
  try {
    const client = sessions.get(sessionId)
    if (!client) {
      return
    }
    client.pupPage?.removeAllListeners('close')
    client.pupPage?.removeAllListeners('error')
    try {
      await terminateWebSocketServer(sessionId)
    } catch (error) {
      logger.error({ sessionId, err: error }, 'Failed to terminate WebSocket server')
    }
    await client.destroy()
    // Wait 10 secs for client.pupBrowser to be disconnected
    let maxDelay = 0
    while (client.pupBrowser?.isConnected() && (maxDelay < 10)) {
      await new Promise(resolve => setTimeout(resolve, 1000))
      maxDelay++
    }
    sessions.delete(sessionId)
  } catch (error) {
    logger.error({ sessionId, err: error }, 'Failed to stop session')
    throw error
  }
}

const deleteSession = async (sessionId, validation) => {
  try {
    const client = sessions.get(sessionId)
    if (!client) {
      return
    }
    client.pupPage?.removeAllListeners('close')
    client.pupPage?.removeAllListeners('error')
    try {
      await terminateWebSocketServer(sessionId)
    } catch (error) {
      logger.error({ sessionId, err: error }, 'Failed to terminate WebSocket server')
    }
    if (validation.success) {
      // Client Connected, request logout
      logger.info({ sessionId }, 'Logging out session')
      await client.logout()
    } else if (validation.message === 'session_not_connected') {
      // Client not Connected, request destroy
      logger.info({ sessionId }, 'Destroying session')
      await client.destroy()
    }
    // Wait 10 secs for client.pupBrowser to be disconnected before deleting the folder
    let maxDelay = 0
    while (client.pupBrowser.isConnected() && (maxDelay < 10)) {
      await new Promise(resolve => setTimeout(resolve, 1000))
      maxDelay++
    }
    sessions.delete(sessionId)
    await deleteSessionFolder(sessionId)
  } catch (error) {
    logger.error({ sessionId, err: error }, 'Failed to delete session')
    throw error
  }
}

// Function to handle session flush
const flushSessions = async (deleteOnlyInactive) => {
  try {
    // Read the contents of the sessions folder
    const files = await fs.promises.readdir(sessionFolderPath)
    // Iterate through the files in the parent folder
    for (const file of files) {
      // Use regular expression to extract the string from the folder name
      const match = file.match(/^session-(.+)$/)
      if (match) {
        const sessionId = match[1]
        const validation = await validateSession(sessionId)
        if (!deleteOnlyInactive || !validation.success) {
          await deleteSession(sessionId, validation)
        }
      }
    }
  } catch (error) {
    logger.error(error, 'Failed to flush sessions')
    throw error
  }
}

module.exports = {
  sessions,
  setupSession,
  restoreSessions,
  validateSession,
  deleteSession,
  reloadSession,
  flushSessions,
  destroySession,
  ensurePageHelpers,
  ensureWWebReady,
  ensureWWebUser
}
