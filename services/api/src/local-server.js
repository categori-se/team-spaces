// @ts-check

import http from "node:http";
import {createHandler} from "./handler.js";
import {MemoryRepository} from "./repositories/memory.js";

process.env.ALLOW_DEMO_AUTH = "true";
process.env.APP_ORIGIN ??= "http://localhost:3000";

const handler = createHandler({repository: new MemoryRepository()});
const port = Number(process.env.PORT ?? 8787);

const server = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks).toString("utf8") : undefined;
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const result = await handler({
    rawPath: url.pathname,
    rawQueryString: url.searchParams.toString(),
    headers: Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(",") : value])),
    requestContext: {http: {method: request.method ?? "GET"}},
    body
  });
  response.writeHead(result.statusCode, result.headers);
  response.end(result.body);
});

server.listen(port, () => {
  console.log(`Team Spaces local API listening on http://localhost:${port}`);
});
