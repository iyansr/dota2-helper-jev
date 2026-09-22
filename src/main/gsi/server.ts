import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { GsiPayload } from "./types.ts";

export const DEFAULT_GSI_PORT = 52817;
export const DEFAULT_GSI_PATH = "/gsi";

export interface GsiServerOptions {
  /** Shared secret from the cfg file. Payloads without it are dropped. */
  token: string;
  port?: number;
  path?: string;
  onPayload: (payload: GsiPayload) => void;
  /** Rejected requests — bad token, bad JSON, wrong path. Non-fatal by design. */
  onReject?: (reason: string, req: IncomingMessage) => void;
}

export interface GsiServer {
  start(): Promise<number>;
  stop(): Promise<void>;
  /** ms epoch of the last accepted payload, or null before the first one. */
  lastPayloadAt(): number | null;
}

const MAX_BODY_BYTES = 2 * 1024 * 1024;

export function createGsiServer(options: GsiServerOptions): GsiServer {
  const port = options.port ?? DEFAULT_GSI_PORT;
  const path = options.path ?? DEFAULT_GSI_PATH;
  let lastAt: number | null = null;
  let server: Server | null = null;

  const reject = (reason: string, req: IncomingMessage, res: ServerResponse, code = 403): void => {
    options.onReject?.(reason, req);
    res.writeHead(code).end();
  };

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== "POST" || (req.url ?? "") !== path) {
      reject(`unexpected ${req.method} ${req.url}`, req, res, 404);
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject("body too large", req, res, 413);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (res.writableEnded) return;

      let payload: GsiPayload;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as GsiPayload;
      } catch {
        reject("invalid json", req, res, 400);
        return;
      }

      if (payload.auth?.token !== options.token) {
        reject("bad auth token", req, res, 403);
        return;
      }

      // Answer before doing any work: Dota retries (and stalls) on a slow endpoint.
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      lastAt = Date.now();

      // `auth` is the only part of the payload nothing downstream should ever see.
      delete payload.auth;
      try {
        options.onPayload(payload);
      } catch (error) {
        options.onReject?.(`handler threw: ${String(error)}`, req);
      }
    });
  };

  return {
    start() {
      return new Promise<number>((resolve, reject_) => {
        const s = createServer(handle);
        s.once("error", reject_);
        // 127.0.0.1 only — never expose game state to the LAN.
        s.listen(port, "127.0.0.1", () => {
          s.removeListener("error", reject_);
          server = s;
          resolve(port);
        });
      });
    },
    stop() {
      return new Promise<void>((resolve) => {
        if (!server) return resolve();
        server.close(() => {
          server = null;
          resolve();
        });
      });
    },
    lastPayloadAt: () => lastAt,
  };
}
