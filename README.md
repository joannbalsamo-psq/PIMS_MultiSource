# PIMS MultiSource

Automations that pull **multiple sources** (Slack, Calendar, Drive, Zoom) into
durable Google destinations — without relying on Claude Cowork chat sessions.

| Package | What it does | Destination |
|---|---|---|
| [`PIMS_SLACK_TO_OBSIDIAN.gs`](./PIMS_SLACK_TO_OBSIDIAN.gs) | `#implementation-team` history → Phase 1/2 knowledge notes | [PIMS Obsidian vault](https://drive.google.com/drive/folders/1SVDcQubc8NcWYHAxLhjSHnchdOS5wZoz) |
| [`weekly_work_summary/`](./weekly_work_summary/) | Wed–Tue calendar + Supernote + Slack + Zoom → cited weekly bullets | [Work Tracking System [2026]](https://docs.google.com/spreadsheets/d/1jsoHnje92Bb1M91G4S9oe4inhSaGvEi6JUUE3KE1C64) |

Both use Google Apps Script (scheduled, idempotent, folder/sheet IDs baked in).
Cowork is fine for one-off exploration; these scripts own the recurring jobs.

**Deployment is automatic.** Merging to `main` pushes the `.gs` files into the
live Apps Script projects via `clasp`, so what runs in Google always matches this
repo — nothing to copy by hand. One-time credential setup: [`deploy/README.md`](./deploy/README.md).

---

## 1) Slack → PIMS Obsidian vault

Pin: Drive folder `1SVDcQubc8NcWYHAxLhjSHnchdOS5wZoz`

The notes themselves are versioned separately in the private `PIMS_Vault` repo,
pushed from Obsidian by the Obsidian Git plugin. This repo holds automation only.

`DEFAULT_FOLDER_TREE` must match the folders that actually exist in the vault.
Rename a folder in Obsidian and you must update that list here (and its mirror in
`vault_helpers.py`), or Phase 2 creates a parallel folder instead of writing into
the existing one. `test_vault_helpers.py` enforces that the two lists agree.

Code deploys itself on merge. You only set Script Properties once
(`SLACK_USER_TOKEN`, `ANTHROPIC_API_KEY`), then run in the editor:

`verifyVaultAccess` → `cleanupVaultDuplicates` → `bootstrapVaultSkeleton` → `runPhase1Analysis` → `runPhase2BuildVault`

Details: [`SETUP.txt`](./SETUP.txt)

---

## 2) Weekly Wed–Tue work summary

Ready for review **every Wednesday 8:37 AM Eastern**.

Pulls Google Calendar, Supernote PDFs, 12 Slack channels + bookmarks, Zoom
Drive exports → Claude synthesis → Google Sheet tabs (Meetings, Actions,
Bookmarks, Weekly Summary, Projects) with dated citations. Learns from rows
you mark `approved=TRUE` and from the Learning Evidence tab.

Lives in a **separate** Apps Script project, also deployed automatically. Set its
Script Properties once (see package SETUP), then run:

`verifyWeeklyAccess` → `ensureSheetSkeleton` → `runWeeklyWorkSummary` → `installWednesdayTrigger`

Details: [`weekly_work_summary/SETUP.txt`](./weekly_work_summary/SETUP.txt)

---

## Local tests

```bash
python -m unittest test_vault_helpers.py -v
python -m unittest test_deploy_config.py -v
cd weekly_work_summary && python -m unittest test_helpers.py -v
```

CI runs all three on every push and pull request.
