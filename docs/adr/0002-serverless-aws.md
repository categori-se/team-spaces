# ADR 0002: Serverless AWS Baseline

## Decision

Use CloudFront, private S3, API Gateway HTTP API, one modular Lambda application, one on-demand DynamoDB table, one private attachment bucket, Cognito, and finite-retention CloudWatch Logs.

The minimal community profile does not create CloudWatch metric alarms, SNS notifications, an AWS Budget, point-in-time recovery, or the shared public-demo/reset lane. Operators can enable those layers explicitly when their recovery and monitoring value justifies their stored-data or shared-allowance cost.

## Consequences

There are no permanent VMs, containers, database servers, load balancers, NAT gateways, provisioned database capacity, or managed search clusters in the baseline. Requests, stored data, transfer, identity usage, and explicitly enabled operational layers can still incur charges.
