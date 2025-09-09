require('./routes')
const express = require('express')
const { routes } = require('./routes')
const { maxAttachmentSize } = require('./config')

const app = express()
try {
	const { baseWebhookURL, enableWebHook } = require('./config')
	const { logger } = require('./logger')
	if (enableWebHook && !baseWebhookURL) {
		logger.warn('ENABLE_WEBHOOK is true but BASE_WEBHOOK_URL is not set')
	}
} catch (_) {}

// Initialize Express app
app.disable('x-powered-by')
app.use(express.json({ limit: maxAttachmentSize + 1000000 }))
app.use(express.urlencoded({ limit: maxAttachmentSize + 1000000, extended: true }))
app.use('/', routes)

// Global handler for invalid JSON payloads
app.use((err, req, res, next) => {
	if (err && err.type === 'entity.parse.failed') {
		return res.status(400).json({ success: false, message: 'Invalid JSON body' })
	}
	next(err)
})

module.exports = app
