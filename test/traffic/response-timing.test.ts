import fetch from 'cross-fetch'
import { fromTraffic } from 'src/traffic/fromTraffic'
import { setupServer } from 'msw/node'
import { normalizeLocalhost, readArchive } from './utils'

const responseTiming = readArchive(
  'test/traffic/fixtures/archives/response-timing.har',
)

async function fetchWithPerf(
  input: RequestInfo,
  init?: RequestInit,
): Promise<{ res: Response; timing: number }> {
  const requestStart = performance.now()
  return fetch(input, init).then((res) => {
    const requestEnd = performance.now()
    return {
      res,
      timing: requestEnd - requestStart,
    }
  })
}

const server = setupServer()

beforeAll(() => {
  server.listen()
})

afterEach(() => {
  server.resetHandlers()
})

afterAll(() => {
  server.close()
})

it('sends the mocked response instantly to an instant recorded response', async () => {
  const handlers = fromTraffic(responseTiming, normalizeLocalhost)
  server.use(...handlers)

  const { res, timing } = await fetchWithPerf('http://localhost/timing/instant')
  expect(res.status).toEqual(200)
  expect(await res.text()).toEqual('hello world')
  expect(timing).toBeLessThanOrEqual(100)
})

it('delays the mocked response using the recorded response timing', async () => {
  const handlers = fromTraffic(responseTiming, normalizeLocalhost)
  server.use(...handlers)

  const { res, timing } = await fetchWithPerf('http://localhost/timing/delayed')
  expect(res.status).toEqual(200)
  expect(await res.text()).toEqual('delayed body')
  expect(timing).toBeGreaterThanOrEqual(500)
  expect(timing).toBeLessThanOrEqual(600)
})
