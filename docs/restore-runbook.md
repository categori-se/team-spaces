# Restore Runbook

This runbook distinguishes provider recovery from Team Spaces data portability. Point-in-time recovery is enabled by the hosted production profile and is an explicit opt-in for community installations. A record export is portable and auditable, but it is not an atomic replacement for PITR while the source table is receiving writes.

## DynamoDB

When point-in-time recovery is enabled:

1. Identify the target restore timestamp.
2. Restore to a new temporary table.
3. Validate item counts and representative workspace, project, task, activity, time, and attachment records.
4. Export records from the restored table through `npm run export:data` for validation and an audit artifact.
5. Reconcile the restored table's key schema, GSIs, TTL, throughput ceilings, and ownership with the CDK stack before switching traffic.
6. Update the Lambda table reference only after representative authorization, query, mutation, and migration-marker checks pass.
7. Keep the original table until the restoration is accepted.

## Versioned record export and import

Export the exact application table with strongly consistent paginated reads:

```bash
TABLE_NAME=exact-source-table \
EXPORT_PATH=team-spaces-data.json \
npm run export:data
```

The bundle stores low-level DynamoDB AttributeValue JSON, including base64-encoded binary attributes, plus application and data-model metadata, item and byte counts, and a SHA-256 source-payload checksum. The checksum detects accidental corruption; it is not an authenticated signature. Preserve an independently authenticated hash when audit provenance is required. A multi-page scan is not an atomic snapshot if writes continue; use a quiesced source or a PITR-restored table when a recovery-grade point in time is required.

This in-memory portable path is limited to 25,000 items and a 64 MiB compact AttributeValue payload. The strongly consistent scan consumes table read capacity. For a larger installation, enable PITR and use [DynamoDB Export to S3](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/S3DataExport.HowItWorks.html) as the table-scale recovery source; its native files require a separate controlled migration and are not direct input to this importer.

Validate locally before supplying a target:

```bash
IMPORT_PATH=team-spaces-data.json npm run import:data
```

Deploy a schema-compatible empty, quiesced target table, then apply:

```bash
TABLE_NAME=exact-empty-target \
IMPORT_PATH=team-spaces-data.json \
npm run import:data -- --apply
```

The local dry run validates the format, data-model version, source checksum, supported AttributeValue union shape and basic value syntax, keys, duplicates, and item/byte ceilings. It reports source, importable, and skipped-marker counts without contacting DynamoDB. Apply then verifies the target table's primary keys, two GSIs, TTL configuration, and active status before checking that it is empty or issuing any write. Records are written in DynamoDB's 25-item batches and unprocessed items are retried. A failed import can leave a partial target; recreate that disposable target before retrying rather than treating `--allow-nonempty` as routine recovery.

The source work-index readiness marker is target-specific and is not imported. Keep `TEAMSPACES_WORK_INDEX_READY=false`, run the migration verifier against the target, wait for GSI propagation, and write a new readiness marker before enabling the indexed reader.

The export contains application-table records only. It does not contain table configuration, Cognito users, S3 document bytes, object versions, CloudFormation/CDK assets, DNS, certificates, or deployment secrets. Restoring with a different Cognito pool changes user subjects and requires an identity-remapping migration that is not yet automated.

## Attachments

S3 versioning is enabled for attachments. To restore an object:

1. Locate the attachment record and its recorded object key, VersionId, size, and checksum.
2. If that exact version survives in the same bucket, verify it directly; it need not be current and does not need to be copied.
3. If recovery requires a copy, verify the new object's bytes and conditionally update the document row to its new VersionId, ETag, and checksum with audit evidence.
4. Confirm the version-pinned download through the application.

For same-bucket recovery, the document row's recorded `objectVersionId` remains authoritative. Requesting that exact surviving version works even when it is not current. If an object must be copied to make a new version, verify the bytes and conditionally update the document row with the new VersionId, ETag, checksum, and audit evidence; merely copying to the current key does not redirect version-specific downloads.

For installation recovery into another bucket, inventory and copy attachment bytes separately while preserving object keys, encryption, metadata, and tags. S3 assigns new VersionIds in the target bucket, so every finalized document row needs a reviewed conditional metadata rewrite after target checksums are verified. Team Spaces does not yet automate that cross-bucket step. The web bucket can be rebuilt from the exact source revision; it is not a substitute for the attachment inventory.

## Quarterly Test

Production operators should perform a quarterly restore drill in a temporary stack, document timing and gaps, then destroy the temporary compute and deliberately review retained tables/buckets. Community operators should choose a drill frequency proportionate to their recovery objective.
