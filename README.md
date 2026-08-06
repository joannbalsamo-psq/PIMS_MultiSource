# PIMS MultiSource

Automates extraction of ParentSquare Implementation Manager technical knowledge
from Slack (`#implementation-team`) into the **PIMS** Obsidian vault on Google Drive.

This is a standalone repo (not part of xRECURSIVE). It exists so Cowork/Claude
sessions stop losing vault files when the Drive folder is renamed or when Drive
creates `(1)` duplicate copies.

## Vault

Pinned by Drive folder ID (rename-safe):

https://drive.google.com/drive/folders/1SVDcQubc8NcWYHAxLhjSHnchdOS5wZoz

## Quick start

1. Open `PIMS_SLACK_TO_OBSIDIAN.gs` → paste into a new [Apps Script](https://script.google.com) project
2. Enable **Drive API** (Advanced Google service)
3. Script Properties → set only:
   - `SLACK_USER_TOKEN`
   - `ANTHROPIC_API_KEY`
4. Run in order: `verifyVaultAccess` → `cleanupVaultDuplicates` → `bootstrapVaultSkeleton` → `runPhase1Analysis` → `runPhase2BuildVault`

Full setup: [`SETUP.txt`](./SETUP.txt)

## Files

| File | Role |
|---|---|
| `PIMS_SLACK_TO_OBSIDIAN.gs` | Google Apps Script (Slack history → Claude → Obsidian `.md` upserts) |
| `vault_helpers.py` | Pure helpers mirrored by the `.gs` (naming, upsert plan, cleanup) |
| `test_vault_helpers.py` | Unit tests |
| `SETUP.txt` | One-time setup |

## Local tests

```bash
python -m unittest test_vault_helpers.py -v
```
