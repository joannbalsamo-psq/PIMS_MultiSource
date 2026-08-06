"""Pure helpers for weekly Wed–Tue work summary automation.

Keep week-window / sheet / learning rules in sync with WEEKLY_WORK_SUMMARY.gs.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any

# Work Tracking System [2026]
DEFAULT_SHEET_ID = "1jsoHnje92Bb1M91G4S9oe4inhSaGvEi6JUUE3KE1C64"
DEFAULT_TZ = "America/New_York"

WEEKLY_SUMMARY_CATEGORIES = [
    "Strategic & Leadership",
    "Technical Execution",
    "Blockers & Risk",
    "Team & Collaboration",
    "Learning & Growth",
]

DEFAULT_SLACK_CHANNELS = [
    "implementation-team",
    "summer2026_support-helpers",
    "ask_dsat",
    "ask-comms-product",
    "ask-implementation-comms",
    "ask-smart-sites-product",
    "attendance-plus-integrations",
    "remind-to-psq-bts-collaboration",
    "icc-implementation_command_center",
    "im-preassignment-requests",
    "incident-comms",
    "nyric_im",
]

SLACK_KEYWORD_HINTS = (
    "technical",
    "decision",
    "blocker",
    "milestone",
    "shipped",
    "launched",
)

SHEET_TABS = [
    "Meetings Registry",
    "Action Items",
    "Slack Bookmarks",
    "Weekly Summary",
    "Projects & Goals",
    "Learning Evidence",
    "Run Log",
]


def previous_wed_tue_window(as_of: date | None = None) -> dict[str, str]:
    """Return the most recently completed Wed–Tue window relative to `as_of`.

    If today is Wednesday (review day), the window is last Wed → this Tue.
    Otherwise walk back to the Tuesday that closed the latest full W–T week.
    """
    today = as_of or date.today()
    # weekday(): Mon=0 … Sun=6. Wednesday=2, Tuesday=1.
    if today.weekday() == 2:  # Wednesday morning run
        end = today - timedelta(days=1)  # Tuesday
    else:
        # Most recent Tuesday on or before today
        days_since_tue = (today.weekday() - 1) % 7
        end = today - timedelta(days=days_since_tue)
    start = end - timedelta(days=6)  # prior Wednesday
    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "week_key": start.isoformat(),  # Wednesday start date
        "label": f"{start.isoformat()} → {end.isoformat()} (Wed–Tue)",
    }


def week_key_from_window(window: dict[str, Any]) -> str:
    return str(window.get("week_key") or window.get("start") or "")


def filter_messages_by_keywords(
    messages: list[dict[str, Any]],
    keywords: tuple[str, ...] | list[str] = SLACK_KEYWORD_HINTS,
) -> list[dict[str, Any]]:
    keys = [k.lower() for k in keywords]
    out: list[dict[str, Any]] = []
    for m in messages:
        text = str(m.get("text") or "").lower()
        if any(k in text for k in keys):
            out.append(m)
    return out


def categorize_bookmark(text: str | None) -> str:
    t = str(text or "").lower()
    if any(w in t for w in ("todo", "action", "please", "need to", "follow up", "follow-up", "assign")):
        return "Action Item"
    if any(w in t for w in ("block", "stuck", "blocked", "risk", "sev", "incident")):
        return "Blocker"
    if any(w in t for w in ("ship", "launch", "milestone", "progress", "deploy", "release")):
        return "Project Update"
    if any(w in t for w in ("team", "collab", "sync", "huddle", "offsite")):
        return "Team News"
    return "FYI / Reference"


def build_learning_corpus(
    approved_bullets: list[dict[str, Any]],
    evidence_notes: list[dict[str, Any]] | None = None,
    *,
    max_items: int = 40,
) -> str:
    """Format prior approved bullets + evidence for the Claude prompt."""
    lines: list[str] = ["# Learning examples (mimic tone, citation style, category mix)", ""]
    for b in (approved_bullets or [])[:max_items]:
        cat = b.get("category") or ""
        bullet = b.get("bullet") or b.get("text") or ""
        cite = b.get("citation") or b.get("source") or ""
        week = b.get("week_key") or b.get("date") or ""
        lines.append(f"- [{cat}] ({week}) {bullet} — cite: {cite}")
    if evidence_notes:
        lines.extend(["", "# Explicit evidence / corrections from the human", ""])
        for e in evidence_notes[:max_items]:
            lines.append(
                f"- {e.get('date') or ''}: {e.get('note') or e.get('text') or ''} "
                f"(applies to: {e.get('applies_to') or 'general'})"
            )
    return "\n".join(lines).strip() + "\n"


def synthesis_prompt_payload(
    *,
    window: dict[str, Any],
    calendar_events: list[dict[str, Any]],
    supernote_text: str,
    slack_messages: list[dict[str, Any]],
    slack_bookmarks: list[dict[str, Any]],
    zoom_files: list[dict[str, Any]],
    learning_corpus: str,
) -> str:
    """Build the analysis prompt (JSON-only response expected)."""
    return (
        "You are a professional work synthesis and project tracking AI for a "
        "ParentSquare product/implementation leader.\n\n"
        f"WEEK WINDOW (Wed–Tue): {window.get('label')}\n"
        f"WEEK_KEY: {week_key_from_window(window)}\n\n"
        "CHANNELS MONITORED: "
        + ", ".join(f"#{c}" for c in DEFAULT_SLACK_CHANNELS)
        + "\n\n"
        "LEARN FROM THESE PRIOR APPROVED EXAMPLES AND CORRECTIONS — match tone, "
        "category balance, citation specificity, and what the human keeps vs deletes:\n"
        f"{learning_corpus}\n\n"
        "ANALYZE THIS WEEK'S DATA AND RETURN STRICT JSON WITH KEYS:\n"
        "1. meetings_registry: [{date, time, title, attendees, key_points, "
        "action_items, source_links, projects_mentioned}]\n"
        "2. action_items: [{date, item, owner, due, status, priority, project, from_source}]\n"
        "3. slack_bookmarks_categorized: [{timestamp, channel, message, category, "
        "suggested_action, confidence}] categories must be one of: "
        "Action Item | Project Update | Blocker | Team News | FYI / Reference\n"
        "4. project_progress: [{project, previous_completion, detected_activity, "
        "suggested_new_completion, confidence}]\n"
        "5. weekly_synthesis: [{category, date, bullet, citation}] where category is "
        "one of: " + " | ".join(WEEKLY_SUMMARY_CATEGORIES) + "\n"
        "6. stats: {total_meetings, total_action_items, bookmarks_categorized, "
        "projects_with_progress}\n\n"
        "Every weekly_synthesis bullet MUST include a dated, citable reference "
        "(calendar event, Slack permalink/channel+ts, Supernote page, or Zoom file name).\n"
        "Prefer durable outcomes over busywork. Do not invent sources.\n"
        "RETURN ONLY VALID JSON. NO MARKDOWN OR PREAMBLE.\n\n"
        f"CALENDAR EVENTS:\n{ _jsonish(calendar_events) }\n\n"
        f"SUPERNOTE MEETING NOTES:\n{supernote_text or '(none)'}\n\n"
        f"SLACK MESSAGES:\n{ _jsonish(slack_messages) }\n\n"
        f"SLACK BOOKMARKS:\n{ _jsonish(slack_bookmarks) }\n\n"
        f"ZOOM FILES:\n{ _jsonish(zoom_files) }\n"
    )


def normalize_synthesis(obj: dict[str, Any] | None, *, week_key: str) -> dict[str, Any]:
    """Coerce Claude JSON into sheet-ready structures."""
    obj = obj or {}
    meetings = []
    for m in obj.get("meetings_registry") or []:
        if not isinstance(m, dict):
            continue
        meetings.append(
            {
                "week_key": week_key,
                "date": m.get("date") or "",
                "time": m.get("time") or "",
                "title": m.get("title") or "",
                "attendees": _join(m.get("attendees")),
                "key_points": _join(m.get("key_points")),
                "action_items": _join(m.get("action_items")),
                "source_links": _join(m.get("source_links")),
                "projects": _join(m.get("projects_mentioned") or m.get("projects")),
            }
        )

    actions = []
    for a in obj.get("action_items") or []:
        if not isinstance(a, dict):
            continue
        actions.append(
            {
                "week_key": week_key,
                "date": a.get("date") or "",
                "item": a.get("item") or a.get("task") or "",
                "owner": a.get("owner") or "",
                "due": a.get("due") or "",
                "status": a.get("status") or "open",
                "priority": a.get("priority") or "",
                "project": a.get("project") or "",
                "from_source": a.get("from_source") or a.get("source") or "",
            }
        )

    bookmarks = []
    for b in obj.get("slack_bookmarks_categorized") or []:
        if not isinstance(b, dict):
            continue
        msg = b.get("message") or b.get("text") or ""
        bookmarks.append(
            {
                "week_key": week_key,
                "timestamp": b.get("timestamp") or b.get("date") or "",
                "channel": str(b.get("channel") or "").lstrip("#"),
                "message": msg,
                "category": b.get("category") or categorize_bookmark(msg),
                "suggested_action": b.get("suggested_action") or "",
                "confidence": b.get("confidence") or "",
                "status": b.get("status") or "new",
            }
        )

    synthesis = []
    for s in obj.get("weekly_synthesis") or []:
        if not isinstance(s, dict):
            continue
        cat = s.get("category") or ""
        if cat not in WEEKLY_SUMMARY_CATEGORIES:
            # soft-map unknown categories into Technical Execution
            cat = "Technical Execution"
        synthesis.append(
            {
                "week_key": week_key,
                "category": cat,
                "date": s.get("date") or week_key,
                "bullet": s.get("bullet") or s.get("text") or "",
                "citation": s.get("citation") or s.get("source") or "",
                "approved": "",  # human fills TRUE after review
            }
        )

    projects = []
    for p in obj.get("project_progress") or []:
        if not isinstance(p, dict):
            continue
        projects.append(
            {
                "week_key": week_key,
                "project": p.get("project") or p.get("name") or "",
                "previous_completion": p.get("previous_completion") or p.get("previous_completion_%") or "",
                "detected_activity": _join(p.get("detected_activity")),
                "suggested_new_completion": p.get("suggested_new_completion")
                or p.get("suggested_new_completion_%")
                or "",
                "confidence": p.get("confidence") or "",
                "last_progress_date": week_key,
            }
        )

    stats = obj.get("stats") or {}
    return {
        "week_key": week_key,
        "meetings_registry": meetings,
        "action_items": actions,
        "slack_bookmarks": bookmarks,
        "weekly_synthesis": synthesis,
        "project_progress": projects,
        "stats": {
            "total_meetings": stats.get("total_meetings", len(meetings)),
            "total_action_items": stats.get("total_action_items", len(actions)),
            "bookmarks_categorized": stats.get("bookmarks_categorized", len(bookmarks)),
            "projects_with_progress": stats.get("projects_with_progress", len(projects)),
        },
    }


def sheet_rows_for_tab(tab: str, normalized: dict[str, Any]) -> list[list[Any]]:
    """Headerless data rows for a given sheet tab (headers owned by the sheet)."""
    if tab == "Meetings Registry":
        return [
            [
                r["week_key"],
                r["date"],
                r["time"],
                r["title"],
                r["attendees"],
                r["key_points"],
                r["action_items"],
                r["source_links"],
                r["projects"],
            ]
            for r in normalized.get("meetings_registry") or []
        ]
    if tab == "Action Items":
        return [
            [
                r["week_key"],
                r["date"],
                r["item"],
                r["owner"],
                r["due"],
                r["status"],
                r["priority"],
                r["project"],
                r["from_source"],
            ]
            for r in normalized.get("action_items") or []
        ]
    if tab == "Slack Bookmarks":
        return [
            [
                r["week_key"],
                r["timestamp"],
                r["channel"],
                r["message"],
                r["category"],
                r["suggested_action"],
                r["status"],
                r["confidence"],
            ]
            for r in normalized.get("slack_bookmarks") or []
        ]
    if tab == "Weekly Summary":
        return [
            [
                r["week_key"],
                r["category"],
                r["date"],
                r["bullet"],
                r["citation"],
                r["approved"],
            ]
            for r in normalized.get("weekly_synthesis") or []
        ]
    if tab == "Projects & Goals":
        return [
            [
                r["week_key"],
                r["project"],
                r["previous_completion"],
                r["detected_activity"],
                r["suggested_new_completion"],
                r["confidence"],
                r["last_progress_date"],
            ]
            for r in normalized.get("project_progress") or []
        ]
    raise ValueError(f"unknown tab: {tab}")


def email_body(normalized: dict[str, Any], *, sheet_url: str, window: dict[str, Any]) -> str:
    stats = normalized.get("stats") or {}
    return (
        f"Your weekly work summary is ready for review.\n\n"
        f"Window: {window.get('label')}\n"
        f"Meetings: {stats.get('total_meetings', 0)}\n"
        f"Action items: {stats.get('total_action_items', 0)}\n"
        f"Bookmarks categorized: {stats.get('bookmarks_categorized', 0)}\n"
        f"Projects with progress: {stats.get('projects_with_progress', 0)}\n\n"
        f"Sheet: {sheet_url}\n\n"
        "Please review the Weekly Summary tab. Mark approved=TRUE on bullets you keep, "
        "edit freely, and add notes to Learning Evidence — next week will learn from those.\n"
    )


def parse_iso_date(value: str | date | datetime | None) -> date | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value)[:10])


def _join(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, list):
        return "; ".join(str(v).strip() for v in value if str(v).strip())
    return str(value).strip()


def _jsonish(value: Any) -> str:
    import json

    try:
        return json.dumps(value, ensure_ascii=False, default=str)[:120000]
    except TypeError:
        return str(value)[:120000]
