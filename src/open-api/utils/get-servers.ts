import { OpenAPIV2, OpenAPIV3, OpenAPI } from 'openapi-types'
import type { IHttpOperation } from './open-api-utils'

/**
 * Returns the list of servers specified in the given OpenAPI document.
 */
export function getServers(
  basePath: string | undefined,
  operation: IHttpOperation,
): Array<string> {
  if (basePath) {
    return [basePath]
  }

  if (operation.servers && operation.servers.length > 0) {
    return operation.servers.map((server) => server.url)
  }

  return ['/']
}
