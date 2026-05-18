#!/usr/bin/env bash
# Pre-create the S3 buckets the app expects on a clean LocalStack volume.
# Mirrors the R2 buckets we use in staging/prod so dev code paths stay identical.

set -euo pipefail

awslocal s3api create-bucket --bucket dankdash-dev --region us-east-1 >/dev/null 2>&1 || true
awslocal s3api create-bucket --bucket dankdash-uploads --region us-east-1 >/dev/null 2>&1 || true
awslocal s3api create-bucket --bucket dankdash-id-scans --region us-east-1 >/dev/null 2>&1 || true

# ID-scan bucket is PII-sensitive — block public access defensively even though
# LocalStack does not enforce it. This keeps dev parity with the R2 ACL.
awslocal s3api put-public-access-block \
  --bucket dankdash-id-scans \
  --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true \
  >/dev/null 2>&1 || true
