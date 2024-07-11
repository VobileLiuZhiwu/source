import type { ResponseResolver } from 'msw'
import { seedSchema } from '@yellow-ticket/seed-json-schema'
import { toString } from './to-string.js'
import { STATUS_CODES } from './status-codes.js'
import { transformOas3Operations } from '@stoplight/http-spec'

export type IHttpOperation = ReturnType<typeof transformOas3Operations>[number]
type IHttpOperationResponse = IHttpOperation['responses'][number]
type IMediaTypeContent = Exclude<
  IHttpOperationResponse['contents'],
  undefined
>[number]

export function createResponseResolver(
  operation: IHttpOperation,
): ResponseResolver {
  return ({ request }) => {
    const { responses } = operation

    // Treat operations that describe no responses as not implemented.
    if (responses.length === 0) {
      return new Response('Not Implemented', {
        status: 501,
        statusText: 'Not Implemented',
      })
    }

    let responseObject: IHttpOperationResponse

    const url = new URL(request.url)
    const explicitResponseStatus = url.searchParams.get('response')

    if (explicitResponseStatus) {
      const responseByStatus = responses.find(
        (response) => response.code === explicitResponseStatus,
      )

      if (!responseByStatus) {
        return new Response('Not Implemented', {
          status: 501,
          statusText: 'Not Implemented',
        })
      }

      responseObject = responseByStatus
    } else {
      const fallbackResponse =
        responses.find((response) => response.code === '200') ||
        responses.find((response) => response.code === 'default')

      if (!fallbackResponse) {
        return new Response('Not Implemented', {
          status: 501,
          statusText: 'Not Implemented',
        })
      }

      responseObject = fallbackResponse
    }

    const status = Number(explicitResponseStatus || '200')

    return new Response(toBody(request, responseObject), {
      status,
      statusText: STATUS_CODES[status],
      headers: toHeaders(request, responseObject),
    })
  }
}

/**
 * Get the Fetch API `Headers` from the OpenAPI response object.
 */
export function toHeaders(
  request: Request,
  responseObject: IHttpOperationResponse,
): Headers | undefined {
  const { contents } = responseObject
  if (!contents || contents.length === 0) {
    return undefined
  }

  // See what "Content-Type" the request accepts.
  const accept = request.headers.get('accept') || ''
  const acceptedContentTypes = accept
    .split(',')
    .filter((item) => item.length !== 0)

  const responseContentTypes = contents.map((content) => content.mediaType)

  // Lookup the first response content type that satisfies
  // the expected request's "Accept" header.
  let selectedContentType: string | undefined
  if (acceptedContentTypes.length > 0) {
    for (const acceptedContentType of acceptedContentTypes) {
      const contentTypeRegExp = contentTypeToRegExp(acceptedContentType)
      const matchingResponseContentType = responseContentTypes.find(
        (responseContentType) => {
          return contentTypeRegExp.test(responseContentType)
        },
      )

      if (matchingResponseContentType) {
        selectedContentType = matchingResponseContentType
        break
      }
    }
  } else {
    // If the request didn't specify any "Accept" header,
    // use the first response content type from the spec.
    selectedContentType = responseContentTypes[0] as string
  }

  const responseHeaders = responseObject.headers ?? []

  if (responseHeaders.length === 0 && selectedContentType) {
    const headers = new Headers()
    headers.set('content-type', selectedContentType)
    return headers
  }

  const headerNames = responseHeaders.map((header) => header.name)
  if (headerNames.length === 0) {
    return undefined
  }

  const headers = new Headers()

  for (const { name, schema } of responseHeaders) {
    if (!schema) {
      continue
    }

    const headerValue = seedSchema(schema as any)

    if (typeof headerValue === 'undefined') {
      continue
    }

    headers.append(name, toString(headerValue))
  }

  if (headers.get('content-type') === null && selectedContentType) {
    headers.set('content-type', selectedContentType)
  }

  return headers
}

