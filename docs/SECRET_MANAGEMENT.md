# Secret management

Battle Bus runtime credentials belong in Google Secret Manager. Cloud Run may
receive them only through `valueFrom.secretKeyRef`; a plaintext `value` entry is
not permitted for a name listed in `config/gcp-secret-env-names.txt`.

## Live migration

From an authenticated operator workstation:

```bash
gcloud auth login
gcloud config set project battle-bus-509406
./scripts/migrate-cloud-run-secrets.sh
```

The migration script never prints credential values. It:

1. Reads the existing Cloud Run service configuration into a mode-`0600`
   temporary file.
2. Creates a Secret Manager secret and version for each configured plaintext
   credential.
3. Grants only the Battle Bus runtime service account access to those secrets.
4. Creates a no-traffic Cloud Run candidate revision using secret references.
5. Verifies the health and Inngest endpoints before promoting the revision.

Variables absent from the service are reported but no empty secret versions are
created. Variables already backed by Secret Manager are left unchanged.

## Adding or rotating a credential

Add a new Secret Manager version by passing the value on standard input, never
as a command-line argument, source value, `.env` file, issue, or CI variable:

```bash
gcloud secrets versions add SECRET_ID --data-file=- --project=battle-bus-509406
```

Paste the value only at the terminal input prompt. Deploy a new Cloud Run
revision after rotation because `latest` is resolved when an instance starts.

## Repository safeguards

- `.env*`, Google authentication files, PEM files, and local data are ignored.
- CI scans each proposed change with Gitleaks.
- Deployment fails if a credential-classified Cloud Run variable is plaintext.
- GitHub Actions authenticates through Workload Identity Federation and only
  accepts `main` branch identities from the two approved repositories.

## Historical exposure

A redacted history scan identified old committed D365, Shopify, GPS, Slack, OMS,
and webhook credentials. Removing a value from the current branch does not make
an exposed credential safe. Rotate or revoke every affected provider credential
first. Rewriting Git history is a separate coordinated operation because it
invalidates existing commit IDs and requires every collaborator to re-clone or
reset their local repository.
