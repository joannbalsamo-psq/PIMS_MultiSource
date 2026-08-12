"""Unit tests for PIMS vault helpers."""

from __future__ import annotations

import pathlib
import re
import unittest

from vault_helpers import (
    DEFAULT_CHANNEL_ID,
    DEFAULT_FOLDER_TREE,
    DEFAULT_VAULT_FOLDER_ID,
    FOLDER_DEFAULT,
    FOLDER_SME,
    canonical_name,
    chunk_messages,
    classify_cleanup_targets,
    is_duplicate_name,
    note_filename,
    normalize_phase2_notes,
    phase1_markdown,
    relative_note_path,
    sanitize_note_title,
    source_register_markdown,
    topic_note_markdown,
    upsert_plan,
)

GS_PATH = pathlib.Path(__file__).with_name("PIMS_SLACK_TO_OBSIDIAN.gs")


class DefaultsInSyncTests(unittest.TestCase):
    """The Apps Script must ship the same pinned IDs as the Python helpers."""

    def setUp(self):
        self.gs = GS_PATH.read_text(encoding="utf-8")

    def _gs_const(self, name: str) -> str:
        m = re.search(rf'var {name}\s*=\s*"([^"]+)"', self.gs)
        self.assertIsNotNone(m, f"{name} missing from PIMS_SLACK_TO_OBSIDIAN.gs")
        return m.group(1)

    def test_vault_folder_id_is_pinned_and_matches(self):
        self.assertEqual(self._gs_const("DEFAULT_VAULT_FOLDER_ID"), DEFAULT_VAULT_FOLDER_ID)
        self.assertEqual(DEFAULT_VAULT_FOLDER_ID, "1SVDcQubc8NcWYHAxLhjSHnchdOS5wZoz")

    def test_channel_id_matches(self):
        self.assertEqual(self._gs_const("DEFAULT_CHANNEL_ID"), DEFAULT_CHANNEL_ID)

    def test_vault_id_has_a_default_fallback(self):
        # Regression: the folder ID used to exist only as a Script Property key,
        # so a fresh Apps Script project had no vault to write to.
        self.assertIn(
            'p.getProperty("PIMS_VAULT_FOLDER_ID") || DEFAULT_VAULT_FOLDER_ID',
            self.gs,
        )

    def test_folder_tree_matches_live_vault(self):
        # Regression: the script shipped a folder tree that did not exist in the
        # vault, so a Phase 2 run created 9 parallel folders next to the real ones.
        self.assertEqual(
            DEFAULT_FOLDER_TREE,
            [
                "00 - Start Here",
                "01 - SIS Integrations",
                "02 - SFTP & File Format Reference",
                "03 - SSO & Authentication",
                "04 - Core Product Features",
                "05 - Data & Sync Troubleshooting",
                "06 - Implementation Process & Playbooks",
                "07 - Known Issues & Tribal Knowledge Register",
                "08 - Internal Tools",
                "09 - Glossary & FAQ",
                "10 - Regional & Regulatory Specifics",
                "11 - Subject Matter Experts Directory",
                "12 - Raw Source Materials",
            ],
        )

    def test_gs_folder_tree_matches_python(self):
        block = re.search(r"var DEFAULT_FOLDER_TREE = \[(.*?)\];", self.gs, re.S)
        self.assertIsNotNone(block, "DEFAULT_FOLDER_TREE missing from .gs")
        gs_folders = re.findall(r'"([^"]+)"', block.group(1))
        self.assertEqual(gs_folders, DEFAULT_FOLDER_TREE)

    def test_fallback_folders_exist_in_tree(self):
        self.assertIn(FOLDER_DEFAULT, DEFAULT_FOLDER_TREE)
        self.assertIn(FOLDER_SME, DEFAULT_FOLDER_TREE)
        for name in ["FOLDER_DEFAULT", "FOLDER_SME", "FOLDER_DOC_GAPS"]:
            self.assertIn("var " + name + " =", self.gs)


class NamingTests(unittest.TestCase):
    def test_sanitize_and_filename(self):
        self.assertEqual(sanitize_note_title("A/B: C*"), "A B C")
        self.assertEqual(note_filename("Roster sync"), "Roster sync.md")
        self.assertEqual(
            relative_note_path("01 - SIS Integrations", "PowerSchool"),
            "01 - SIS Integrations/PowerSchool.md",
        )

    def test_duplicate_detection(self):
        self.assertTrue(is_duplicate_name("Welcome (1).md"))
        self.assertTrue(is_duplicate_name("PSQ IMP (2)"))
        self.assertFalse(is_duplicate_name("Welcome.md"))
        self.assertFalse(is_duplicate_name("PIMS"))
        self.assertEqual(canonical_name("Welcome (1).md"), "Welcome.md")
        self.assertEqual(canonical_name("Folder (3)"), "Folder")


