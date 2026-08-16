# Cost Model

Reviewed: 2026-08-15. Prices vary by region and can change; verify the linked AWS pricing pages before a production capacity change.

The light-installation target is less than $5/month for application infrastructure, excluding external DNS, support, connector subscriptions, and unusually large document transfer. This is an operating target, not a promise that the complete product at heavy use costs $5.

## Deployment profiles

“Zero latent cost” means **no paid always-on compute and no provisioned database capacity**. It does not mean stored bytes or an AWS invoice are guaranteed to be zero.

| Profile | Included cost posture |
| --- | --- |
| Community core (generic default) | One on-demand application table; ARM Lambda; HTTP API; CloudFront; private S3; Cognito Lite; finite logs. Public demo, metric alarms/SNS, application budget, and PITR are off. |
| Production operations | Enables PITR and focused alarms; a notification-only tagged budget and SNS email are created when an address is supplied. These controls improve recovery and response but can add stored-byte or shared-allowance cost. |
| Hosted showcase | Adds the isolated public-demo table/API/reset lane and its operations alarms. An optional demo hostname is a second alias on the existing CloudFront distribution, not a second distribution or service. The showcase remains request-priced but intentionally creates more resources and scheduled activity than a private team needs. |

The generic installer selects the community profile explicitly. A service operator can select the production and hosted-showcase options. Retained S3/DynamoDB data, CloudFormation/CDK assets, DNS, certificate-related external services, and traffic remain the operator's responsibility in every profile.

## Light-use planning envelope

Assumptions: us-east-1, production operations enabled, about 50 direct Cognito users, 100,000 API calls, 500,000 eventually consistent read request units, 100,000 logical writes, fewer than one million Lambda/SQS operations, 1-3 GB each of application data/backups and documents, and modest logs. The community profile omits the PITR, alarm, budget, and public-demo rows.

| Component | Cost behavior | Planning range |
| --- | --- | --- |
| CloudFront + private web S3 | Edge requests/transfer and small object storage; current allowances or an eligible CloudFront Free plan may cover light use | $0.00-$0.25 |
| Cognito Lite/Essentials | 10,000 direct/social MAU monthly free; SAML/OIDC federation has a much smaller 50-MAU free tier | $0.00 for the stated direct-user pilot |
| HTTP API | Request-priced with no minimum; 100,000 calls are roughly ten cents after applicable credits | about $0.10 |
| ARM Lambda | Requests and GB-seconds; the stated workload normally fits the shared monthly allowance | $0.00-$0.10 |
| DynamoDB on demand + GSIs | Reads/writes/storage only; projections and transactions amplify billed units | $0.15-$0.75 |
| DynamoDB point-in-time recovery | Charged by protected table and index size, even when idle | $0.20-$0.60 at 1-3 GB |
| Document S3 | Standard storage, requests, transfer, and retained versions | $0.03-$0.25 at 1-3 GB |
| CloudWatch | Short-retention logs and ten focused alarm metrics; shared allowances may cover the pilot | $0.00-$1.00 |
| AWS Budgets | One notification-only application budget is within the current free budget allowance | $0.00 |
| Public demo reset | Two small ARM Lambdas, a disposable on-demand table, one daily Scheduler invocation, and a small DLQ; no provisioned or always-on compute | normally pennies and comfortably below $1 at 100,000 demo calls |
| DNS | Operator-managed DNS is outside this stack | account-specific |

Expected light-use application total: roughly **$0.50-$3/month**, with a **$5/month guardrail target**. AWS free allowances are shared across an account or organization and may already be consumed, so zero-dollar rows must not be assumed during forecasting.

A hosted pool must use the Cognito Essentials or Plus tier for Managed Login v2. Applying Team Spaces light/dark branding and upgrading a prefix domain adds no separate branding or always-on infrastructure charge; normal Cognito MAU and messaging pricing still applies.

