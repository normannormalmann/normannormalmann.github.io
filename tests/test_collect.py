import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "scripts"))

from collect import asset_kind, merge  # noqa: E402


class AssetKindTest(unittest.TestCase):
    def test_classifies_update_manifests(self):
        self.assertEqual(asset_kind("latest.yml"), "update_check")
        self.assertEqual(asset_kind("latest-linux.yml"), "update_check")

    def test_classifies_installers_and_deltas(self):
        self.assertEqual(asset_kind("App-Setup-1.0.exe"), "install")
        self.assertEqual(asset_kind("App-1.0.AppImage"), "install")
        self.assertEqual(asset_kind("App-Setup-1.0.exe.blockmap"), "delta_update")

    def test_unknown_files_are_other(self):
        self.assertEqual(asset_kind("checksums.txt"), "other")


class MergeTest(unittest.TestCase):
    def test_new_rows_override_same_key_and_keep_old_days(self):
        existing = [{"date": "2026-11-01", "repo": "a", "views": "3"},
                    {"date": "2026-11-02", "repo": "a", "views": "1"}]
        new = [{"date": "2026-11-02", "repo": "a", "views": 5},
               {"date": "2026-11-03", "repo": "a", "views": 2}]
        result = merge(existing, new, ["date", "repo"])
        self.assertEqual([r["views"] for r in result], ["3", "5", "2"])

    def test_does_not_mutate_inputs(self):
        existing = [{"date": "2026-11-01", "repo": "a", "views": "3"}]
        merge(existing, [{"date": "2026-11-01", "repo": "a", "views": 9}], ["date", "repo"])
        self.assertEqual(existing[0]["views"], "3")

    def test_sorted_by_key(self):
        rows = merge([], [{"date": "2026-11-02", "repo": "b"}, {"date": "2026-11-01", "repo": "z"}],
                     ["date", "repo"])
        self.assertEqual([r["date"] for r in rows], ["2026-11-01", "2026-11-02"])


if __name__ == "__main__":
    unittest.main()
