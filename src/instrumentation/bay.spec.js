'use strict'

const request = require('super-request')
const { expect } = require('chai')
const { Tracer, Tags, SpanContext } = require('opentracing')
const BayApplication = require('bay/application')
const Controller = require('bay/controller')
const cls = require('../cls')
const instrumentation = require('./bay')

class Welcome extends Controller {
  // eslint-disable-next-line
  * index () {
    return 'hello bay!'
  }
}

class Application extends BayApplication {
  constructor (options) {
    super(options)

    this.router.get('/', 'welcome#index')
  }
}

describe('instrumentation: bay', () => {
  let tracer
  let mockSpan

  beforeEach(function () {
    tracer = new Tracer()
    mockSpan = {
      setTag: this.sandbox.spy(),
      log: this.sandbox.spy(),
      finish: this.sandbox.spy()
    }

    this.sandbox.stub(cls, 'startRootSpan').callsFake(() => mockSpan)

    instrumentation.patch(BayApplication, [tracer])
  })

  afterEach(() => {
    instrumentation.unpatch(BayApplication)
  })

  describe('#patch', () => {
    it('should create a span without parent', async () => {
      // test
      const app = new Application({
        base: __dirname,
        controllers: {
          welcome: Welcome
        }
      })
      app.use(function * () {
        this.body = 'ok'
      })

      const result = await request(app.callback())
        .get('/')
        .expect(200)
        .end()

      // FIXME: should be undefined, but the dummy tracer returns an empty span context
      const childOf = new SpanContext()

      expect(cls.startRootSpan).to.be.calledWith(tracer, instrumentation.OPERATION_NAME, {
        childOf,
        tags: {
          [Tags.SPAN_KIND]: Tags.SPAN_KIND_RPC_SERVER,
          [Tags.HTTP_URL]: `http://127.0.0.1:${result.request.uri.port}/`,
          [Tags.HTTP_METHOD]: 'GET'
        }
      })

      expect(mockSpan.log).to.be.calledWith({ peerRemoteAddress: '::ffff:127.0.0.1' })
      expect(mockSpan.setTag).to.be.calledWith(instrumentation.TAG_REQUEST_PATH, '/')
      expect(mockSpan.setTag).to.be.calledWith(Tags.HTTP_STATUS_CODE, 200)
      expect(mockSpan.finish).to.have.callCount(1)
    })

    it('should create a span with parent', async () => {
      const headers = {}
      const parentSpan = tracer.startSpan('http_request')
      tracer.inject(parentSpan, headers)

      const app = new Application({
        base: __dirname,
        controllers: {
          welcome: Welcome
        }
      })
      app.use(function * () {
        this.body = 'ok'
      })

      const result = await request(app.callback())
        .get('/')
        .headers(headers)
        .expect(200)
        .end()

      expect(cls.startRootSpan).to.be.calledWith(tracer, instrumentation.OPERATION_NAME, {
        childOf: parentSpan.context(),
        tags: {
          [Tags.SPAN_KIND]: Tags.SPAN_KIND_RPC_SERVER,
          [Tags.HTTP_URL]: `http://127.0.0.1:${result.request.uri.port}/`,
          [Tags.HTTP_METHOD]: 'GET'
        }
      })
    })

    it('should set error tag for > 3xx status codes', async () => {
      const app = new Application({
        base: __dirname,
        controllers: {
          welcome: Welcome
        }
      })
      app.use(function * () {
        this.status = 400
        this.body = 'ok'
      })

      await request(app.callback())
        .get('/')
        .expect(400)
        .end()

      expect(mockSpan.setTag).to.be.calledWith(Tags.HTTP_STATUS_CODE, 400)
      expect(mockSpan.setTag).to.be.calledWith(Tags.ERROR, true)
      expect(mockSpan.finish).to.have.callCount(1)
    })
  })
})
