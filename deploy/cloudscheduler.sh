#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

# Template script for provisioning external 24/7 Cloud Scheduler -> NEXA HTTP Trigger.
# Does NOT embed secrets: pulls NEXA_SCHEDULER_TOKEN directly from Google Secret Manager with xtrace disabled.
# Replace PROJECT_ID, REGION, and SERVICE_URL before executing against a live GCP project.

PROJECT_ID="${PROJECT_ID:?Set GCP PROJECT_ID}"
REGION="${REGION:-europe-west1}"
TIMEZONE="${TIMEZONE:-Europe/Rome}"
SERVICE_URL="${SERVICE_URL:?Set external HTTPS Cloud Run / VM base URL, e.g. https://nexa-xxxx.a.run.app}"
SECRET_NAME="${SECRET_NAME:-nexa-scheduler-token}"
JOB_NAME="${JOB_NAME:-nexa-commerce-run-due}"

SCHEDULER_TOKEN="$(gcloud secrets versions access latest --secret="${SECRET_NAME}" --project="${PROJECT_ID}")"
if [ "${#SCHEDULER_TOKEN}" -lt 24 ]; then
  echo "Error: retrieved scheduler token is shorter than 24 characters." >&2
  exit 1
fi

TARGET_URI="${SERVICE_URL%/}/api/commerce/schedules/run-due"

if gcloud scheduler jobs describe "${JOB_NAME}" --location="${REGION}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "${JOB_NAME}" \
    --project="${PROJECT_ID}" \
    --location="${REGION}" \
    --schedule="0 */6 * * *" \
    --time-zone="${TIMEZONE}" \
    --uri="${TARGET_URI}" \
    --http-method=POST \
    --headers="Content-Type=application/json,x-nexa-scheduler-token=${SCHEDULER_TOKEN}" \
    --message-body='{"source":"google_cloud_scheduler"}' \
    --attempt-deadline=180s \
    --max-retry-attempts=3 \
    --min-backoff=30s \
    --max-backoff=300s
else
  gcloud scheduler jobs create http "${JOB_NAME}" \
    --project="${PROJECT_ID}" \
    --location="${REGION}" \
    --schedule="0 */6 * * *" \
    --time-zone="${TIMEZONE}" \
    --uri="${TARGET_URI}" \
    --http-method=POST \
    --headers="Content-Type=application/json,x-nexa-scheduler-token=${SCHEDULER_TOKEN}" \
    --message-body='{"source":"google_cloud_scheduler"}' \
    --attempt-deadline=180s \
    --max-retry-attempts=3 \
    --min-backoff=30s \
    --max-backoff=300s
fi

echo "Cloud Scheduler job '${JOB_NAME}' configured for ${TARGET_URI} (${TIMEZONE})."
