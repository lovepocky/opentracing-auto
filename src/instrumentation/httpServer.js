'use strict'

const urllib = require('url')
const debug = require('debug')('opentracing-auto:instrumentation:httpServer')
const { Tags, FORMAT_HTTP_HEADERS } = require('opentracing')
const shimmer = require('shimmer')
// eslint-disable-next-line
const semver = require('semver')
const cls = require('../cls')

const OPERATION_NAME = 'http_server'
const TAG_REQUEST_PATH = 'request_path'

function patch (http, tracers) {
  shimmer.wrap(http, 'createServer', (createServer) => (requestListener) => {
    if (requestListener) {
      const listener = cls.bind((req, res) => {
        cls.bindEmitter(req)
        cls.bindEmitter(res)

        const protocol = req.socket.parser.incoming.httpVersionMajor === 1 ? 'http' : 'unkown'

        const url = `${protocol}://${req.headers.host}${req.url}`
        const parentSpanContexts = tracers.map((tracer) => tracer.extract(FORMAT_HTTP_HEADERS, req.headers))
        const spans = parentSpanContexts.map((parentSpanContext, key) =>
          cls.startRootSpan(tracers[key], OPERATION_NAME, {
            childOf: parentSpanContext,
            tags: {
              [Tags.SPAN_KIND]: Tags.SPAN_KIND_RPC_SERVER,
              [Tags.HTTP_URL]: url,
              [Tags.HTTP_METHOD]: req.method
            }
          }))
        debug(`Operation started ${OPERATION_NAME}`, {
          [Tags.HTTP_URL]: url,
          [Tags.HTTP_METHOD]: req.method
        })

        if (req.socket.remoteAddress) {
          spans.forEach((span) => span.log({ peerRemoteAddress: req.socket.remoteAddress }))
        }

        const headerOptions = {}
        tracers.forEach((tracer, key) => tracer.inject(spans[key], FORMAT_HTTP_HEADERS, headerOptions))
        Object
          .keys(headerOptions)
          .forEach((header) => {
            res.setHeader(header, headerOptions[header])
          })

        res.once('finish', () => {
          spans.forEach((span) => span.setTag(TAG_REQUEST_PATH, urllib.parse(req.url).pathname))
          spans.forEach((span) => span.setTag(Tags.HTTP_STATUS_CODE, res.statusCode))

          if (res.statusCode >= 400) {
            spans.forEach((span) => span.setTag(Tags.ERROR, true))

            debug(`Operation error captured ${OPERATION_NAME}`, {
              reason: 'Bad status code',
              statusCode: res.statusCode
            })
          }

          spans.forEach((span) => span.finish())
        })

        return requestListener(req, res)
      })

      return createServer.call(this, listener)
    }

    return createServer.call(this, requestListener)
  })

  debug('Patched')
}

function unpatch (http) {
  shimmer.unwrap(http, 'createServer')

  debug('Unpatched')
}

module.exports = {
  name: 'httpServer',
  module: 'http',
  OPERATION_NAME,
  TAG_REQUEST_PATH,
  patch,
  unpatch
}
