#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# github-docs-sync setup script
# Automates Firebase project setup, secret configuration, Cloud Run deployment,
# and Cloud Functions deployment.
# ─────────────────────────────────────────────────────────────────────────────

BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
RESET='\033[0m'

info()  { echo -e "${GREEN}[+]${RESET} $1"; }
warn()  { echo -e "${YELLOW}[!]${RESET} $1"; }
error() { echo -e "${RED}[x]${RESET} $1"; }
step()  { echo -e "\n${BOLD}── $1 ──${RESET}"; }
prompt() {
  local var_name=$1 prompt_text=$2 default=${3:-}
  if [[ -n "$default" ]]; then
    read -rp "$(echo -e "${BOLD}$prompt_text${RESET} ${DIM}[$default]${RESET}: ")" value
    eval "$var_name=\"${value:-$default}\""
  else
    read -rp "$(echo -e "${BOLD}$prompt_text${RESET}: ")" value
    eval "$var_name=\"$value\""
  fi
}
confirm() {
  read -rp "$(echo -e "${BOLD}$1${RESET} ${DIM}[Y/n]${RESET}: ")" yn
  [[ -z "$yn" || "$yn" =~ ^[Yy] ]]
}
secret_prompt() {
  local var_name=$1 prompt_text=$2
  read -srp "$(echo -e "${BOLD}$prompt_text${RESET}: ")" value
  echo
  eval "$var_name=\"$value\""
}

# ─────────────────────────────────────────────────────────────────────────────
# Preflight checks
# ─────────────────────────────────────────────────────────────────────────────

step "Preflight checks"

missing=()
command -v gcloud  >/dev/null 2>&1 || missing+=("gcloud (Google Cloud SDK)")
command -v firebase >/dev/null 2>&1 || missing+=("firebase (Firebase CLI)")
command -v node    >/dev/null 2>&1 || missing+=("node (Node.js)")
command -v npm     >/dev/null 2>&1 || missing+=("npm")

