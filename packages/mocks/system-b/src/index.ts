// Mock "System B" — a REST receiver.
//
// Accepts arbitrary JSON via POST /orders and appends each payload to an
// in-memory log along with a server-side received_at timestamp. GET /received
// exposes the log so tests / the demo UI can verify that an integration ran
// end-to-end. POST /reset clears the log.

import Fastify from "fastify";

type ReceivedEntry = {
  received_at: string;
  body: unknown;
};

let RECEIVED: ReceivedEntry[] = [];

const PORT = Number(process.env.PORT ?? process.env.MOCK_SYSTEM_B_PORT ?? 5002);
const HOST = "0.0.0.0";

export function buildServer() {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

  app.get("/health", async () => ({ status: "ok" }));

  app.post("/orders", async (req) => {
    const entry: ReceivedEntry = {
      received_at: new Date().toISOString(),
      body: req.body,
    };
    RECEIVED.push(entry);
    return { ok: true, count: RECEIVED.length };
  });

  app.get("/received", async () => RECEIVED);

  app.post("/reset", async () => {
    RECEIVED = [];
    return { ok: true, count: 0 };
  });

  return app;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const app = buildServer();
  app
    .listen({ port: PORT, host: HOST })
    .then(() => {
      app.log.info(`mock-system-b listening on ${HOST}:${PORT}`);
    })
    .catch((err) => {
      app.log.error(err);
      process.exit(1);
    });
}
