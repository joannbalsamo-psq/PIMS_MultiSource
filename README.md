# PIMS MultiSource

Automations that pull **multiple sources** (Slack, Calendar, Drive, Zoom) into
durable Google destinations — without relying on Claude Cowork chat sessions.

| Package | What it does | Destination |
|---|---|---|
| [`PIMS_SLACK_TO_OBSIDIAN.gs`](./PIMS_SLACK_TO_OBSIDIAN.gs) | `#implementation-team` history → Phase 1/2 knowledge notes | [PIMS Obsidian vault](https://drive.google.com/drive/folders/1SVDcQubc8NcWYHAxLhjSHnchdOS5wZoz) |
| [`weekly_work_summary/`](./weekly_work_summary/) | Wed–Tue calendar + Supernote + Slack + Zoom → cited weekly bullets | [Work Tracking System [2026]](https://docs.google.com/spreadsheets/d/1jsoHnje92Bb1M91G4S9oe4inhSaGvEi6JUUE3KE1C64) |

Both use Google Apps Script (scheduled, idempotent, folder/sheet IDs baked in).
Cowork is fine for one-off exploration; these scripts own the recurring jobs.

---

## 1) Slack → PIMS Obsidian vault

Pin: Drive folder `1SVDcQubc8NcWYHAxLhjSHnchdOS5wZoz`

1. Paste `PIMS_SLACK_TO_OBSIDIAN.gs` into Apps Script; enable Drive advanced service  
2. Script Properties: `SLACK_USER_TOKEN`, `ANTHROPIC_API_KEY`  
3. Run: `verifyVaultAccess` → `cleanupVaultDuplicates` → `bootstrapVaultSkeleton` → `runPhase1Analysis` → `runPhase2BuildVault`

Details: [`SETUP.txt`](./SETUP.txt)

---

## 2) Weekly Wed–Tue work summary

Ready for review **every Wednesday 8:37 AM Eastern**.

Pulls Google Calendar, Supernote PDFs, 12 Slack channels + bookmarks, Zoom
Drive exports → Claude synthesis → Google Sheet tabs (Meetings, Actions,
Bookmarks, Weekly Summary, Projects) with dated citations. Learns from rows
you mark `approved=TRUE` and from the Learning Evidence tab.

1. Paste `weekly_work_summary/WEEKLY_WORK_SUMMARY.gs` into a **separate** Apps Script project  
2. Set Script Properties (see package SETUP)  
3. Run: `verifyWeeklyAccess` → `ensureSheetSkeleton` → `runWeeklyWorkSummary` → `installWednesdayTrigger`

Details: [`weekly_work_summary/SETUP.txt`](./weekly_work_summary/SETUP.txt)

---

## Local tests

```bash
python -m unittest test_vault_helpers.py -v
python -m unittest weekly_work_summary/test_helpers.py -v
```
