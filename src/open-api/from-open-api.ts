import { RequestHandler, HttpHandler, http } from 'msw'
import { normalizeSwaggerUrl } from './utils/normalize-swagger-url.js'
import { isAbsoluteUrl, joinPaths } from './utils/url.js'
import { createResponseResolver } from './utils/open-api-utils.js'
import {
  transformOas3Operations,
  transformOas3Service,
} from '@stoplight/http-spec/oas3'
import { getServers } from './utils/get-servers.js'

type SupportedHttpMethods = keyof typeof http
const supportedHttpMethods = Object.keys(
  http,
) as unknown as SupportedHttpMethods

/**
 * Generates request handlers from the given OpenAPI V2/V3 document.
 *
 * @example
 * import specification from './api.oas.json'
 * await fromOpenApi(specification)
 */
export async function fromOpenApi(
  document: any,
): Promise<Array<RequestHandler>> {
  const operations = transformOas3Operations(document)

  // HACK: Seems like nested $ref don't get dereferenced properly, so we do it in two steps:
  let stack = [...operations]
  for (const obj of stack) {
    for (const [key, value] of Object.entries(obj)) {
      if (Array.isArray(value)) {
        stack.push(...value)
        continue
      }

      if (typeof value === 'object' && value !== null) {
        stack.push(value)
      }

      if (key === '$ref') {
        const [hash, ...parts] = value.split('/')
        let resolvedValue = document
        for (const part of parts) {
          resolvedValue = resolvedValue[part]
        }

        // This is very bad... fix me...
        delete (obj as any)[key]
        Object.assign(obj, resolvedValue)
        stack.push(...operations)
      }
    }
  }

  const requestHandlers: Array<RequestHandler> = []

  if (operations.length === 0) {
    return []
  }

  for (const item of operations) {
    const method = item.method

    // Ignore unsupported HTTP methods.
    if (!isSupportedHttpMethod(method)) {
      continue
    }

    const serverUrls = getServers(document.basePath, item)

    for (const baseUrl of serverUrls) {
      const path = normalizeSwaggerUrl(item.path)
      const requestUrl = isAbsoluteUrl(baseUrl)
        ? new URL(path, baseUrl).href
        : joinPaths(path, baseUrl)

      if (item.responses.length === 0) {
        const handler = new HttpHandler(
          method,
          requestUrl,
          () =>
            new Response('Not Implemented', {
              status: 501,
              statusText: 'Not Implemented',
            }),
          {
            /**
             * @fixme Support `once` the same as in HAR?
             */
          },
        )

        requestHandlers.push(handler)

        continue
      }

      for (const response of item.responses) {
        const contents = response.contents
        if (!contents) {
          continue
        }

        const handler = new HttpHandler(
          method,
          requestUrl,
          createResponseResolver(item),
          {
            /**
             * @fixme Support `once` the same as in HAR?
             */
          },
        )

        requestHandlers.push(handler)
      }
    }
  }

  return requestHandlers
}

function isSupportedHttpMethod(method: string): method is SupportedHttpMethods {
  return supportedHttpMethods.includes(method)
}
