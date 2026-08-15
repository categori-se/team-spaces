import {DynamoDBClient} from "@aws-sdk/client-dynamodb";
import {
  importDataExport,
  readDataImportPlan
} from "./data-portability.mjs";

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const allowNonEmpty = args.has("--allow-nonempty");
const inputPath = process.env.IMPORT_PATH ?? process.argv.slice(2).find((value) => !value.startsWith("--"));
const plan = await readDataImportPlan(inputPath ?? "");

if (!apply) {
  console.log(JSON.stringify({
    valid: true,
    dryRun: true,
    application: plan.payload.application,
    sourceItemCount: plan.sourceItemCount,
    importableItemCount: plan.importableItemCount,
    skippedTargetMarkers: plan.skippedTargetMarkers,
    sourceChecksum: plan.sourceChecksum,
    next: "Set TABLE_NAME and rerun with --apply to write into an empty target table"
  }));
} else {
  const tableName = process.env.TABLE_NAME;
  if (!tableName) throw new Error("TABLE_NAME is required with --apply");
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  const result = await importDataExport(new DynamoDBClient(region ? {region} : {}), plan.payload, {tableName, allowNonEmpty});
  console.log(JSON.stringify({imported: true, tableName, ...result}));
}
