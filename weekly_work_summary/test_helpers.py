"""Unit tests for weekly Wed–Tue work summary helpers."""

from __future__ import annotations

import pathlib
import re
import unittest
from datetime import date

from helpers import (
    DEFAULT_SHEET_ID,
    WEEKLY_SUMMARY_CATEGORIES,
    build_learning_corpus,
    categorize_bookmark,
    email_body,
    filter_messages_by_keywords,
    normalize_synthesis,
    previous_wed_tue_window,
    sheet_rows_for_tab,
    synthesis_prompt_payload,
    week_key_from_window,
)

GS_PATH = pathlib.Path(__file__).with_name("WEEKLY_WORK_SUMMARY.gs")


class DefaultsInSyncTests(unittest.TestCase):
    def setUp(self):
        self.gs = GS_PATH.read_text(encoding="utf-8")

    def _gs_const(self, name: str) -> str:
        m = re.search(rf'var {name}\s*=\s*"([^"]+)"', self.gs)
        self.assertIsNotNone(m, f"{name} missing from WEEKLY_WORK_SUMMARY.gs")
        return m.group(1)

    def test_sheet_id_pinned(self):
        self.assertEqual(self._gs_const("DEFAULT_SHEET_ID"), DEFAULT_SHEET_ID)
        self.assertEqual(DEFAULT_SHEET_ID, "1jsoHnje92Bb1M91G4S9oe4inhSaGvEi6JUUE3KE1C64")

    def test_sheet_id_fallback(self):
        self.assertIn(
            'p.getProperty("WORK_TRACKING_SHEET_ID") || DEFAULT_SHEET_ID',
            self.gs,
        )


class WindowTests(unittest.TestCase):
    def test_wednesday_run_covers_prior_wed_through_tue(self):
        # 2026-08-05 is a Wednesday
        w = previous_wed_tue_window(date(2026, 8, 5))
        self.assertEqual(w["start"], "2026-07-29")
        self.assertEqual(w["end"], "2026-08-04")
        self.assertEqual(w["week_key"], "2026-07-29")

    def test_friday_uses_most_recent_closed_week(self):
        # 2026-08-07 Friday → week ending Tue 2026-08-04
        w = previous_wed_tue_window(date(2026, 8, 7))
        self.assertEqual(w["end"], "2026-08-04")
        self.assertEqual(w["start"], "2026-07-29")

    def test_week_key_helper(self):
        w = previous_wed_tue_window(date(2026, 8, 5))
        self.assertEqual(week_key_from_window(w), "2026-07-29")


class BookmarkAndFilterTests(unittest.TestCase):
    def test_categorize_bookmark(self):
        self.assertEqual(categorize_bookmark("please follow up on roster"), "Action Item")
        self.assertEqual(categorize_bookmark("we are blocked on SSO"), "Blocker")
        self.assertEqual(categorize_bookmark("shipped the attendance fix"), "Project Update")
        self.assertEqual(categorize_bookmark("team sync notes"), "Team News")
        self.assertEqual(categorize_bookmark("interesting article"), "FYI / Reference")

    def test_keyword_filter(self):
        msgs = [
            {"text": "random chat"},
            {"text": "major blocker on SIS"},
            {"text": "we shipped v2"},
        ]
        filtered = filter_messages_by_keywords(msgs)
        self.assertEqual(len(filtered), 2)


class SynthesisTests(unittest.TestCase):
    def test_learning_corpus_and_normalize(self):
        corpus = build_learning_corpus(
            [{"category": "Technical Execution", "bullet": "Fixed SSO", "citation": "Slack#ask", "week_key": "2026-07-22"}],
            [{"date": "2026-07-28", "note": "Prefer shorter bullets", "applies_to": "Weekly Summary"}],
        )
        self.assertIn("Fixed SSO", corpus)
        self.assertIn("Prefer shorter bullets", corpus)

        w = previous_wed_tue_window(date(2026, 8, 5))
        prompt = synthesis_prompt_payload(
            window=w,
            calendar_events=[{"title": "Standup"}],
            supernote_text="Met with district",
            slack_messages=[{"text": "blocker"}],
            slack_bookmarks=[{"text": "todo"}],
            zoom_files=[{"name": "kickoff.mp4"}],
            learning_corpus=corpus,
        )
        self.assertIn("WEEK_KEY: 2026-07-29", prompt)
        self.assertIn("Strategic & Leadership", prompt)

        normalized = normalize_synthesis(
            {
                "meetings_registry": [
                    {
                        "date": "2026-07-30",
                        "title": "Kickoff",
                        "attendees": ["A", "B"],
                        "key_points": ["x"],
                        "action_items": ["y"],
                        "source_links": ["https://cal"],
                        "projects_mentioned": ["SSO"],
                    }
                ],
                "action_items": [{"item": "Follow up", "owner": "Jo", "from_source": "calendar"}],
                "slack_bookmarks_categorized": [{"message": "please action this", "channel": "#ask_dsat"}],
                "weekly_synthesis": [
                    {
                        "category": "Technical Execution",
                        "bullet": "Unblocked SSO",
                        "citation": "Slack #ask_dsat",
                        "date": "2026-07-30",
                    }
                ],
                "project_progress": [
                    {"project": "SSO", "detected_activity": ["threads"], "suggested_new_completion": "60%"}
                ],
            },
            week_key="2026-07-29",
        )
        self.assertEqual(normalized["stats"]["total_meetings"], 1)
        self.assertEqual(normalized["slack_bookmarks"][0]["category"], "Action Item")
        rows = sheet_rows_for_tab("Weekly Summary", normalized)
        self.assertEqual(rows[0][1], "Technical Execution")
        self.assertEqual(len(WEEKLY_SUMMARY_CATEGORIES), 5)

        body = email_body(
            normalized,
            sheet_url="https://docs.google.com/spreadsheets/d/x",
            window=w,
        )
        self.assertIn("Meetings: 1", body)
        self.assertIn("Learning Evidence", body)


if __name__ == "__main__":
    unittest.main()
