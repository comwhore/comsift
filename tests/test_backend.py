import importlib.util
import pathlib
import unittest

BACKEND = pathlib.Path(__file__).parents[1] / "src" / "analysis" / "backend.py"
spec = importlib.util.spec_from_file_location("backend", BACKEND)
backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend)


class BackendTests(unittest.TestCase):
    def test_arbitrary_columns_and_cross_folder_custom_mapping(self):
        records = backend.parse_datasets([
            {"name": "one/orders.csv", "csv": "Invoice,Email\n1234,alice-at-example.test\n"},
            {"name": "elsewhere/contacts.sheet.md#People", "csv": "Contact,Other\nalice-at-example.test,z\n"},
        ], {"one/orders.csv": {"email": "Email"}, "elsewhere/contacts.sheet.md#People": {"email": "Contact"}})
        self.assertEqual(len(records), 2)
        pairs = backend.evidence_pairs(records, [], threshold=0.2)
        self.assertEqual(len(pairs), 1)
        self.assertEqual(pairs[0]["evidence"]["signals"], {"column:email": 1.0})
        self.assertGreaterEqual(pairs[0]["evidence_score"], 0.2)

    def test_generic_columns_auto_match_and_ignored_columns_do_not(self):
        datasets = [{"name": "a.csv", "csv": "Email\na-at-example.test\n"},
                    {"name": "b.csv", "csv": "Email\na-at-example.test\n"}]
        records = backend.parse_datasets(datasets)
        self.assertEqual(len(backend.evidence_pairs(records, [], threshold=0.2)), 1)
        ignored = backend.parse_datasets(datasets, {"*": {"_ignore": "Email"}})
        self.assertEqual(ignored, [])

    def test_small_generic_analysis_needs_no_splink_or_model(self):
        result = backend.handle({"action": "analyze", "mode": "combined", "datasets": [
            {"name": "a.csv", "csv": "Serial\nABC123\n"},
            {"name": "b.csv", "csv": "Serial\nABC123\n"}], "low_threshold": 0.2})
        self.assertEqual(len(result["pairs"]), 1)
        self.assertEqual(result["jina"], [])
        self.assertEqual(backend.handle({"action": "columns", "datasets": [{"name": "a", "csv": '\ufeff"Custom, column",Other\n'}]}),
                         [{"name": "a", "columns": ["Custom, column", "Other"]}])

    def test_three_datasets_and_tab_specific_mapping(self):
        datasets = [
            {"name": "a.sheet.md#Invoices", "csv": "Invoice\nINV-12345\n"},
            {"name": "a.sheet.md#Payments", "csv": "Reference\nINV-12345\n"},
            {"name": "far/other.csv", "csv": "Order\nINV-12345\n"},
        ]
        mappings = {datasets[0]["name"]: {"reference": "Invoice"},
                    datasets[1]["name"]: {"reference": "Reference"},
                    datasets[2]["name"]: {"reference": "Order"}}
        result = backend.handle({"action": "analyze", "datasets": datasets, "mappings": mappings, "mode": "splink"})
        self.assertEqual(len(result["records"]), 3)
        self.assertEqual(len(result["pairs"]), 3)
        self.assertEqual({(pair["left_id"], pair["right_id"]) for pair in result["pairs"]}, {
            (datasets[0]["name"] + ":1", datasets[1]["name"] + ":1"),
            (datasets[0]["name"] + ":1", datasets[2]["name"] + ":1"),
            (datasets[1]["name"] + ":1", datasets[2]["name"] + ":1")})

    def test_known_fields_without_names_generate_candidates(self):
        for header, value in [("website", "https://example.test/unique"),
                              ("profile_url", "https://example.test/person"),
                              ("bio", "Underwater wildlife photography"), ("location", "Example City")]:
            with self.subTest(header=header):
                records = backend.parse_datasets([
                    {"name": "a.csv", "csv": f"{header}\n{value}\n"},
                    {"name": "b.csv", "csv": f"{header}\n{value}\n"}])
                pairs = backend.evidence_pairs(records, [], threshold=0.2)
                self.assertEqual(len(pairs), 1)
                self.assertIn(header, pairs[0]["evidence"]["signals"])

    def test_common_custom_value_bucket_still_yields_matches(self):
        datasets = [{"name": name, "csv": "Shared\n" + "common-value\n" * 151}
                    for name in ("a.csv", "b.csv", "c.csv")]
        records = backend.parse_datasets(datasets)
        pairs = backend.evidence_pairs(records, [], threshold=0.2, limit=1000)
        self.assertTrue(pairs)
        represented = {frozenset((pair["left_id"].split(":")[0], pair["right_id"].split(":")[0])) for pair in pairs}
        self.assertEqual(represented, {frozenset(("a.csv", "b.csv")), frozenset(("a.csv", "c.csv")), frozenset(("b.csv", "c.csv"))})

    def test_discovery_and_parser_share_real_header_after_section_labels(self):
        datasets = [{"name": "mixed.sheet.md#Tab", "csv":
                     "FOLLOWING,,,FOLLOWERS,,\nDisplay name,Username,Email,Display name,Username,Contact\n"
                     "Ann,ann,ann-at-example.test,Bob,bob,bob-at-example.test\n"}]
        columns = backend.handle({"action": "columns", "datasets": datasets})
        self.assertEqual(columns[0]["columns"], ["Display name", "Username", "Email", "Contact"])
        records = backend.parse_datasets(datasets)
        self.assertEqual({record["fields"]["username"] for record in records}, {"ann", "bob"})
        self.assertTrue(all(record["row"] == 2 for record in records))
        self.assertEqual({record["section"] for record in records}, {"FOLLOWING", "FOLLOWERS"})
        ann = next(record for record in records if record["fields"]["username"] == "ann")
        self.assertEqual(ann["fields"]["column:email"], "ann-at-example.test")

    def test_low_floor_above_regular_threshold_does_not_drop_regular_matches(self):
        result = backend.handle({"action": "analyze", "mode": "splink", "threshold": 0.5, "low_threshold": 0.9,
                                 "datasets": [{"name": "a.csv", "csv": "Serial\nABC123\n"},
                                              {"name": "b.csv", "csv": "Serial\nABC123\n"}]})
        self.assertEqual(len(result["pairs"]), 1)
        self.assertEqual(result["pairs"][0]["evidence_score"], 0.65)

    def test_side_by_side_blocks_become_separate_labelled_records(self):
        csv_text = ("FOLLOWING,Display name,Username,Profile link,FOLLOWERS,Display name,Username,Profile link\n"
                    ",Ann,ann_1,https://www.instagram.com/ann_1,,Bob,bob_2,https://www.tiktok.com/@bob_2\n"
                    ",,,,,Cy,cy_3,\n")
        records = backend.parse_datasets([{"name": "a.csv", "csv": csv_text}])
        by_user = {r["fields"]["username"]: r for r in records}
        self.assertEqual(set(by_user), {"ann_1", "bob_2", "cy_3"})
        self.assertEqual(by_user["ann_1"]["section"], "FOLLOWING")
        self.assertEqual(by_user["bob_2"]["section"], "FOLLOWERS")
        self.assertEqual(by_user["ann_1"]["fields"]["platform"], "instagram")
        self.assertEqual(len({r["id"] for r in records}), 3)

    def test_same_account_in_several_blocks_is_one_record_with_sections(self):
        csv_text = ("FOLLOWING,Display name,Username,Profile link,FOLLOWERS,Display name,Username,Profile link\n"
                    ",Ann,ann_1,https://instagram.com/ann_1,,Ann,ann_1,https://instagram.com/ann_1\n"
                    ",Bo,bo_2,,,,,\n")
        records = backend.parse_datasets([{"name": "a.csv", "csv": csv_text}])
        self.assertEqual(len(records), 2)
        ann = next(r for r in records if r["fields"]["username"] == "ann_1")
        self.assertEqual(ann["section"], "FOLLOWING + FOLLOWERS")

    def test_lone_first_name_or_platform_is_not_evidence_and_avatar_hash_is(self):
        records = backend.parse_datasets([
            {"name": "x.csv", "csv": "username,name,platform\nqqq1,Daryna,instagram\nvvv,Anna K,instagram,\n"},
            {"name": "y.csv", "csv": "username,name,platform\nwwww,Daryna,instagram\nrrrr,Zed,instagram\n"},
        ])
        pairs = backend.evidence_pairs(records, [{"left_id": "x.csv:1", "right_id": "y.csv:1", "evidence": {}}])
        self.assertEqual(pairs, [])
        records = backend.parse_datasets([
            {"name": "x.csv", "csv": "username,avatar_hash\naaaaa,f0f0f0f0f0f0f0f0\n"},
            {"name": "y.csv", "csv": "username,avatar_hash\nbbbbb,f0f0f0f0f0f0f0f1\n"},
        ])
        pairs = backend.evidence_pairs(records, [])
        self.assertEqual(set(pairs[0]["evidence"]["signals"]), {"avatar"})

    def test_weak_signals_combine_across_fields_and_existing_pairs_get_evidence(self):
        records = backend.parse_datasets([
            {"name": "x.csv", "csv": "username,name\nthat.guy,silly\nother,meow\n"},
            {"name": "y.csv", "csv": "username,name\nsilly.guy,silly\nzzzzzz,Qqqq\n"},
        ])
        existing = [{"left_id": "x.csv:2", "right_id": "y.csv:2", "evidence": {}}]
        pairs = backend.evidence_pairs(records, existing)
        self.assertFalse([p for p in pairs if (p["left_id"], p["right_id"]) == ("x.csv:2", "y.csv:2")])
        found = [p for p in pairs if (p["left_id"], p["right_id"]) == ("x.csv:1", "y.csv:1")]
        self.assertEqual(len(found), 1)
        self.assertGreaterEqual(found[0]["evidence_score"], 0.6)
        self.assertEqual(set(found[0]["evidence"]["signals"]), {"username", "display_name"})
        for pair in pairs:
            self.assertNotEqual(pair["left_id"].split(":")[0], pair["right_id"].split(":")[0])

    def test_schema_mapping_and_missing_values(self):
        records = backend.parse_datasets([
            {"name": "alice/instagram.csv", "csv": "Handle,Biography,Place\na,Photography,Gdansk\n"},
            {"name": "bob/github.csv", "csv": "login,bio\na,Code\n"},
        ], {"alice/instagram.csv": {"username": "Handle", "location": "Place"}})
        self.assertEqual(records[0]["fields"]["username"], "a")
        self.assertEqual(records[0]["fields"]["location"], "Gdansk")
        self.assertEqual(records[1]["fields"]["location"], "")
        self.assertEqual(records[1]["dataset"], "bob/github.csv")

    def test_cross_dataset_candidate_evidence(self):
        records = backend.parse_datasets([
            {"name": "one.csv", "csv": "username,website\nAlice,example.com\n"},
            {"name": "two.csv", "csv": "handle,homepage\nalice,example.com\n"},
            {"name": "three.csv", "csv": "handle\nunrelated\n"},
        ])
        pairs = backend.simple_candidates(records)
        self.assertEqual(len(pairs), 1)
        self.assertEqual(pairs[0]["evidence"]["exact_fields"], ["username", "website"])

    def test_invalid_csv_url_is_not_treated_as_profile(self):
        record = backend.parse_datasets([{"name": "x.csv", "csv": "username,url\na,javascript:evil\n"}])[0]
        self.assertEqual(record["fields"]["profile_url"], "")


if __name__ == "__main__":
    unittest.main()