class CleanupTests(unittest.TestCase):
    def test_classify_trash_dupes_and_stale_root(self):
        result = classify_cleanup_targets(
            ["PIMS", "PSQ IMP", "Welcome (1).md", "Welcome.md", "notes (2).md"],
            stale_root_names=["PSQ IMP"],
        )
        self.assertEqual(
            sorted(result["trash"]),
            ["PSQ IMP", "Welcome (1).md", "notes (2).md"],
        )
        self.assertEqual(sorted(result["keep"]), ["PIMS", "Welcome.md"])


class UpsertPlanTests(unittest.TestCase):
    def test_create_when_missing(self):
        plan = upsert_plan(["Other.md"], "Welcome.md")
        self.assertEqual(plan["action"], "create")
        self.assertEqual(plan["trash_names"], [])

    def test_update_trashes_duplicate_siblings(self):
        plan = upsert_plan(
            ["Welcome.md", "Welcome (1).md", "Welcome (2).md"],
            "Welcome.md",
        )
        self.assertEqual(plan["action"], "update")
        self.assertEqual(
            sorted(plan["trash_names"]),
            ["Welcome (1).md", "Welcome (2).md"],
        )

    def test_create_still_trashes_orphaned_dupes(self):
        plan = upsert_plan(["Welcome (1).md"], "Welcome.md")
        self.assertEqual(plan["action"], "create")
        self.assertEqual(plan["trash_names"], ["Welcome (1).md"])


class CorpusAndRenderTests(unittest.TestCase):
    def test_chunk_messages(self):
        msgs = [{"text": "x" * 40} for _ in range(5)]
        batches = chunk_messages(msgs, max_chars=100)
        self.assertGreater(len(batches), 1)
        self.assertEqual(sum(len(b) for b in batches), 5)

    def test_phase1_and_topic_render(self):
        md = phase1_markdown(
            {
                "channel": "implementation-team",
                "generated": "2026-08-02",
                "executive_summary": "Summary here.",
                "topics": [{"title": "SIS sync", "why_it_matters": "Frequent", "confidence": "high"}],
                "recurring_questions": [{"question": "How to map schools?", "context": "PowerSchool"}],
                "struggles": [{"area": "Rostering", "why": "Field mismatches"}],
                "tribal_knowledge": [{"title": "Tip", "detail": "Check district ID"}],
                "doc_gaps": [{"gap": "No SIS matrix", "detail": "Need table"}],
                "smes": [{"name": "Alex", "specialty": "PowerSchool"}],
                "product_sis_frequency": [{"name": "PowerSchool", "count": 12}],
            }
        )
        self.assertIn("# Phase 1 Analysis", md)
        self.assertIn("SIS sync", md)
        self.assertIn("Alex", md)

        note_md = topic_note_markdown(
            {
                "title": "PowerSchool roster",
                "folder": "01 - SIS Integrations",
                "summary": "How rostering works.",
                "body": "Step 1...",
                "tags": ["sis", "powerschool"],
                "sources": [{"label": "thread", "url": "https://slack.com/x", "quote": "use API"}],
                "related": ["School mapping"],
            }
        )
        self.assertIn("# PowerSchool roster", note_md)
        self.assertIn("#sis", note_md)
        self.assertIn("[[School mapping]]", note_md)

    def test_normalize_phase2_and_register(self):
        notes = normalize_phase2_notes(
            {
                "notes": [
                    {
                        "title": "Bad/Name",
                        "folder": "05 - Data & Sync Troubleshooting",
                        "body": "Do X",
                    }
                ]
            }
        )
        self.assertEqual(notes[0]["title"], "Bad Name")
        self.assertTrue(notes[0]["path"].endswith("Bad Name.md"))
        reg = source_register_markdown(
            [{"path": notes[0]["path"], "updated": "2026-08-02", "action": "create", "notes": "ok"}]
        )
        self.assertIn("Source Register", reg)
        self.assertIn(notes[0]["path"], reg)


if __name__ == "__main__":
    unittest.main()
