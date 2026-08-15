import {writeFile} from "node:fs/promises";
import {DynamoDBClient} from "@aws-sdk/client-dynamodb";
import {createDataExport, maxPortableExportFileBytes} from "./data-portability.mjs";

const tableName = process.env.TABLE_NAME;
if (!tableName) throw new Error("TABLE_NAME is required");
const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
const out = process.env.EXPORT_PATH ?? `team-spaces-export-${new Date().toISOString().slice(0, 10)}.json`;
const client = new DynamoDBClient(region ? {region} : {});
const resolvedRegion = await client.config.region();
const payload = await createDataExport(client, {
  tableName,
  region: resolvedRegion,
  release: process.env.TEAMSPACES_RELEASE_ID ?? process.env.GITHUB_SHA ?? ""
});
const serialized = `${JSON.stringify(payload)}\n`;
if (Buffer.byteLength(serialized) > maxPortableExportFileBytes) {
  throw new Error(`Portable export file exceeds ${maxPortableExportFileBytes} bytes; use DynamoDB Export to S3 for a larger installation`);
}
await writeFile(out, serialized, {mode: 0o600, flag: "wx"});
console.log(JSON.stringify({
  wrote: out,
  sourceItemCount: payload.itemCount,
  payloadBytes: payload.payloadBytes,
  sourceChecksum: payload.checksum.value,
  application: payload.application
}));
