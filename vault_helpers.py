"""Pure helpers for PIMS Slack → Obsidian vault automation.

Keep naming / path / cleanup rules in sync with PIMS_SLACK_TO_OBSIDIAN.gs.
"""

from __future__ import annotations

import re
from typing import Any

# Obsidian vault root on Drive. Pinned by ID so renaming the folder
# (PSQ IMP → PIMS) never breaks the automation.
DEFAULT_VAULT_FOLDER_ID = "1SVDcQubc8NcWYHAxLhjSHnchdOS5wZoz"  # PIMS
DEFAULT_CHANNEL_ID = "C04CZ6CVD2B"
DEFAULT_CHANNEL_NAME = "implementation-team"

# Stable vault layout — folder *names* may be renamed by the human; writers
# always resolve the vault root by Drive folder ID, then create/find these
# relative paths inside it.
DEFAULT_FOLDER_TREE = [
    "00 - Start Here",
    "01 - SIS Integrations",
    "02 - Rostering & Data",
    "03 - Communications Setup",
    "04 - Smart Sites & Portals",
    "05 - Attendance & Integrations",
    "06 - Implementation Process & Playbooks",
    "07 - Troubleshooting Runbooks",
    "08 - Product Gotchas",
    "09 - Tribal Knowledge",
    "10 - SMEs & Who to Ask",
    "11 - Doc Gaps & Open Questions",
    "12 - Raw Source Materials",
]

DUPLICATE_NAME_RE = re.compile(
    r"^(?P<base>.+?)(?:\s*\((\d+)\))?(?P<ext>\.[A-Za-z0-9]+)?$"
)


def sanitize_note_title(name: str | None) -> str:
    """Safe Obsidian note title (no path separators / illegal filename chars)."""
    cleaned = re.sub(r'[\/\\:\*\?"<>\|\x00-\x1f]', " ", str(name or ""))
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" .")
    return cleaned or "Untitled note"


def note_filename(title: str | None) -> str:
    return f"{sanitize_note_title(title)}.md"


def relative_note_path(folder: str, title: str | None) -> str:
    folder = str(folder or "").strip().strip("/")
    return f"{folder}/{note_filename(title)}" if folder else note_filename(title)


def is_duplicate_name(name: str | None) -> bool:
    """True for Drive/Finder-style copies: 'Foo (1).md', 'Bar (2)'."""
    name = str(name or "").strip()
    if not name:
        return False
    m = DUPLICATE_NAME_RE.match(name)
    if not m:
        return False
    return m.group(2) is not None


def canonical_name(name: str | None) -> str:
    """Strip a trailing ' (N)' duplicate suffix, keep extension."""
    name = str(name or "").strip()
    m = DUPLICATE_NAME_RE.match(name)
    if not m:
        return name
    base = m.group("base").rstrip()
    ext = m.group("ext") or ""
    return f"{base}{ext}"


def classify_cleanup_targets(
    names: list[str],
    *,
    stale_root_names: list[str] | None = None,
) -> dict[str, list[str]]:
    """Partition filenames/foldernames into keep vs trash candidates.

    - Duplicate-suffixed names always trash.
    - Exact matches in stale_root_names (e.g. old 'PSQ IMP' after rename to
      'PIMS') are trash candidates when scanning a *parent* of the vault.
    """
    stale = {s.strip() for s in (stale_root_names or []) if s and s.strip()}
    trash: list[str] = []
    keep: list[str] = []
    for raw in names:
        name = str(raw or "").strip()
        if not name:
            continue
        if is_duplicate_name(name) or name in stale:
            trash.append(name)
        else:
            keep.append(name)
    return {"keep": keep, "trash": trash}


def upsert_plan(
    existing_names: list[str],
    desired_name: str,
) -> dict[str, Any]:
    """Decide how to write `desired_name` without creating '(1)' copies.

    Returns action:
      - update: reuse the canonical file; trash any duplicate-suffixed siblings
      - create: no canonical file yet
    """
    desired = str(desired_name or "").strip()
    if not desired:
        raise ValueError("desired_name required")

    exact: list[str] = []
    dupes: list[str] = []
    for n in existing_names:
        name = str(n or "").strip()
        if not name:
            continue
        if name == desired:
            exact.append(name)
        elif is_duplicate_name(name) and canonical_name(name) == desired:
            dupes.append(name)

    if exact:
        # Keep the first exact match; trash extra exact copies + all dupes.
        return {
            "action": "update",
            "target_name": desired,
            "trash_names": exact[1:] + dupes,
        }
    return {
        "action": "create",
        "target_name": desired,
        "trash_names": dupes,
    }