/**
 * Get the Fetch API `BodyInit` from the OpenAPI response object.
 */
export function toBody(
  request: Request,
  responseObject: IHttpOperationResponse,
): RequestInit['body'] {
  try {
    const { contents } = responseObject

    if (!contents || contents.length === 0) {
      return null
    }

    // See what "Content-Type" the request accepts.
    const accept = request.headers.get('accept') || ''
    const acceptedContentTypes = accept
      .split(',')
      .filter((item) => item.length !== 0)

    let mediaTypeObject: IMediaTypeContent | undefined
    const responseContentTypes = contents.map((content) => content.mediaType)

    // Lookup the first response content type that satisfies
    // the expected request's "Accept" header.
    let selectedContentType: string | undefined
    if (acceptedContentTypes.length > 0) {
      for (const acceptedContentType of acceptedContentTypes) {
        const contentTypeRegExp = contentTypeToRegExp(acceptedContentType)
        const matchingResponseContentType = responseContentTypes.find(
          (responseContentType) => {
            return contentTypeRegExp.test(responseContentType)
          },
        )

        if (matchingResponseContentType) {
          selectedContentType = matchingResponseContentType
          mediaTypeObject = contents.find(
            (content) => content.mediaType === selectedContentType,
          )
          break
        }
      }
    } else {
      // If the request didn't specify any "Accept" header,
      // use the first response content type from the spec.
      selectedContentType = responseContentTypes[0] as string
      mediaTypeObject = contents.find(
        (content) => content.mediaType === selectedContentType,
      )
    }

    if (!mediaTypeObject) {
      return null
    }

    // First, if the response has a literal example, use it.
    if (mediaTypeObject.examples && mediaTypeObject.examples.length > 0) {
      if ('value' in mediaTypeObject.examples) {
        return JSON.stringify(mediaTypeObject.examples.value)
      }
    }

    // If the response has multiple literal examples, use the first one.
    if (mediaTypeObject.examples && mediaTypeObject.examples.length > 0) {
      // Support exact response example specified in the
      // "example" request URL search parameter.
      const url = new URL(request.url)
      const exampleName = url.searchParams.get('example')

      if (exampleName) {
        const exampleByName = mediaTypeObject.examples.find(
          (example) => example.key === exampleName,
        )
        if (exampleByName && 'value' in exampleByName) {
          return JSON.stringify(exampleByName.value)
        } else {
          return `Cannot find example by name "${exampleName}"`
        }
      }

      // Otherwise, use the first example.
      const firstExample = mediaTypeObject.examples
        ? mediaTypeObject.examples[0]
        : null

      if (firstExample && 'value' in firstExample) {
        if (typeof firstExample.value === 'object') {
          return JSON.stringify(firstExample.value)
        }
        return firstExample.value as string
      }

      return undefined
    }

    // If the response is a JSON Schema, evolve and use it.
    if (mediaTypeObject.schema) {
      // HACK: This is a temporary workaround because the shape of examples isn't what `seedSchema` expects.
      let stack = [mediaTypeObject.schema]
      for (const obj of stack) {
        for (const [key, value] of Object.entries(obj)) {
          if (
            typeof value === 'object' &&
            value !== null &&
            !Array.isArray(value)
          ) {
            stack.push(value)
          }

          if (key === 'examples') {
            obj[key] = Array.isArray(value) ? value[0] : value
            break
          }

          if (key === '$ref') {
            console.log('Found $ref', value)
          }
        }
      }

      const resolvedResponse = seedSchema(mediaTypeObject.schema as any)

      return JSON.stringify(resolvedResponse)
    }

    return null
  } catch (e) {
    console.log(e)
    return
  }
}

function contentTypeToRegExp(contentType: string): RegExp {
  return new RegExp(contentType.replace(/\/+/g, '\\/').replace(/\*/g, '.+?'))
}
