import importlib.util
import pathlib
import unittest

BACKEND = pathlib.Path(__file__).parents[1] / "src" / "analysis" / "backend.py"
spec = importlib.util.spec_from_file_location("backend", BACKEND)
backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend)


class BackendTests(unittest.TestCase):
    def test_stored_profiles_with_missing_fields_can_be_analyzed(self):
        stored = [{"id": f"P/Connections/u{i}.md:{i}", "dataset": "P/x.sheet.md#Sheet1", "row": i,
                   "fields": {"username": f"user{i}", "display_name": f"User {i}"}} for i in range(25)]
        csv = "username,display_name,website,location\n" + "".join(f"user{i},User {i},site{i}.test,City\n" for i in range(25))
        result = backend.handle({"action": "analyze", "mode": "splink", "compare_within": True, "datasets": [
            {"name": "P/x.sheet.md#Sheet1", "csv": csv}, {"name": "P/Connections/all.md", "csv": "", "records": stored}]})
        self.assertTrue(all("website" in record["fields"] for record in result["records"]))

    def test_source_prefixed_dataset_names_do_not_become_different_platforms(self):
        records = backend.parse_datasets([
            {"name": "Person/export instagram.sheet.md", "csv": "Username\nalice\n"},
            {"name": "Person/other instagram.sheet.md", "csv": "Username\nalice\n"},
        ])
        self.assertEqual([r["fields"]["platform"] for r in records], ["instagram", "instagram"])

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
        found = backend.handle({"action": "columns", "datasets": [{"name": "a", "csv": '\ufeff"Custom, column",Other\n'}]})
        self.assertEqual([(entry["name"], entry["columns"]) for entry in found], [("a", ["Custom, column", "Other"])])
        self.assertEqual(found[0]["rows"], 0)

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
            {"name": "x.csv", "csv": "username,name,platform\nqqq1,Dana,instagram\nvvv,Anna K,instagram,\n"},
            {"name": "y.csv", "csv": "username,name,platform\nwwww,Dana,instagram\nrrrr,Zed,instagram\n"},
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

    def test_connection_dedup_ignores_missing_values_but_not_conflicts(self):
        records = backend.parse_datasets([{"name": "roblox.csv", "csv":
            "username,display name,user_id\nalice,Alice,11\nalice,,11\nalice,Alice,12\n,Alice,\n,Alice,\n"}])
        self.assertEqual(len(records), 4)
        self.assertEqual(records[0]["fields"]["user_id"], "11")
        self.assertEqual(records[1]["fields"]["user_id"], "12")

    def test_range_row_offsets_and_existing_profiles(self):
        records = backend.handle({"action": "records", "datasets": [{"name": "people.sheet.md#People@F5:H7",
            "row_offset": 4, "csv": "display name,username,profile link\nAlice,alice,https://www.roblox.com/users/11/profile\n"}]})
        self.assertEqual(records[0]["row"], 5)
        self.assertTrue(records[0]["id"].endswith(":5"))
        loaded = backend.handle({"action": "records", "datasets": [{"name": "Person/Connections/Alice.md", "records": records}]})
        self.assertEqual(loaded[0]["id"], records[0]["id"])
        self.assertEqual(loaded[0]["_comparison_group"], "Person/Connections/Alice.md")

    def test_one_sheet_can_compare_people_without_self_pairs(self):
        result = backend.handle({"action": "analyze", "mode": "splink", "compare_within": True,
            "low_threshold": 0.2, "datasets": [{"name": "roblox.csv", "csv": "username,display name\nalice,Alice\nalice_alt,Alice\n"}]})
        self.assertTrue(result["pairs"])
        self.assertTrue(all(pair["left_id"] != pair["right_id"] for pair in result["pairs"]))

    def test_column_discovery_returns_samples_for_side_by_side_blocks(self):
        found = backend.handle({"action": "columns", "datasets": [{"name": "t.csv", "csv":
            "FOLLOWING,Username,Profile link,FOLLOWERS,Username,Profile link,MISSING FOLLOWING:,0\n"
            ",,,,bob,https://www.tiktok.com/@bob,,\n,ann,https://www.tiktok.com/@ann,,ann,https://www.tiktok.com/@ann,,\n"}]})[0]
        self.assertEqual(found["columns"], ["FOLLOWING", "Username", "Profile link", "FOLLOWERS", "MISSING FOLLOWING:", "0"])
        self.assertEqual(found["samples"]["Username"], ["bob", "ann"])
        self.assertEqual((found["filled"]["FOLLOWING"], found["distinct"]["Username"], found["rows"]), (0, 2, 2))
        self.assertEqual(found["examples"][0], {"Username": "bob", "Profile link": "https://www.tiktok.com/@bob"})

    def test_chosen_identity_column_drives_dedup_and_evidence(self):
        csv_text = "Name,Email\nAnn,ann@example.test\n,ann@example.test\nBob,bob@example.test\n"
        plain = backend.parse_datasets([{"name": "a.csv", "csv": csv_text}])
        self.assertEqual(len(plain), 3)  # Without an identity column every row stays its own person.
        mapping = {"a.csv": {"display_name": "Name", "email": "Email", "_identity": "Email"}}
        chosen = backend.parse_datasets([{"name": "a.csv", "csv": csv_text}], mapping)
        self.assertEqual(len(chosen), 2)
        self.assertEqual(chosen[0]["fields"]["id:email"], "ann@example.test")
        self.assertNotIn("column:email", chosen[0]["fields"])
        other = backend.parse_datasets([{"name": "b.csv", "csv": "Contact\nann@example.test\n"}],
                                       {"b.csv": {"email": "Contact", "_identity": "Contact"}})
        pairs = backend.evidence_pairs(chosen + other, [], threshold=0.5)
        self.assertTrue(any(pair["evidence"]["signals"].get("id:email") == 1.0 for pair in pairs))

    def test_conflicting_identity_values_never_merge(self):
        mapping = {"a.csv": {"username": "user", "discord": "Discord", "_identity": "Discord"}}
        records = backend.parse_datasets([{"name": "a.csv", "csv": "user,Discord\nann,111\nann,222\n"}], mapping)
        self.assertEqual(len(records), 2)

    def test_unmatched_columns_stay_on_profiles_but_out_of_matching(self):
        mapping = {"*": {"location": "City", "_nomatch": "City\nSerial"}}
        records = backend.parse_datasets([{"name": "a.csv", "csv": "City,Serial\nParis,X1\n"},
                                          {"name": "b.csv", "csv": "City,Serial\nParis,X1\n"}], mapping)
        self.assertEqual((records[0]["fields"]["location"], records[0]["fields"]["note:location"]), ("", "Paris"))
        self.assertEqual(records[0]["fields"]["note:serial"], "X1")
        self.assertEqual(backend.evidence_pairs(records, [], threshold=0.1), [])
        self.assertNotIn("Paris", backend.profile_text(records[0]))

    def test_canonical_fields_can_match_without_defining_account_identity(self):
        rows = backend.parse_datasets([{"name": "a.csv", "csv": "Username,Profile link\nalice,https://example.test/a\nalice,https://example.test/b\n"}],
                                      {"a.csv": {"username": "Username", "profile_url": "Profile link", "_noidentity": "Username"}})
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["fields"]["username"], "")
        self.assertEqual(rows[0]["fields"]["column:username"], "alice")

    def test_identity_fields_can_be_excluded_from_matching(self):
        datasets = [{"name": "a.csv", "csv": "Username,Profile link,Email\nalice,https://example.test/alice,alice@example.test\n"}]
        mappings = {"a.csv": {"username": "Username", "profile_url": "Profile link", "email": "Email", "_identity": "Email", "_nomatch": "Username\nEmail"}}
        fields = backend.parse_datasets(datasets, mappings)[0]["fields"]
        self.assertEqual(fields["username"], "")
        self.assertEqual(fields["note:username"], "alice")
        self.assertEqual(fields["note:email"], "alice@example.test")
        self.assertNotIn("id:email", fields)
        self.assertEqual(fields["profile_url"], "https://example.test/alice")

    def test_rows_without_identity_can_be_skipped(self):
        csv_text = "Username,Note\nann,hi\n,Total 2\n"
        self.assertEqual(len(backend.parse_datasets([{"name": "a.csv", "csv": csv_text}])), 2)
        kept = backend.parse_datasets([{"name": "a.csv", "csv": csv_text}], {"a.csv": {"username": "Username", "_require_identity": "1"}})
        self.assertEqual([record["fields"]["username"] for record in kept], ["ann"])

    def test_named_primary_weak_candidates_require_explicit_opt_in(self):
        records = backend.parse_datasets([
            {"name": "Person/Person.md", "records": [{"id": "person", "dataset": "Person/Person.md", "row": 0,
                "is_primary": True, "fields": {"display_name": "ExamplePerson"}}]},
            {"name": "following.csv", "csv": "Username,Name\nexample.person,Example\n"},
        ])
        self.assertEqual(backend.evidence_pairs(records, [], threshold=0.2), [])
        pairs = backend.evidence_pairs(records, [], threshold=0.2, allow_primary_name_candidates=True)
        self.assertEqual(len(pairs), 1)
        self.assertIn("person", [pairs[0]["left_id"], pairs[0]["right_id"]])
        self.assertLess(pairs[0]["evidence_score"], 0.5)
        self.assertNotIn("username", pairs[0]["evidence"]["signals"])
        existing = [{"left_id": records[0]["id"], "right_id": records[1]["id"], "evidence": {}}]
        self.assertEqual(backend.evidence_pairs(records, existing, threshold=0.2), [])
        self.assertEqual(len(backend.evidence_pairs(records, existing, threshold=0.2, allow_primary_name_candidates=True)), 1)
        request = {"action": "analyze", "mode": "splink", "low_threshold": 0.2, "datasets": [
            {"name": "Person/Person.md", "records": [records[0]]},
            {"name": "following.csv", "csv": "Username,Name\nexample.person,Example\n"},
        ]}
        for value in (None, False, "true", 1):
            request["allow_primary_name_candidates"] = value
            self.assertEqual(backend.handle(request)["pairs"], [])
        request["allow_primary_name_candidates"] = True
        self.assertEqual(len(backend.handle(request)["pairs"]), 1)
        records[0].pop("is_primary")
        self.assertEqual(backend.evidence_pairs(records, [], threshold=0.2, allow_primary_name_candidates=True), [])

    def test_option_keys_are_not_treated_as_columns(self):
        records = backend.parse_datasets([{"name": "a.csv", "csv": "a b,user\nx,ann\n"}],
                                         {"a.csv": {"username": "user", "_identity": "a\nb", "_nomatch": ""}})
        self.assertEqual(records[0]["fields"]["column:a b"], "x")


if __name__ == "__main__":
    unittest.main()