def chunk_messages(
    messages: list[dict[str, Any]],
    *,
    max_chars: int = 90000,
) -> list[list[dict[str, Any]]]:
    """Split Slack messages into character-budgeted batches for Claude."""
    batches: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    size = 0
    for msg in messages:
        piece = _message_footprint(msg)
        if current and size + piece > max_chars:
            batches.append(current)
            current = []
            size = 0
        current.append(msg)
        size += piece
    if current:
        batches.append(current)
    return batches


def format_message_corpus(messages: list[dict[str, Any]]) -> str:
    lines: list[str] = []
    for m in messages:
        ts = str(m.get("ts") or m.get("datetime") or "")
        user = str(m.get("user_name") or m.get("user") or "unknown")
        text = str(m.get("text") or "").replace("\n", " ").strip()
        if not text:
            continue
        lines.append(f"[{ts}] {user}: {text}")
    return "\n".join(lines)


def phase1_markdown(analysis: dict[str, Any]) -> str:
    """Render Phase 1 organizational analysis as one Obsidian note."""
    a = analysis or {}
    parts = [
        "---",
        "type: phase1-analysis",
        f"channel: {a.get('channel') or DEFAULT_CHANNEL_NAME}",
        f"generated: {a.get('generated') or ''}",
        "---",
        "",
        "# Phase 1 Analysis — Implementation Intelligence",
        "",
        str(a.get("executive_summary") or "").strip(),
        "",
        "## Top topics (ranked)",
        "",
    ]
    for i, t in enumerate(a.get("topics") or [], 1):
        title = t.get("title") or t.get("name") or f"Topic {i}"
        why = t.get("why_it_matters") or t.get("summary") or ""
        conf = t.get("confidence") or ""
        parts.append(f"{i}. **{title}** — {why}" + (f" _(confidence: {conf})_" if conf else ""))
    parts.extend(["", "## Recurring questions", ""])
    for q in a.get("recurring_questions") or []:
        if isinstance(q, dict):
            parts.append(f"- **{q.get('question') or q.get('q')}** — {q.get('context') or q.get('notes') or ''}")
        else:
            parts.append(f"- {q}")
    parts.extend(["", "## Where IMs struggle (and why)", ""])
    for s in a.get("struggles") or []:
        if isinstance(s, dict):
            parts.append(f"- **{s.get('area') or s.get('title')}** — {s.get('why') or s.get('detail') or ''}")
        else:
            parts.append(f"- {s}")
    parts.extend(["", "## Tribal knowledge", ""])
    for t in a.get("tribal_knowledge") or []:
        if isinstance(t, dict):
            parts.append(f"- **{t.get('title') or 'Note'}** — {t.get('detail') or t.get('text') or ''}")
        else:
            parts.append(f"- {t}")
    parts.extend(["", "## Documentation gaps", ""])
    for g in a.get("doc_gaps") or []:
        if isinstance(g, dict):
            parts.append(f"- **{g.get('gap') or g.get('title')}** — {g.get('detail') or ''}")
        else:
            parts.append(f"- {g}")
    parts.extend(["", "## SMEs / who to ask", ""])
    for s in a.get("smes") or []:
        if isinstance(s, dict):
            parts.append(
                f"- **{s.get('name') or s.get('person')}** — "
                f"{s.get('specialty') or s.get('topics') or ''} "
                f"({s.get('evidence') or 'channel activity'})"
            )
        else:
            parts.append(f"- {s}")
    parts.extend(["", "## Product / SIS frequency", ""])
    for p in a.get("product_sis_frequency") or a.get("sis_frequency") or []:
        if isinstance(p, dict):
            parts.append(
                f"- **{p.get('name') or p.get('product')}** — "
                f"mentions: {p.get('count') or p.get('mentions') or '?'} — "
                f"{p.get('notes') or ''}"
            )
        else:
            parts.append(f"- {p}")
    parts.extend(["", "## Candidate Obsidian folder structure", ""])
    for f in a.get("folder_structure") or DEFAULT_FOLDER_TREE:
        parts.append(f"- `{f}`")
    parts.append("")
    return "\n".join(parts)