if [[ ${#missing[@]} -gt 0 ]]; then
  error "Missing required tools:"
  for tool in "${missing[@]}"; do echo "  - $tool"; done
  exit 1
fi

info "All required CLIs found"

# Check gcloud auth
if ! gcloud auth print-access-token >/dev/null 2>&1; then
  warn "Not authenticated with gcloud"
  info "Running: gcloud auth login"
  gcloud auth login
fi

# Check firebase auth
if ! firebase projects:list >/dev/null 2>&1; then
  warn "Not authenticated with Firebase"
  info "Running: firebase login"
  firebase login
fi

info "Authenticated with gcloud and Firebase"

# ─────────────────────────────────────────────────────────────────────────────
# Project configuration
# ─────────────────────────────────────────────────────────────────────────────

step "Project configuration"

prompt PROJECT_ID "Firebase/GCP project ID"
prompt REGION "Cloud Run / Functions region" "us-central1"
prompt GITHUB_REPO "GitHub repo to sync (owner/repo)"

echo
info "Project:  $PROJECT_ID"
info "Region:   $REGION"
info "Repo:     $GITHUB_REPO"
echo
if ! confirm "Continue with these settings?"; then
  error "Aborted"
  exit 1
fi

# Set gcloud project
gcloud config set project "$PROJECT_ID" 2>/dev/null
info "gcloud project set to $PROJECT_ID"

# ─────────────────────────────────────────────────────────────────────────────
# Enable required APIs
# ─────────────────────────────────────────────────────────────────────────────

step "Enabling GCP APIs"

apis=(
  cloudfunctions.googleapis.com
  firestore.googleapis.com
  run.googleapis.com
  cloudbuild.googleapis.com
  secretmanager.googleapis.com
  drive.googleapis.com
)

for api in "${apis[@]}"; do
  info "Enabling $api..."
  gcloud services enable "$api" --quiet
done

info "All APIs enabled"

# ─────────────────────────────────────────────────────────────────────────────
# Firestore setup
# ─────────────────────────────────────────────────────────────────────────────

step "Firestore setup"

if gcloud firestore databases describe --project="$PROJECT_ID" >/dev/null 2>&1; then
  info "Firestore database already exists"
else
  info "Creating Firestore database in $REGION..."
  gcloud firestore databases create --location="$REGION" --quiet
  info "Firestore database created"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Firebase project setup
# ─────────────────────────────────────────────────────────────────────────────

step "Firebase project setup"

# Update .firebaserc
cat > .firebaserc <<EOF
{
  "projects": {
    "default": "$PROJECT_ID"
  }
}
EOF
info "Updated .firebaserc with project $PROJECT_ID"
firebase use "$PROJECT_ID"

# ─────────────────────────────────────────────────────────────────────────────
# Secrets
# ─────────────────────────────────────────────────────────────────────────────

step "Secret configuration"

echo -e "${DIM}These secrets are stored in Google Secret Manager and injected into Cloud Functions at runtime.${RESET}"
echo

# GITHUB_WEBHOOK_SECRET
if confirm "Generate a random webhook secret?"; then
  WEBHOOK_SECRET=$(openssl rand -hex 32)
  info "Generated webhook secret (save this for GitHub webhook config)"
  echo -e "  ${DIM}$WEBHOOK_SECRET${RESET}"
else
  secret_prompt WEBHOOK_SECRET "Enter GitHub webhook secret"
fi

echo "$WEBHOOK_SECRET" | firebase functions:secrets:set GITHUB_WEBHOOK_SECRET --data-file=-
info "Set GITHUB_WEBHOOK_SECRET"

# GITHUB_TOKEN
echo
warn "You need a GitHub fine-grained PAT with Contents: Read-only on $GITHUB_REPO"
secret_prompt GITHUB_TOKEN "Enter GitHub token"
echo "$GITHUB_TOKEN" | firebase functions:secrets:set GITHUB_TOKEN --data-file=-
info "Set GITHUB_TOKEN"

# DRIVE_SHARED_DRIVE_ID
echo
warn "Find this in the Google Drive URL: drive.google.com/drive/folders/<DRIVE_ID>"
prompt DRIVE_ID "Google Shared Drive ID"
echo "$DRIVE_ID" | firebase functions:secrets:set DRIVE_SHARED_DRIVE_ID --data-file=-
info "Set DRIVE_SHARED_DRIVE_ID"

# DRIVE_DOCS_FOLDER_ID
prompt FOLDER_ID "Root folder ID within the Shared Drive" "$DRIVE_ID"
echo "$FOLDER_ID" | firebase functions:secrets:set DRIVE_DOCS_FOLDER_ID --data-file=-
info "Set DRIVE_DOCS_FOLDER_ID"

# ─────────────────────────────────────────────────────────────────────────────
# Shared Drive permissions reminder
# ─────────────────────────────────────────────────────────────────────────────

step "Google Drive permissions"

SA_EMAIL=$(gcloud iam service-accounts list \
  --filter="displayName:Default compute service account" \
  --format="value(email)" 2>/dev/null || true)

if [[ -z "$SA_EMAIL" ]]; then
  SA_EMAIL=$(gcloud iam service-accounts list \
    --filter="displayName:App Engine default service account" \
    --format="value(email)" 2>/dev/null || true)
fi

if [[ -n "$SA_EMAIL" ]]; then
  warn "Add this service account as a Content Manager on your Shared Drive:"
  echo -e "  ${BOLD}$SA_EMAIL${RESET}"
else
  warn "Could not detect service account email. Add your project's default service account"
  warn "as a Content Manager on the Google Shared Drive."
fi

echo
if ! confirm "Have you added the service account to the Shared Drive?"; then
  warn "Remember to do this before running sync — functions won't be able to write to Drive otherwise."
fi

# ─────────────────────────────────────────────────────────────────────────────
# Deploy Mermaid renderer to Cloud Run
# ─────────────────────────────────────────────────────────────────────────────

step "Deploying Mermaid renderer to Cloud Run"

info "Building and deploying docker/mermaid-renderer..."
MERMAID_URL=$(gcloud run deploy mermaid-renderer \
  --source docker/mermaid-renderer \
  --region "$REGION" \
  --memory 2Gi \
  --cpu 1 \
  --min-instances 0 \
  --max-instances 3 \
  --no-allow-unauthenticated \
  --quiet \
  --format="value(status.url)" 2>&1 | tail -1)

# If the deploy didn't return a clean URL, fetch it
if [[ ! "$MERMAID_URL" =~ ^https:// ]]; then
  MERMAID_URL=$(gcloud run services describe mermaid-renderer \
    --region "$REGION" \
    --format="value(status.url)")
fi

info "Mermaid renderer deployed at: $MERMAID_URL"

# Grant the default compute SA permission to invoke the Cloud Run service
if [[ -n "$SA_EMAIL" ]]; then
  gcloud run services add-iam-policy-binding mermaid-renderer \
    --region="$REGION" \
    --member="serviceAccount:$SA_EMAIL" \
    --role="roles/run.invoker" \
    --quiet >/dev/null 2>&1
  info "Granted Cloud Run invoker role to $SA_EMAIL"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Deploy Cloud Functions
# ─────────────────────────────────────────────────────────────────────────────

step "Deploying Cloud Functions"

info "Installing dependencies..."
(cd functions && npm install --silent)

info "Deploying functions with MERMAID_RENDERER_URL=$MERMAID_URL..."
firebase deploy --only functions \
  --force \
  -- --set-env-vars="MERMAID_RENDERER_URL=$MERMAID_URL" 2>/dev/null \
  || firebase deploy --only functions --force

info "Deploying Firestore rules..."
firebase deploy --only firestore:rules

# Get the function URL
FUNCTION_URL=$(firebase functions:list 2>/dev/null | grep syncDocsToDrive | awk '{print $NF}' || true)
if [[ -z "$FUNCTION_URL" ]]; then
  FUNCTION_URL="https://$REGION-$PROJECT_ID.cloudfunctions.net/syncDocsToDrive"
fi

# ─────────────────────────────────────────────────────────────────────────────
# GitHub webhook setup
# ─────────────────────────────────────────────────────────────────────────────

step "GitHub webhook setup"

if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  if confirm "Create the GitHub webhook automatically via gh CLI?"; then
    gh api "repos/$GITHUB_REPO/hooks" \
      --method POST \
      -f "name=web" \
      -f "config[url]=$FUNCTION_URL" \
      -f "config[content_type]=json" \
      -f "config[secret]=$WEBHOOK_SECRET" \
      -F "config[insecure_ssl]=0" \
      -f "events[]=push" \
      -F "active=true" >/dev/null
    info "Webhook created on $GITHUB_REPO"
  else
    warn "Skipped — create it manually (details below)"
  fi
else
  warn "gh CLI not available or not authenticated — create the webhook manually:"
fi

echo
echo -e "  ${BOLD}Webhook URL:${RESET}    $FUNCTION_URL"
echo -e "  ${BOLD}Content type:${RESET}   application/json"
echo -e "  ${BOLD}Secret:${RESET}         $WEBHOOK_SECRET"
echo -e "  ${BOLD}Events:${RESET}         push"

# ─────────────────────────────────────────────────────────────────────────────
# Initial sync
# ─────────────────────────────────────────────────────────────────────────────

step "Initial sync"

if confirm "Run initial sync now to import all existing docs?"; then
  info "Triggering initial sync for $GITHUB_REPO..."
  TOKEN=$(gcloud auth print-identity-token)
  curl -s -X POST "$FUNCTION_URL" \
    -H "Authorization: Bearer $TOKEN" \
    -H "X-Webhook-Secret: $WEBHOOK_SECRET" \
    -H "Content-Type: application/json" \
    -d "{\"repo\": \"$GITHUB_REPO\"}" | python3 -m json.tool 2>/dev/null || true
  echo
  info "Initial sync triggered"
else
  info "Skipped — run manually later:"
  echo -e "  ${DIM}curl -X POST \"$FUNCTION_URL\" \\${RESET}"
  echo -e "  ${DIM}  -H \"Authorization: Bearer \$(gcloud auth print-identity-token)\" \\${RESET}"
  echo -e "  ${DIM}  -H \"X-Webhook-Secret: <secret>\" \\${RESET}"
  echo -e "  ${DIM}  -H \"Content-Type: application/json\" \\${RESET}"
  echo -e "  ${DIM}  -d '{\"repo\": \"$GITHUB_REPO\"}'${RESET}"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Done
# ─────────────────────────────────────────────────────────────────────────────

step "Setup complete"

echo
info "Mermaid renderer: $MERMAID_URL"
info "Webhook endpoint: $FUNCTION_URL"
info "Firebase project: $PROJECT_ID"
info "Syncing repo:     $GITHUB_REPO"
echo
warn "Remember: the Firebase service account must be a Content Manager on the Shared Drive."
echo
