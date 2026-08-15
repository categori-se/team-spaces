# ADR 0005: Private Attachments With Presigned URLs

## Decision

Store attachments in a separate private S3 bucket. Browser uploads and downloads use short-lived presigned URLs after API authorization.

## Consequences

Object keys are randomized, original filenames are metadata only, public sharing is deferred, and lifecycle rules clean abandoned uploads and old noncurrent versions.
