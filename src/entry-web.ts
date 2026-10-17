import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

// Lambda sets AWS_LAMBDA_HTTP_ENDPOINT ("host:port"); the fallback is for local runs only.
const [hostname, port] = (process.env.AWS_LAMBDA_HTTP_ENDPOINT || "127.0.0.1:3000").split(":");

const server = serve({ fetch: createApp().fetch, hostname, port: Number(port) }, () => {
  console.log(`listening on ${hostname}:${port}`);
});

process.on("SIGTERM", () => {
  server.close();
  process.exit(0);
});
