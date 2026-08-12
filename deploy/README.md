# Auto-deploy to Apps Script

Push to `main` and GitHub Actions pushes the `.gs` files into your two Apps
Script projects. No copying into the editor.

| Repo file | Apps Script project |
|---|---|
| `PIMS_SLACK_TO_OBSIDIAN.gs` | vault (Slack → Obsidian) |
| `weekly_work_summary/WEEKLY_WORK_SUMMARY.gs` | weekly Wed–Tue summary |

## One-time setup

Do this once. After that, deploys are automatic.

### 1. Turn on the Apps Script API

Visit [script.google.com/home/usersettings](https://script.google.com/home/usersettings)
and switch **Google Apps Script API** to **On**. Without this, `clasp` cannot
write to your projects.

### 2. Log in with clasp locally

On your Mac:

```bash
npm install -g @google/clasp@2.4.2
clasp login
```

A browser opens; approve access. This writes credentials to `~/.clasprc.json`.

### 3. Collect the two script IDs

Open each Apps Script project → **Project Settings** → copy the **Script ID**.
Or read it from the editor URL:

`https://script.google.com/home/projects/`**`THIS_PART`**`/edit`

### 4. Add three repository secrets

In GitHub: `PIMS_MultiSource` → Settings → Secrets and variables → Actions →
**New repository secret**.

| Secret | Value |
|---|---|
| `CLASPRC_JSON` | entire contents of `~/.clasprc.json` (`cat ~/.clasprc.json` and paste) |
| `VAULT_SCRIPT_ID` | script ID of the vault project |
| `WEEKLY_SCRIPT_ID` | script ID of the weekly summary project |

`CLASPRC_JSON` holds an OAuth refresh token for your Google account. Keep this
repository private, and rotate the secret with `clasp login` if it ever leaks.

### 5. Trigger the first deploy

Actions tab → **Deploy Apps Script** → **Run workflow**. Watch it go green,
then confirm the code changed in the Apps Script editor.

## What a deploy does and does not touch

Overwrites the **code files** in each project. Leaves everything else alone:

- **Script Properties** (`SLACK_USER_TOKEN`, `ANTHROPIC_API_KEY`, folder IDs)
  are project settings, not code. They survive.
- **Triggers** bind to function names, so the Wednesday 8:37 AM schedule keeps
  running against the new code.
- **Authorization** persists unless the manifest requests new OAuth scopes. If
  it does, Google prompts you the next time the script runs.

## When you still have to do something by hand

- New Script Property (a new folder ID, a rotated token) — set it in the editor.
- New OAuth scope — reauthorize once when prompted.
- `clasp` credentials expire — rerun `clasp login` and update `CLASPRC_JSON`.
  The symptom is the deploy job failing on an auth error.

## Manual deploy from your Mac

If you ever need to bypass CI:

```bash
git pull
rm -rf build/vault && mkdir -p build/vault
cp deploy/vault/appsscript.json build/vault/
cp PIMS_SLACK_TO_OBSIDIAN.gs build/vault/PIMS_SLACK_TO_OBSIDIAN.js
echo '{"scriptId":"YOUR_VAULT_SCRIPT_ID","rootDir":"build/vault"}' > .clasp.json
clasp push --force
```
