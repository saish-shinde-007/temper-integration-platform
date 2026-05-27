#!/usr/bin/env bash
# Deploy the integration platform to GCP Cloud Run + Temporal Cloud + E2B.
#
# One-time setup before first run:
#   1. `gcloud auth login`
#   2. `gcloud config set project $GCP_PROJECT_ID`
#   3. Enable APIs: `gcloud services enable run.googleapis.com cloudbuild.googleapis.com sqladmin.googleapis.com secretmanager.googleapis.com artifactregistry.googleapis.com`
#   4. Create Artifact Registry repo:
#        `gcloud artifacts repositories create temper --repository-format=docker --location=$GCP_REGION`
#   5. Create Cloud SQL Postgres instance:
#        `gcloud sql instances create temper-pg --tier=db-f1-micro --region=$GCP_REGION --database-version=POSTGRES_15`
#      Then create DB: `gcloud sql databases create temper --instance=temper-pg`
#      And user:       `gcloud sql users create temper --instance=temper-pg --password=<pwd>`
#   6. Sign up at temporal.io/cloud, create a namespace, download the mTLS cert + key.
#   7. Push secrets to Secret Manager:
#        ANTHROPIC_API_KEY, E2B_API_KEY, SECRETS_MASTER_KEY (32 bytes),
#        DATABASE_URL (postgres://temper:<pwd>@/temper?host=/cloudsql/...),
#        TEMPORAL_TLS_CERT (file contents), TEMPORAL_TLS_KEY (file contents).
#   8. Note your Temporal Cloud namespace (e.g. yourorg.tmprl.cloud) and gRPC endpoint.
#
# Required env vars when running this script:
#   GCP_PROJECT_ID
#   GCP_REGION                 (default: us-central1)
#   TEMPORAL_ADDRESS           (e.g. yourorg.tmprl.cloud:7233)
#   TEMPORAL_NAMESPACE         (e.g. yourorg.AccountID)
#   CLOUDSQL_CONNECTION_NAME   (project:region:instance from `gcloud sql instances describe`)

set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:?Set GCP_PROJECT_ID}"
REGION="${GCP_REGION:-us-central1}"
REPO="${ARTIFACT_REPO:-temper}"
TAG="${TAG:-v0.2-$(date +%Y%m%d-%H%M%S)}"
REGISTRY="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}"

TEMPORAL_ADDRESS="${TEMPORAL_ADDRESS:?Set TEMPORAL_ADDRESS (e.g. yourorg.tmprl.cloud:7233)}"
TEMPORAL_NAMESPACE="${TEMPORAL_NAMESPACE:?Set TEMPORAL_NAMESPACE}"
CLOUDSQL_CONNECTION="${CLOUDSQL_CONNECTION_NAME:?Set CLOUDSQL_CONNECTION_NAME (project:region:instance)}"

echo "==> Building + pushing images to ${REGISTRY}..."

build_and_push() {
  local name=$1
  local dockerfile=$2
  echo "  - ${name}"
  gcloud builds submit \
    --tag "${REGISTRY}/${name}:${TAG}" \
    --project="${PROJECT_ID}" \
    --config=/dev/stdin <<EOF
steps:
- name: gcr.io/cloud-builders/docker
  args: ['build', '-t', '${REGISTRY}/${name}:${TAG}', '-f', '${dockerfile}', '.']
images:
- '${REGISTRY}/${name}:${TAG}'
EOF
}

build_and_push "mock-system-a"  "packages/mocks/system-a/Dockerfile"
build_and_push "mock-system-b"  "packages/mocks/system-b/Dockerfile"
build_and_push "api"            "packages/api/Dockerfile"
build_and_push "workflows"      "packages/workflows/Dockerfile"
build_and_push "runner"         "packages/runner/Dockerfile"
build_and_push "ui"             "packages/ui/Dockerfile"

echo ""
echo "==> Deploying to Cloud Run..."

COMMON_FLAGS=(
  "--region=${REGION}"
  "--project=${PROJECT_ID}"
  "--platform=managed"
  "--allow-unauthenticated"
)

deploy() {
  local name=$1; shift
  gcloud run deploy "temper-${name}" \
    --image="${REGISTRY}/${name}:${TAG}" \
    "${COMMON_FLAGS[@]}" \
    "$@"
}