One business mutation is not necessarily one DynamoDB write unit. Index projections are billed separately, items are rounded by size, and transactional writes consume more capacity. Load tests and the AWS Cost Explorer remain authoritative.

## Public demo envelope

The anonymous demo has a separate cost and failure boundary: one small on-demand DynamoDB table with PITR off, a ten-concurrency ARM API Lambda, a one-concurrency reset Lambda, EventBridge Scheduler, and an SQS dead-letter queue. The API concurrency ceiling matches the existing burst so a normal page's bounded parallel reads do not throttle each other; reserved concurrency is a limit, not provisioned capacity, and has no idle charge. The seeded table is tiny, Lambda and DynamoDB have no idle compute/throughput charge, and roughly 30 scheduled resets per month are far below EventBridge Scheduler's 14-million-invocation monthly free allowance. Shared AWS free allowances may already be consumed, so this is not a guarantee of a zero bill.

Putting the demo on a distinct hostname reuses the same CloudFront distribution, web bucket, static assets, HTTP API, and demo Lambda. It adds a certificate name, an operator-managed DNS record, and traffic under the existing request/transfer pricing; it does not add an always-on host, load balancer, provisioned capacity, or another distribution with a fixed idle floor. Certificate validation and external DNS remain operator concerns, and any DNS-provider or domain-registration charge stays outside this stack.

At 100,000 demo requests per month, incremental HTTP API, Lambda, and DynamoDB usage is expected to remain below $1 before unusual logs or alarm charges. A continuously saturated 2-request/second route is about 5.18 million requests per 30-day month and roughly $5.18 of first-tier HTTP API request charges by itself. For that reason the route throttle is paired with a hard 500-attempt mutation counter per reset cycle, per-entity limits, a ten-record public page ceiling, 1,024-character mutable text fields, a 32 KiB serialized response ceiling, a CloudFront viewer guard for declared body sizes plus authoritative Lambda validation for the 8 KiB request-body ceiling, no bodies on public reads, bounded correlation IDs with anonymous 4xx log suppression, Lambda reserved concurrency of ten, and table maximum-throughput settings. The higher concurrency ceiling does not reserve paid compute; it only lets a page's requests execute within the already bounded burst. API Gateway throttling is a best-effort target rather than an exact billing ceiling. CloudFront Functions cannot inspect an undeclared viewer body, and Lambda validation happens after API Gateway receives it, so these controls bound application work but are not an exact API-ingress billing cap.

At the 32 KiB response ceiling, a route sustained continuously at 2 requests/second could deliver about 158 GiB in 30 days. Current shared CloudFront allowances may cover that transfer; if they are unavailable, transfer can exceed the request-only estimate. The throttle is best-effort and AWS Budgets is a delayed alert, not a hard cap, so the emergency concurrency-zero procedure remains the authoritative shutdown control. The application returns a small error instead of serializing larger anonymous results.

No standalone WAF is added for the demo: pay-as-you-go WAF would reintroduce a fixed web-ACL/rule floor that can exceed the rest of this application. CloudFront's $0 Free flat-rate plan may provide bundled WAF and a delivery cost ceiling, but enrollment and configuration compatibility must be reviewed separately rather than silently changed by this stack.

One-time meetings use the existing HTTP API, ARM Lambda, DynamoDB table, GSI1, and table TTL. They add storage and request units only when meetings are created, read, or changed; creates transactionally write the meeting and activity plus a replay claim that becomes TTL-cleanup eligible after 24 hours when keyed, while patches write the meeting and activity. Serialized meeting content is capped at 32 KiB so even the duplicated keyed-create payload retains headroom below the default 200-WRU table/GSI ceilings. This write amplification is request-driven and bounded, with no meeting-specific idle charge. Recurring-series generation, invitations, and reminders remain disabled until their EventBridge Scheduler/queue/SES behavior is implemented and separately cost-gated.

## Implemented cost controls

