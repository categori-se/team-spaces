// @ts-check

import http from "node:http";
import {createHandler, createPublicDemoHandler} from "./handler.js";
import {MemoryRepository} from "./repositories/memory.js";
import path from "node:path";
import {openLocalCoordination} from "./local-coordination.js";

const manifestPath = process.env.TEAMSPACES_PROGRAM_MANIFEST;
const local = manifestPath ? await openLocalCoordination({manifestPath, stateDirectory: process.env.TEAMSPACES_LOCAL_STATE_DIR ?? path.resolve(".ai-studio/opengeo-workspace")}) : undefined;
process.env.ALLOW_DEMO_AUTH = local ? "false" : "true";
process.env.APP_ORIGIN ??= "http://localhost:3000";

const handler = createHandler({repository: local?.repository ?? new MemoryRepository()});
const publicDemoHandler = createPublicDemoHandler({enabled: true});
const port = Number(process.env.PORT ?? 8787);
let mutations = Promise.resolve();

const server = http.createServer(async (request, response) => {
  let localOrigin;
  try {
    const supplied = new URL(request.headers.origin ?? "http://localhost");
    if (supplied.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(supplied.hostname)) localOrigin = supplied.origin;
  } catch {}
  const headers = {"content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...(localOrigin ? {"access-control-allow-origin": localOrigin, "access-control-allow-headers": "authorization,content-type,x-correlation-id,x-teamspaces-account-id", "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS", vary: "Origin"} : {})};
  if (request.method === "OPTIONS") { response.writeHead(204, headers); response.end(); return; }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) { response.writeHead(413, headers); response.end(JSON.stringify({status: 413, detail: "Request body exceeds the local limit"})); return; }
    chunks.push(chunk);
  }
  const body = chunks.length ? Buffer.concat(chunks).toString("utf8") : undefined;
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (local && url.pathname.startsWith("/api/v1/demo")) { response.writeHead(403, headers); response.end(JSON.stringify({status: 403, detail: "This workspace contains real project records; public editing is unavailable"})); return; }
  if (local && url.pathname === "/api/v1/local/session") {
    let session;
    try { if (request.method === "POST" && bytes <= 8192) session = local.session(JSON.parse(body ?? "{}").key); } catch {}
    response.writeHead(session ? 200 : 401, headers);
    response.end(JSON.stringify(session ? {data: session} : {status: 401, detail: "The local owner key was not accepted"}));
    return;
  }
  const publicRequest = url.pathname.startsWith("/api/v1/public/coordination") || url.pathname === "/api/v1/public/projects" || url.pathname.startsWith("/api/v1/public/projects/") || url.pathname === "/api/v1/health";
  const claims = local && !publicRequest ? local.identity(request.headers.authorization) : undefined;
  if (local && !publicRequest && !claims) { response.writeHead(401, headers); response.end(JSON.stringify({status: 401, title: "Authentication required", detail: "Sign in to the private workspace"})); return; }
  const routeHandler = url.pathname === "/api/v1/demo" || url.pathname.startsWith("/api/v1/demo/") ? publicDemoHandler : handler;
  const event = {
    rawPath: url.pathname,
    rawQueryString: url.searchParams.toString(),
    headers: Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(",") : value])),
    requestContext: {http: {method: request.method ?? "GET"}, ...(claims ? {authorizer: {jwt: {claims}}} : {})},
    body
  };
  const execute = async () => {
    try {
      const result = await routeHandler(event);
      if (local && !publicRequest && ["POST", "PUT", "PATCH", "DELETE"].includes(request.method ?? "")) await local.save();
      response.writeHead(result.statusCode, {...result.headers, ...headers});
      response.end(result.body);
    } catch {
      response.writeHead(500, headers);
      response.end(JSON.stringify({status: 500, detail: "The local workspace could not be saved; inspect retained state before retrying"}));
    }
  };
  if (local && ["POST", "PUT", "PATCH", "DELETE"].includes(request.method ?? "")) mutations = mutations.then(execute, execute);
  else { if (local) await mutations; await execute(); }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Team Spaces local API listening on http://localhost:${port}`);
});