# Mocks first (public URLs needed for E2B to reach them).
deploy "mock-system-a" --port=5001 --memory=256Mi --max-instances=2
deploy "mock-system-b" --port=5002 --memory=256Mi --max-instances=2

MOCK_A_URL=$(gcloud run services describe "temper-mock-system-a" --region="${REGION}" --project="${PROJECT_ID}" --format='value(status.url)')
MOCK_B_URL=$(gcloud run services describe "temper-mock-system-b" --region="${REGION}" --project="${PROJECT_ID}" --format='value(status.url)')

# API + workflow worker + runner (the platform brain).
# Cloud SQL access via the Cloud SQL Auth Proxy sidecar.
deploy "api" \
  --port=4000 --memory=512Mi --max-instances=3 \
  --add-cloudsql-instances="${CLOUDSQL_CONNECTION}" \
  --set-env-vars="TEMPORAL_ADDRESS=${TEMPORAL_ADDRESS},TEMPORAL_NAMESPACE=${TEMPORAL_NAMESPACE},DEMO_TENANT_ID=tenant-demo,DEMO_TENANT_NAME=Demo Tenant,DEMO_USER_EMAIL=demo@example.com,SYSTEM_A_URL=${MOCK_A_URL},SYSTEM_B_URL=${MOCK_B_URL}" \
  --set-secrets="DATABASE_URL=temper-database-url:latest,ANTHROPIC_API_KEY=temper-anthropic-key:latest,E2B_API_KEY=temper-e2b-key:latest,SECRETS_MASTER_KEY=temper-secrets-master:latest,TEMPORAL_TLS_CERT=temper-temporal-cert:latest,TEMPORAL_TLS_KEY=temper-temporal-key:latest"

deploy "workflows" \
  --memory=1Gi --max-instances=2 \
  --no-cpu-throttling \
  --add-cloudsql-instances="${CLOUDSQL_CONNECTION}" \
  --set-env-vars="TEMPORAL_ADDRESS=${TEMPORAL_ADDRESS},TEMPORAL_NAMESPACE=${TEMPORAL_NAMESPACE},SANDBOX_PROVIDER=e2b,AGENT_PROVIDER=agentic,SYSTEM_A_URL=${MOCK_A_URL},SYSTEM_B_URL=${MOCK_B_URL}" \
  --set-secrets="DATABASE_URL=temper-database-url:latest,ANTHROPIC_API_KEY=temper-anthropic-key:latest,E2B_API_KEY=temper-e2b-key:latest,SECRETS_MASTER_KEY=temper-secrets-master:latest,TEMPORAL_TLS_CERT=temper-temporal-cert:latest,TEMPORAL_TLS_KEY=temper-temporal-key:latest"

deploy "runner" \
  --port=5003 --memory=512Mi --max-instances=1 \
  --no-cpu-throttling \
  --add-cloudsql-instances="${CLOUDSQL_CONNECTION}" \
  --set-env-vars="SANDBOX_PROVIDER=e2b,SYSTEM_A_URL=${MOCK_A_URL},SYSTEM_B_URL=${MOCK_B_URL}" \
  --set-secrets="DATABASE_URL=temper-database-url:latest,E2B_API_KEY=temper-e2b-key:latest,SECRETS_MASTER_KEY=temper-secrets-master:latest"

API_URL=$(gcloud run services describe "temper-api" --region="${REGION}" --project="${PROJECT_ID}" --format='value(status.url)')

# UI last so we can wire NEXT_PUBLIC_API_URL.
deploy "ui" \
  --port=3000 --memory=256Mi --max-instances=2 \
  --set-env-vars="NEXT_PUBLIC_API_URL=${API_URL},NEXT_PUBLIC_TENANT_ID=tenant-demo"

UI_URL=$(gcloud run services describe "temper-ui" --region="${REGION}" --project="${PROJECT_ID}" --format='value(status.url)')

echo ""
echo "================================================================"
echo "Deployed!"
echo "  UI:       ${UI_URL}"
echo "  API:      ${API_URL}"
echo "  Mock A:   ${MOCK_A_URL}"
echo "  Mock B:   ${MOCK_B_URL}"
echo "  Temporal: ${TEMPORAL_ADDRESS} (ns: ${TEMPORAL_NAMESPACE})"
echo "  Sandbox:  E2B (Firecracker via SaaS, per-fire + reusable-during-generation)"
echo "================================================================"