- DynamoDB on-demand billing with configurable maximum read/write request units on the table and both GSIs.
- HTTP API steady-state and burst throttles before compute, with lower overrides for the anonymous demo and public health route.
- An ARM API Lambda with configurable reserved concurrency and no provisioned concurrency.
- Seven-day authenticated-API logs, three-day infrastructure-provider and optional demo/reset logs, and optional focused API, table, reset, and DLQ alarms. The hosted production path requires `TEAMSPACES_BUDGET_EMAIL`, which wires alarms to an SNS email subscription.
- S3 lifecycle expiry for noncurrent web versions, incomplete multipart uploads, old document versions, delete markers, and objects tagged `state=pending`.
- Private S3 origins, CloudFront caching, no VPC/NAT gateway, no permanent VM/container/database, and no baseline search cluster.
- An optional tag-filtered $5 monthly AWS Budget alerts at 60%, 90%, forecasted 90%, and 100%. Notifications require `TEAMSPACES_BUDGET_EMAIL`; budgets are delayed alerts, not hard spending caps.

Activate the user-defined `application` cost-allocation tag in the payer account before relying on the `user:application$teamspaces` budget filter. Keep a separate account-wide safety budget when this AWS account hosts other applications.

## Feature cost gates

Capability additions follow these defaults:

| Capability | Default serverless implementation | Cost rule |
| --- | --- | --- |
| Notifications, projections, imports, exports, webhooks | DynamoDB Streams/S3 events -> SQS/DLQ -> Lambda | Pay per event; cap worker concurrency and batch writes |
| Reminders, recurring meetings, date alerts, digests | EventBridge Scheduler -> queue/worker | Pay per invocation; delete completed schedules |
| Email | Durable in-app notification first, SES digest by default | Per-recipient; no dedicated IP or always-on mail service |
| Metadata/rich-text search | Bounded DynamoDB token/prefix projections | Included in normal request/storage use |
| Attachment-content full text | Optional scale-to-zero search pipeline | Enable only with a named budget and measured need; active search compute can exceed the whole pilot budget |
| Malware scanning | Event-driven, opt-in S3 scanning | Pay per object/GB; quarantine until a clean result |
| Live collaboration | API Gateway WebSocket + Lambda/DynamoDB operation log | Pay per message/connection minute; enable per account/module |
| BIM | Client-side IFC viewing where practical; event-driven conversion only when required | Store models in S3 and cap conversion concurrency |
| External integrations | Queue-backed connector workers | No polling faster than necessary; honor provider and AWS budgets |

Aurora, OpenSearch, ECS, EKS, EC2, NAT gateways, and provisioned concurrency are not baseline dependencies. A context-gated service can be introduced only with a measured access pattern, scale-to-zero behavior where available, a rollback path, and an updated monthly estimate.

## Pricing references

- [AWS Lambda pricing](https://aws.amazon.com/lambda/pricing/)
- [Amazon API Gateway pricing](https://aws.amazon.com/api-gateway/pricing/)
- [Amazon DynamoDB pricing](https://aws.amazon.com/dynamodb/pricing/)
- [Amazon S3 pricing](https://aws.amazon.com/s3/pricing/)
- [Amazon CloudFront pricing](https://aws.amazon.com/cloudfront/pricing/)
- [Amazon Cognito pricing](https://aws.amazon.com/cognito/pricing/)
- [Amazon CloudWatch pricing](https://aws.amazon.com/cloudwatch/pricing/)
- [AWS Budgets pricing](https://aws.amazon.com/aws-cost-management/aws-budgets/pricing/)
- [Amazon SQS pricing](https://aws.amazon.com/sqs/pricing/)
- [Amazon EventBridge pricing](https://aws.amazon.com/eventbridge/pricing/)
- [HTTP API route throttling](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-throttling.html)
- [DynamoDB on-demand capacity](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/on-demand-capacity-mode.html)
- [Amazon SES pricing](https://aws.amazon.com/ses/pricing/)
