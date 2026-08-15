# ADR 0001: Observable Framework Static Runtime

## Decision

Use Observable Framework for the static application, Observable reactive JavaScript for page state, Observable Inputs for filters and simple forms, and Observable Plot for portfolio visualizations.

## Consequences

The app can be hosted as static files in private S3 behind CloudFront. Private application data is fetched at runtime through `/api/v1`; build-time loaders are limited to public configuration and documentation.
