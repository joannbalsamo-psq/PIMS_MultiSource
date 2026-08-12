"""Guards for the Apps Script auto-deploy config.

A typo here fails silently at deploy time, so check the wiring in CI instead.
"""

from __future__ import annotations

import json
import pathlib
import unittest

ROOT = pathlib.Path(__file__).parent
WORKFLOW = ROOT / ".github/workflows/deploy-apps-script.yml"

PROJECTS = {
    "vault": {
        "manifest": ROOT / "deploy/vault/appsscript.json",
        "source": ROOT / "PIMS_SLACK_TO_OBSIDIAN.gs",
        "secret": "VAULT_SCRIPT_ID",
    },
    "weekly": {
        "manifest": ROOT / "deploy/weekly/appsscript.json",
        "source": ROOT / "weekly_work_summary/WEEKLY_WORK_SUMMARY.gs",
        "secret": "WEEKLY_SCRIPT_ID",
    },
}


class ManifestTests(unittest.TestCase):
    def test_manifests_are_valid_json(self):
        for name, cfg in PROJECTS.items():
            with self.subTest(project=name):
                data = json.loads(cfg["manifest"].read_text(encoding="utf-8"))
                self.assertEqual(data["runtimeVersion"], "V8")
                self.assertEqual(data["timeZone"], "America/New_York")

    def test_manifests_enable_drive_advanced_service(self):
        # Both scripts call Drive.Files directly; without this the push
        # deploys code that throws at runtime.
        for name, cfg in PROJECTS.items():
            with self.subTest(project=name):
                data = json.loads(cfg["manifest"].read_text(encoding="utf-8"))
                services = data["dependencies"]["enabledAdvancedServices"]
                symbols = [s["userSymbol"] for s in services]
                self.assertIn("Drive", symbols)


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.text = WORKFLOW.read_text(encoding="utf-8")

    def test_sources_exist(self):
        for name, cfg in PROJECTS.items():
            with self.subTest(project=name):
                self.assertTrue(cfg["source"].exists(), f"{cfg['source']} missing")

    def test_workflow_references_each_project(self):
        for name, cfg in PROJECTS.items():
            with self.subTest(project=name):
                rel = cfg["source"].relative_to(ROOT).as_posix()
                self.assertIn(rel, self.text)
                self.assertIn(cfg["secret"], self.text)

    def test_workflow_pins_clasp_and_uses_credentials(self):
        self.assertIn("@google/clasp@2.4.2", self.text)
        self.assertIn("CLASPRC_JSON", self.text)
        self.assertIn(".clasprc.json", self.text)


if __name__ == "__main__":
    unittest.main()
