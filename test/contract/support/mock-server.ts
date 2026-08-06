/**
 * Hermetic mock CollectivIQ HTTP server for contract tests.
 *
 * Runs a real loopback `http` server on an ephemeral port so the adapter's
 * transport (deadlines, incremental size enforcement, content-type checks,
 * cancellation, socket resets) is exercised end to end. Handlers receive the
 * captured request and the raw `ServerResponse`, so a test can delay headers,
 * dribble a body, overrun the size cap, or destroy the socket.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

export interface CapturedRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly rawBody: Buffer;
  text(): string;
}

export type MockHandler = (request: CapturedRequest, res: ServerResponse) => void | Promise<void>;

export interface MockServer {
  readonly baseUrl: string;
  readonly requests: CapturedRequest[];
  close(): Promise<void>;
}

async function collectBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Start a mock server; the handler decides each response. */
export async function startMockServer(handler: MockHandler): Promise<MockServer> {
  const requests: CapturedRequest[] = [];
  const server: Server = createServer((req, res) => {
    void (async () => {
      const rawBody = await collectBody(req);
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const captured: CapturedRequest = {
        method: req.method ?? "GET",
        path: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        rawBody,
        text: () => rawBody.toString("utf8"),
      };
      requests.push(captured);
      try {
        await handler(captured, res);
      } catch {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    })();
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    requests,
    close: async () => {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.closeAllConnections?.();
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
    },
  };
}

/** Convenience: reply with a JSON body and 200 (or a given status). */
export function replyJson(res: ServerResponse, body: unknown, status = 200): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

/** Convenience: reply with a raw string body and explicit content type. */
export function replyRaw(
  res: ServerResponse,
  body: string,
  status: number,
  contentType: string,
): void {
  res.writeHead(status, { "content-type": contentType });
  res.end(body);
}
