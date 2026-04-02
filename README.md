# github-docs-sync

Sync GitHub repo markdown docs to a Google Shared Drive as formatted Google Docs with Mermaid diagram rendering.

## Features

- **Markdown to Google Docs** — Full formatting: headings, tables, lists, code blocks
- **Mermaid diagrams** — Rendered as high-res PNG via private Cloud Run service (3x DPI)
- **Incremental sync** — Content SHA-256 hashing skips unchanged files
- **Diagram cache** — Firestore-backed cache for rendered Mermaid diagrams
- **Auto-TOC** — Generates a "Documentation Index" Google Doc at the Drive root
- **Cross-reference linking** — Resolves internal `.md` links to Google Doc URLs
- **Broken link checker** — Detects and annotates dead internal links
- **Metadata headers** — Source path, commit author/date, sync timestamp on each doc
- **Sensitive content filter** — Blocks files containing API keys, AWS creds, PII
- **Version history** — Commit descriptions on each Drive file update

## Architecture

```
GitHub push webhook
  → syncDocsToDrive (Firebase Cloud Function)
    → Fetch changed docs via GitHub API
    → Filter sensitive content
    → Convert markdown to HTML (with mermaid → Cloud Run renderer)
    → Upsert as Google Docs in Shared Drive
    → Update Firestore tracking + TOC + cross-references

syncDocsInitial (HTTP trigger)
  → Bulk sync all docs in repo (initial setup)
```

### Components

| Component | Location | Purpose |
|-----------|----------|---------|
| `syncDocsToDrive` | `functions/src/syncDocsToDrive.ts` | Webhook handler for incremental sync |
| `syncDocsInitial` | `functions/src/syncDocsInitial.ts` | Bulk initial sync of all docs |
| `docSync/*` | `functions/src/docSync/` | Modular sync logic (9 modules) |
| `mermaid-renderer` | `docker/mermaid-renderer/` | Cloud Run service for diagram rendering |

### Secrets (Google Secret Manager)

| Secret | Purpose |
|--------|---------|
| `GITHUB_WEBHOOK_SECRET` | Webhook HMAC-SHA256 signature verification |
| `GITHUB_TOKEN` | GitHub API access (for private repos) |
| `DRIVE_SHARED_DRIVE_ID` | Target Google Shared Drive ID |
| `DRIVE_DOCS_FOLDER_ID` | Root folder ID within the Shared Drive |

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `MERMAID_RENDERER_URL` | Base URL of the Mermaid renderer Cloud Run service |

### Firestore Collections

| Collection | Purpose |
|------------|---------|
| `doc_sync_state` | Tracks sync operations and last-synced commit SHA |
| `doc_sync_files` | Maps repo file paths to Google Drive file IDs |
| `doc_sync_diagram_cache` | Caches rendered Mermaid diagram hashes |

## Quick Start

```bash
git clone https://github.com/yourusername/github-docs-sync.git
cd github-docs-sync
./setup.sh
```

The interactive setup script handles everything: enabling GCP APIs, creating Firestore, setting secrets, deploying the Mermaid renderer to Cloud Run, deploying Cloud Functions, and optionally creating the GitHub webhook and running the initial sync.

### Prerequisites

- [Google Cloud SDK](https://cloud.google.com/sdk/docs/install) (`gcloud`)
- [Firebase CLI](https://firebase.google.com/docs/cli) (`firebase`)
- [Node.js](https://nodejs.org/) 22+
- A GCP project with billing enabled
- A Google Shared Drive
- A GitHub fine-grained PAT with **Contents: Read-only** on the target repo
- *(Optional)* [GitHub CLI](https://cli.github.com/) (`gh`) for automatic webhook creation

### Manual Setup

If you prefer to set things up step by step:

<details>
<summary>Click to expand manual steps</summary>

#### 1. Configure Firebase

```bash
firebase use your-project-id
```

#### 2. Enable GCP APIs

```bash
gcloud services enable \
  cloudfunctions.googleapis.com \
  firestore.googleapis.com \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  secretmanager.googleapis.com \
  drive.googleapis.com
```

#### 3. Create Firestore database

```bash
gcloud firestore databases create --location=us-central1
```

#### 4. Set secrets

```bash
firebase functions:secrets:set GITHUB_WEBHOOK_SECRET
firebase functions:secrets:set GITHUB_TOKEN
firebase functions:secrets:set DRIVE_SHARED_DRIVE_ID
firebase functions:secrets:set DRIVE_DOCS_FOLDER_ID
```

#### 5. Deploy the Mermaid renderer

```bash
gcloud run deploy mermaid-renderer \
  --source docker/mermaid-renderer \
  --region us-central1 \
  --memory 2Gi \
  --cpu 1 \
  --min-instances 0 \
  --max-instances 3 \
  --no-allow-unauthenticated
```

Set `MERMAID_RENDERER_URL` as an environment variable for your Cloud Functions (the base URL of the deployed service).

#### 6. Deploy functions and rules

```bash
cd functions && npm install
firebase deploy --only functions
firebase deploy --only firestore:rules
```

#### 7. Add service account to Shared Drive

Add your project's default service account as a **Content Manager** on the Google Shared Drive.

#### 8. Configure GitHub Webhook

- **URL:** `https://<region>-<project>.cloudfunctions.net/syncDocsToDrive`
- **Content type:** `application/json`
- **Secret:** Same value as `GITHUB_WEBHOOK_SECRET`
- **Events:** Just `push`

#### 9. Initial sync

```bash
curl -X POST "https://<function-url>/syncDocsInitial" \
  -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
  -H "X-Webhook-Secret: <your-webhook-secret>" \
  -H "Content-Type: application/json" \
  -d '{"repo": "owner/repo-name"}'
```

</details>

## Customization

The file patterns that trigger syncing are defined in [types.ts](functions/src/docSync/types.ts):

```typescript
export const DOC_FILE_PATTERNS = {
  prefixes: ["docs/"],
  exactMatches: ["CLAUDE.md", "README.md", "CONTRIBUTING.md"],
};
```

Edit these to match your repository structure.

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

## License

[MIT](LICENSE)
