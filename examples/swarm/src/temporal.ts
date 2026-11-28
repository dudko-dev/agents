// Connection options for Temporal, the same for the gateway's client and the worker's native
// connection: plain (the dev server), TLS, mTLS (a client certificate) or an API key (Temporal
// Cloud). Certificates are read from files (a mounted secret), never from the environment.
import { readFileSync } from 'node:fs'
import type { ITemporalConfig } from './config.ts'

export interface ITemporalConnectionOptions {
  address: string
  tls?: {
    serverRootCACertificate?: Uint8Array
    clientCertPair?: { crt: Uint8Array; key: Uint8Array }
    serverNameOverride?: string
  }
  apiKey?: string
}

export const connectionOptions = (
  t: ITemporalConfig,
  read: (path: string) => Uint8Array = (path) => readFileSync(path),
): ITemporalConnectionOptions => ({
  address: t.address,
  ...(t.tls
    ? {
        tls: {
          ...(t.tls.caPath ? { serverRootCACertificate: read(t.tls.caPath) } : {}),
          ...(t.tls.certPath && t.tls.keyPath
            ? { clientCertPair: { crt: read(t.tls.certPath), key: read(t.tls.keyPath) } }
            : {}),
          ...(t.tls.serverName ? { serverNameOverride: t.tls.serverName } : {}),
        },
      }
    : {}),
  ...(t.apiKey ? { apiKey: t.apiKey } : {}),
})