def topic_note_markdown(note: dict[str, Any]) -> str:
    n = note or {}
    tags = n.get("tags") or []
    if isinstance(tags, str):
        tag_line = tags
    else:
        tag_line = " ".join(f"#{str(t).lstrip('#')}" for t in tags if str(t).strip())
    sources = n.get("sources") or n.get("source_links") or []
    source_lines = []
    for s in sources:
        if isinstance(s, dict):
            source_lines.append(
                f"- [{s.get('label') or 'Slack'}]({s.get('url') or ''}) — {s.get('quote') or ''}"
            )
        else:
            source_lines.append(f"- {s}")
    related = n.get("related") or []
    related_lines = [f"- [[{r}]]" for r in related if str(r).strip()]
    body = str(n.get("body") or n.get("content") or "").strip()
    parts = [
        "---",
        f"type: {n.get('type') or 'implementation-knowledge'}",
        f"folder: {n.get('folder') or ''}",
        f"confidence: {n.get('confidence') or ''}",
        f"channel: {n.get('channel') or DEFAULT_CHANNEL_NAME}",
        "---",
        "",
        f"# {sanitize_note_title(n.get('title'))}",
        "",
    ]
    if tag_line:
        parts.extend([tag_line, ""])
    if n.get("summary"):
        parts.extend([str(n.get("summary")).strip(), ""])
    parts.extend([body, ""])
    if source_lines:
        parts.extend(["## Sources", ""] + source_lines + [""])
    if related_lines:
        parts.extend(["## Related", ""] + related_lines + [""])
    return "\n".join(parts).rstrip() + "\n"


def source_register_markdown(entries: list[dict[str, Any]], *, channel: str = DEFAULT_CHANNEL_NAME) -> str:
    parts = [
        "---",
        "type: source-register",
        f"channel: {channel}",
        "---",
        "",
        "# Source Register",
        "",
        "Tracks what the automation wrote into this vault. Safe to re-run — "
        "notes are upserted by exact path, never duplicated as `(1)` copies.",
        "",
        "| Path | Updated | Action | Notes |",
        "|---|---|---|---|",
    ]
    for e in entries or []:
        parts.append(
            f"| `{e.get('path') or ''}` | {e.get('updated') or ''} | "
            f"{e.get('action') or ''} | {e.get('notes') or ''} |"
        )
    parts.append("")
    return "\n".join(parts)


def vault_guide_markdown() -> str:
    folders = "\n".join(f"- `{f}/`" for f in DEFAULT_FOLDER_TREE)
    return (
        "---\n"
        "type: vault-guide\n"
        "---\n\n"
        "# Vault Guide — PIMS\n\n"
        "This vault is maintained by the `pims_slack_to_obsidian` Apps Script.\n\n"
        "## Rules that prevent Claude/Cowork file loss\n\n"
        "1. The vault root is pinned by **Google Drive folder ID**, not folder name. "
        "Renaming `PSQ IMP` → `PIMS` is safe.\n"
        "2. Notes are **upserted** by exact filename inside each folder. Re-runs "
        "update in place and never create `Note (1).md`.\n"
        "3. Run `cleanupVaultDuplicates` after any manual Drive copy/paste mishap.\n"
        "4. Phase 1 writes analysis only; Phase 2 builds/updates topic notes.\n\n"
        "## Folder map\n\n"
        f"{folders}\n"
    )


def welcome_markdown() -> str:
    return (
        "---\n"
        "type: welcome\n"
        "---\n\n"
        "# Welcome — ParentSquare Implementation Knowledge (PIMS)\n\n"
        "Technical acumen distilled from `#implementation-team` and related IM "
        "channels, organized for Obsidian.\n\n"
        "Start at [[Phase 1 Analysis — Implementation Intelligence]] and the "
        "[[Source Register]].\n"
    )


def normalize_phase2_notes(obj: dict[str, Any] | None) -> list[dict[str, Any]]:
    obj = obj or {}
    notes = obj.get("notes") or obj.get("topic_notes") or []
    out: list[dict[str, Any]] = []
    for n in notes:
        if not isinstance(n, dict):
            continue
        title = sanitize_note_title(n.get("title") or n.get("name"))
        folder = str(n.get("folder") or "09 - Tribal Knowledge").strip()
        out.append(
            {
                "title": title,
                "folder": folder,
                "path": relative_note_path(folder, title),
                "type": n.get("type") or "implementation-knowledge",
                "confidence": n.get("confidence") or "",
                "summary": n.get("summary") or "",
                "body": n.get("body") or n.get("content") or "",
                "tags": n.get("tags") or [],
                "sources": n.get("sources") or [],
                "related": n.get("related") or [],
                "channel": n.get("channel") or DEFAULT_CHANNEL_NAME,
            }
        )
    return out


def _message_footprint(msg: dict[str, Any]) -> int:
    return len(str(msg.get("text") or "")) + 48
