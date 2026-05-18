#!/usr/bin/env bash
# Generates an ES256 JWT signing keypair for local development and prints
# the base64-encoded PEMs ready to paste into `.env`.
#
# Production keys are managed by Railway secret manager and rotated quarterly.

set -euo pipefail

tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT

priv_pem="${tmp_dir}/private.pem"
pub_pem="${tmp_dir}/public.pem"

openssl ecparam -name prime256v1 -genkey -noout -out "${priv_pem}"
openssl ec -in "${priv_pem}" -pubout -out "${pub_pem}" 2>/dev/null

echo "JWT_PRIVATE_KEY_BASE64=$(base64 < "${priv_pem}" | tr -d '\n')"
echo "JWT_PUBLIC_KEY_BASE64=$(base64 < "${pub_pem}" | tr -d '\n')"
