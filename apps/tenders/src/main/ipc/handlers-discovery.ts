// The tender-discovery channels: the feed list, its cache, a forced refresh, a
// single release lookup, and the one document download that bridges the feed to
// the managed-document store.
//
// Split out of `ipc/handlers.ts` with no behaviour change. Every handler is
// behind the same trusted-sender gate as the rest of the surface, validates the
// request's SHAPE (never its meaning — the client owns what a window, an ocid or
// a document link means), and passes the client's own result straight back, so
// the renderer sees exactly the message the engine produced rather than a
// re-worded one.
import {
  TENDERS_CHANNELS,
  type DiscoveryListRequest,
  type DiscoveryListResponse,
  type DiscoveryReadCacheResponse,
  type DiscoveryRefreshRequest,
  type DiscoveryRefreshResponse,
  type DiscoveryReleaseRequest,
  type DiscoveryReleaseResponse,
  type DiscoveryDownloadDocumentRequest,
} from '../../shared/ipc'
import { isRecord } from '../readiness-snapshot'
import { getDiscoveryClient, downloadDiscoveryDocument, discoveryFailure } from './engines'
import { isTrustedTendersEvent, unauthorizedTendersRequest } from './trust'
import type { TendersIpcRegistry } from './handler-context'

export function registerTendersDiscoveryChannels(ipc: TendersIpcRegistry): void {
  ipc.handle(
    TENDERS_CHANNELS.discoveryList,
    async (_e, request: DiscoveryListRequest): Promise<DiscoveryListResponse> => {
      if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
      if (!isRecord(request) || !isRecord(request.window)) {
        return discoveryFailure(
          'INVALID_REQUEST',
          'A discovery request needs a window with two dates in YYYY-MM-DD form, ending no earlier than it starts.',
        )
      }
      const from = request.window.from
      const to = request.window.to
      if (typeof from !== 'string' || typeof to !== 'string') {
        return discoveryFailure(
          'INVALID_REQUEST',
          'A discovery request needs a window with two dates in YYYY-MM-DD form, ending no earlier than it starts.',
        )
      }
      const pageSize = typeof request.pageSize === 'number' ? request.pageSize : undefined
      if (request.pageSize !== undefined && typeof request.pageSize !== 'number') {
        return discoveryFailure('INVALID_REQUEST', 'A discovery page size must be a number.')
      }
      if (
        pageSize !== undefined &&
        (!Number.isFinite(pageSize) || pageSize < 1 || pageSize > 100)
      ) {
        return discoveryFailure('INVALID_REQUEST', 'A discovery page size must be from 1 to 100.')
      }
      // The dates' meaning (a real civil date, a window the feed can answer) is
      // the client's own check, and its refusal is the one the user is shown.
      return getDiscoveryClient().listOpportunities({
        window: { from, to },
        ...(pageSize === undefined ? {} : { pageSize: Math.floor(pageSize) }),
      })
    },
  )

  ipc.handle(
    TENDERS_CHANNELS.discoveryRefresh,
    async (_e, request: DiscoveryRefreshRequest): Promise<DiscoveryRefreshResponse> => {
      if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
      if (request !== undefined && !isRecord(request)) {
        return discoveryFailure(
          'INVALID_REQUEST',
          'A discovery refresh takes no arguments but a window.',
        )
      }
      const window = isRecord(request) ? request.window : undefined
      if (window !== undefined) {
        if (!isRecord(window) || typeof window.from !== 'string' || typeof window.to !== 'string') {
          return discoveryFailure(
            'INVALID_REQUEST',
            'A discovery refresh needs a window with two dates in YYYY-MM-DD form, ending no earlier than it starts.',
          )
        }
        return getDiscoveryClient().refreshCache({ window: { from: window.from, to: window.to } })
      }
      return getDiscoveryClient().refreshCache()
    },
  )

  ipc.handle(
    TENDERS_CHANNELS.discoveryReadCache,
    async (_e): Promise<DiscoveryReadCacheResponse> => {
      if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
      // Reads the last successful fetch from disk; no network, so the list is
      // available offline exactly as the local rule engine is.
      return getDiscoveryClient().readCache()
    },
  )

  ipc.handle(
    TENDERS_CHANNELS.discoveryRelease,
    async (_e, request: DiscoveryReleaseRequest): Promise<DiscoveryReleaseResponse> => {
      if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
      const ocid = isRecord(request) && typeof request.ocid === 'string' ? request.ocid.trim() : ''
      if (!ocid || ocid.length > 128) {
        return discoveryFailure('INVALID_REQUEST', 'A release lookup needs the tender’s ocid.')
      }
      return getDiscoveryClient().fetchRelease(ocid)
    },
  )

  ipc.handle(
    TENDERS_CHANNELS.discoveryDownloadDocument,
    async (_e, request: DiscoveryDownloadDocumentRequest) => {
      if (!isTrustedTendersEvent(_e)) return unauthorizedTendersRequest()
      return downloadDiscoveryDocument(request)
    },
  )
}
