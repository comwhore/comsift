"""Local comsift analysis worker. JSON request on stdin, JSON response on stdout.

Only dependencies installed by the user are imported. No network or package installation.
"""
from __future__ import annotations

import sys as _sys

# libarrow bundles its own OpenSSL; next to the OpenSSL that CPython's `_hashlib` loads (as inside
# Flatpak/Snap sandboxes) the process segfaults. hashlib falls back to its built-in implementations.
_sys.modules["_hashlib"] = None

import csv
import io
import json
import os
import re
import sys
from importlib import metadata
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlparse

FIELDS = ("username", "display_name", "bio", "platform", "profile_url", "website", "location",
          "user_id", "created", "avatar_hash", "avatar_url", "verified", "followers", "relation")
ALIASES = {
    "username": ("username", "user", "user name", "handle", "screen_name", "screen name", "login"),
    "display_name": ("display_name", "display name", "name", "full_name", "full name", "real_name"),
    "bio": ("bio", "biography", "description", "about"),
    "platform": ("platform", "site", "service", "network"),
    "profile_url": ("profile_url", "profile link", "profile", "profile url", "url", "url_user", "link"),
    "website": ("website", "homepage", "personal_url"),
    "location": ("location", "city", "place", "country"),
    "user_id": ("user_id", "user id", "id", "uid", "pk", "did", "account_id"),
    "created": ("created", "created_at", "created at", "account_created", "joined", "member_since", "member since"),
    "avatar_hash": ("avatar_hash", "avatar hash", "image_hash", "dhash"),
    "avatar_url": ("avatar_url", "avatar url", "avatar", "image", "profile_pic", "picture"),
    "verified": ("verified", "is_verified"),
    "followers": ("followers_count", "followers count", "follower_count"),
    "relation": ("relation", "relationship", "list", "kind"),
}


def clean(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def normalize(value: str) -> str:
    return clean(value).casefold()


def headers_seen(indexes: list[int], header: list[str]) -> set[str]:
    """Normalized header names that occur more than once inside one segment (ambiguous, so unusable)."""
    counts: dict[str, int] = {}
    for i in indexes:
        key = normalize(header[i])
        counts[key] = counts.get(key, 0) + 1
    return {key for key, count in counts.items() if count > 1}


IDENTITY_FIELDS = ("username", "user_id", "profile_url")


def _column_list(custom: dict, key: str) -> set[str]:
    """Newline-separated column names stored under an option key such as "_ignore" or "_identity"."""
    value = custom.get(key, "")
    return {normalize(item) for item in value.split("\n") if clean(item)} if isinstance(value, str) else set()


def _apply_column_roles(fields: dict, header: list[str], columns: dict, identity: set[str], unmatched: set[str], noidentity: set[str] | None = None) -> None:
    """Identity columns become "id:<field>" (exact account identifiers); unmatched columns become
    "note:<field>" so profiles keep them while Splink, evidence scoring and Jina skip them."""
    targets = {normalize(header[index]): field for field, index in columns.items() if index is not None}
    for key in list(fields):
        if key.startswith("column:"):
            targets.setdefault(key.removeprefix("column:"), key)
    for column, field in targets.items():
        value = fields.get(field, "")
        if column in identity and column not in unmatched and field not in IDENTITY_FIELDS:
            fields["id:" + field.removeprefix("column:")] = value
        elif column in unmatched:
            fields["note:" + field.removeprefix("column:")] = value
        elif column in (noidentity or set()) and field in IDENTITY_FIELDS:
            fields["column:" + field] = value
        else:
            continue
        if field in FIELDS:
            fields[field] = "" if column in unmatched or column in (noidentity or set()) else value
        else:
            fields.pop(field, None)


def _merge_duplicates(records: list[dict]) -> list[dict]:
    """The same account listed in several blocks (FOLLOWING / FOLLOWERS / IN COMMON) becomes one record."""
    merged: dict[str, dict] = {}
    order: list[dict] = []
    anchors: dict[str, set[str]] = {}
    shared = ("username", "user_id", "profile_url", "display_name", "bio", "location", "website")
    def identity_keys(fields):
        chosen = sorted(field for field in fields if field.startswith("id:"))
        return [f"{field}|{normalize(fields[field]).removeprefix('@') if field == 'username' else normalize(fields[field])}"
                for field in (*IDENTITY_FIELDS, *chosen) if fields.get(field)]
    def same(a, b):
        if a.get("platform") and b.get("platform") and normalize(a["platform"]) != normalize(b["platform"]):
            return False
        chosen = [field for field in a if field.startswith("id:") and a[field] and b.get(field)]
        if any(normalize(a[field]) != normalize(b[field]) for field in chosen):
            return False
        common = [field for field in shared if a.get(field) and b.get(field)]
        if any(normalize(a[field]).removeprefix('@') != normalize(b[field]).removeprefix('@') for field in common):
            return False
        url = urlparse(a.get("profile_url", ""))
        url_identity = "profile_url" in common and url.scheme in ("http", "https") and len(url.path) > 1 and not re.fullmatch(r"/(?:users?|profiles?|people)/?", url.path, re.I)
        return bool(chosen) or url_identity or (bool(a.get("platform") or b.get("platform")) and any(field in common for field in ("username", "user_id"))) or ("username" in common and any(field in common for field in ("display_name", "bio", "website")))
    for record in records:
        fields = record["fields"]
        # Names alone cannot identify an account; missing fields do not conflict.
        candidates = set().union(*(anchors.get(key, set()) for key in identity_keys(fields))) if identity_keys(fields) else set()
        key = next((key for key in sorted(candidates, key=int) if same(fields, merged[key]["fields"])), str(len(order)))
        label = record.get("relation") or record.get("section") or fields.get("relation") or ""
        if key not in merged:
            record["_labels"] = [label] if label else []
            merged[key] = record
            order.append(record)
            for anchor in identity_keys(fields):
                anchors.setdefault(anchor, set()).add(key)
            continue
        kept = merged[key]
        for name, value in fields.items():
            if value and not kept["fields"].get(name):
                kept["fields"][name] = value
        for anchor in identity_keys(kept["fields"]):
            anchors.setdefault(anchor, set()).add(key)
        if label and label not in kept["_labels"]:
            kept["_labels"].append(label)
    for record in order:
        labels = record.pop("_labels")
        mutual = "IN COMMON" in labels and len(labels) > 1
        labels = [label for label in labels if label != "IN COMMON"] or (["IN COMMON"] if labels else [])
        text = " + ".join(labels) + (" (mutual)" if mutual else "")
        if text:
            record["section"] = text
        else:
            record.pop("section", None)
    return order


def _segments(header: list[str], known: set[str]) -> list[tuple[str, list[int]]]:
    """Split side-by-side tables (e.g. FOLLOWING | FOLLOWERS | IN COMMON blocks that repeat
    "Username", "Profile link"…) into separate column groups; each keeps its leading label column."""
    starts = [0]
    seen: set[str] = set()
    for i, name in enumerate(header):
        key = normalize(name)
        if key in known and key in seen:
            boundary = i
            while boundary - 1 > starts[-1] and normalize(header[boundary - 1]) in SECTION_LABELS:
                boundary -= 1
            starts.append(boundary)
            seen = {normalize(h) for h in header[boundary:i] if normalize(h) in known}
        if key in known:
            seen.add(key)
    result = []
    for n, start in enumerate(starts):
        end = starts[n + 1] if n + 1 < len(starts) else len(header)
        indexes = list(range(start, end))
        label = next((header[i] for i in indexes if normalize(header[i]) in SECTION_LABELS), "")
        result.append((label, indexes))
    return result


SECTION_LABELS = {"following", "followers", "in common", "mutual", "mutuals", "friends", "connections"}


def dataset_header(table: list[list[str]]) -> tuple[int, list[str]]:
    """Skip empty prefixes and a section-label row above the actual shared column header."""
    for index, row in enumerate(table):
        populated = {normalize(cell) for cell in row if clean(cell)}
        if not populated:
            continue
        if populated <= SECTION_LABELS and index + 1 < len(table):
            next_index = next((i for i in range(index + 1, len(table)) if any(clean(cell) for cell in table[i])), None)
            if next_index is not None:
                return next_index, [clean(cell) for cell in table[next_index]]
        return index, [clean(cell) for cell in row]
    return 0, []


def parse_datasets(datasets: list[dict], mappings: dict | None = None) -> list[dict]:
    mappings = mappings or {}
    if not isinstance(mappings, dict):
        raise ValueError("Column mappings must be an object.")
    records = []
    for dataset in datasets:
        name = clean(dataset.get("name"))
        if not name:
            raise ValueError("Dataset name is required.")
        if "records" in dataset:
            supplied = dataset["records"]
            if not isinstance(supplied, list):
                raise ValueError("Profile records must be a list.")
            for entry in supplied:
                if not isinstance(entry, dict) or not isinstance(entry.get("id"), str) or not isinstance(entry.get("fields"), dict):
                    raise ValueError("Invalid connection profile record.")
                if any(not isinstance(k, str) or not isinstance(v, str) for k, v in entry["fields"].items()):
                    raise ValueError("Invalid connection fields.")
                # Stored profiles may omit empty fields; Splink and evidence scoring expect every field.
                fields = {**{field: "" for field in FIELDS}, **entry["fields"]}
                records.append({**entry, "fields": fields, "raw": entry.get("raw", entry["fields"]), "_comparison_group": name})
                if len(records) > 10_000:
                    raise ValueError("Analysis is limited to 10,000 records per run.")
            continue
        raw = dataset.get("csv", "")
        if len(raw) > 20_000_000:
            raise ValueError(f"{name}: CSV exceeds 20 MB limit.")
        table = list(csv.reader(io.StringIO(raw.lstrip("\ufeff"), newline="")))
        header_index, header = dataset_header(table)
        if not header:
            continue
        custom = mappings.get(name, mappings.get("*", {}))
        if not isinstance(custom, dict) or any(not isinstance(key, str) or not isinstance(value, str) for key, value in custom.items()):
            raise ValueError("Each dataset mapping must map field names to column names.")
        ignored = _column_list(custom, "_ignore")
        # Columns the user marked as identifying one person, and columns kept out of matching.
        identity_columns = _column_list(custom, "_identity")
        unmatched_columns = _column_list(custom, "_nomatch")
        noidentity_columns = _column_list(custom, "_noidentity")
        require_identity = custom.get("_require_identity") == "1"
        # Keys starting with "_" are options, not field → column pairs.
        custom = {key: value for key, value in custom.items() if not key.startswith("_")}
        known = {normalize(alias) for aliases in ALIASES.values() for alias in aliases}
        known.update(normalize(value) for value in custom.values())
        dataset_start = len(records) 
        segments = _segments(header, known)
        if header_index > 0:
            section_row = table[header_index - 1]
            labels = [(i, clean(value)) for i, value in enumerate(section_row) if normalize(value) in SECTION_LABELS]
            if labels:
                segments = [(next((label for start, label in reversed(labels) if start <= indexes[0]), label), indexes)
                            for label, indexes in segments]
        for segment_number, (label, indexes) in enumerate(segments):
            headers = {normalize(header[i]): i for i in indexes if header[i] and normalize(header[i]) not in ignored and normalize(header[i]) not in headers_seen(indexes, header)}
            columns = {}
            mapped_names = {normalize(value) for value in custom.values()}
            for field in dict.fromkeys([*FIELDS, *custom]):
                requested = custom.get(field)
                choices = (requested,) if isinstance(requested, str) and requested else ALIASES.get(field, (field,))
                target = field if field in FIELDS else "column:" + normalize(field).removeprefix("column:")
                columns[target] = next((headers[normalize(choice)] for choice in choices
                                        if normalize(choice) in headers and (requested or normalize(choice) not in mapped_names)), None)
            for index, row in enumerate(table[header_index + 1:], header_index + 1):
                cells = {header[i]: clean(row[i]) if i < len(row) else "" for i in indexes if header[i]}
                if not any(cells.values()):
                    continue
                fields = {field: (clean(row[column]) if column is not None and column < len(row) else "")
                          for field, column in columns.items()}
                # Preserve arbitrary columns as normalized shared fields, unless explicitly mapped.
                for key, value in cells.items():
                    if normalize(key) not in ignored and normalize(key) not in mapped_names and normalize(key) not in known:
                        fields.setdefault("column:" + normalize(key), value)
                if identity_columns or unmatched_columns or noidentity_columns:
                    _apply_column_roles(fields, header, columns, identity_columns, unmatched_columns, noidentity_columns)
                if not any(fields.values()):
                    continue
                if fields["profile_url"]:
                    parsed = urlparse(fields["profile_url"])
                    if parsed.scheme not in ("http", "https"):
                        fields["profile_url"] = ""
                if require_identity and not any(value for key, value in fields.items() if key in IDENTITY_FIELDS or key.startswith("id:")):
                    continue  # Totals, notes and blank rows are not people.
                if not fields["platform"]:
                    host = urlparse(fields["profile_url"]).netloc.lower().removeprefix("www.").split(".")[0] if fields["profile_url"] else ""
                    inferred = host or re.sub(r"\.sheet$", "", Path(name.split("#")[0]).stem)
                    known_platform = re.search(r"(?:^|\s)(instagram|tiktok|roblox|bluesky|bsky|twitter|facebook|youtube|discord|snapchat|threads|reddit|telegram|twitch)$", inferred.lower())
                    fields["platform"] = known_platform.group(1) if known_platform else inferred
                    if fields["platform"] == "bsky":
                        fields["platform"] = "bluesky"
                original_row = index + int(dataset.get("row_offset", 0))
                record = {
                    "id": f"{name}:{original_row}" + (f".{segment_number + 1}" if len(segments) > 1 else ""),
                    "dataset": name, "row": original_row, "fields": fields, "raw": cells,
                }
                if label and len(segments) > 1:
                    record["section"] = label
                records.append(record)
                if len(records) > 10_000:
                    raise ValueError("Analysis is limited to 10,000 records per run.")
        records[dataset_start:] = _merge_duplicates(records[dataset_start:])
    # A saved profile and its source row may both be selected. Keep that provenance once.
    unique = {}
    for record in records:
        key = (record["dataset"], record["id"], json.dumps(record["fields"], sort_keys=True))
        unique.setdefault(key, record)
    return list(unique.values())


TECHNICAL_FIELDS = {"user_id", "avatar_hash", "avatar_url", "relation", "followers", "verified"}


def profile_text(record: dict) -> str:
    return "\n".join(f"{key}: {value}" for key, value in record["fields"].items()
                     if value and key not in TECHNICAL_FIELDS and not key.startswith("note:"))


def simple_candidates(records: list[dict], limit: int = 200) -> list[dict]:
    """Conservative candidate pool for independent Jina use; never treated as match confidence."""
    keys = ("username", "display_name", "website", "profile_url")
    index: dict[tuple[str, str], list[dict]] = {}
    found: dict[tuple[str, str], set[str]] = {}
    for record in records:
        for key in keys:
            value = normalize(record["fields"][key])
            if not value:
                continue
            for previous in index.get((key, value), []):
                if previous["dataset"] == record["dataset"]:
                    continue
                pair = (previous["id"], record["id"])
                found.setdefault(pair, set()).add(key)
                if len(found) >= limit:
                    return [{"left_id": left, "right_id": right,
                             "evidence": {"exact_fields": sorted(fields)}}
                            for (left, right), fields in found.items()]
            index.setdefault((key, value), []).append(record)
    return [{"left_id": left, "right_id": right,
             "evidence": {"exact_fields": sorted(fields)}}
            for (left, right), fields in found.items()]


def _stem(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", normalize(value))


def _trigrams(value: str) -> set[str]:
    return {value[i:i + 3] for i in range(len(value) - 2)} if len(value) >= 3 else ({value} if value else set())


SIGNAL_WEIGHTS = {"user_id": 0.99, "avatar": 0.9, "username": 0.8, "display_name": 0.55, "profile_url": 0.95,
                  "website": 0.8, "bio": 0.5, "location": 0.3, "mention": 0.7, "created": 0.15}
STRONG_SIGNALS = {"user_id", "avatar", "username", "profile_url", "website", "mention", "bio"}


def _url_key(value: str) -> str:
    parsed = urlparse(value)
    return (parsed.netloc.lower().removeprefix("www.") + parsed.path.rstrip("/").lower()) if parsed.netloc else ""


def _pair_signals(a: dict, b: dict) -> dict[str, float]:
    """Independent similarity signals (0-1) for one record pair; missing data contributes nothing."""
    from difflib import SequenceMatcher

    signals: dict[str, float] = {}
    ub, vb = a["user_base"], b["user_base"]
    if a["user"] and b["user"]:
        if a["user"] == b["user"]:
            signals["username"] = 1.0
        elif ub and vb:
            value = SequenceMatcher(None, ub, vb).ratio()
            if ub == vb:
                value = max(value, 0.9)
            elif min(len(ub), len(vb)) >= 4 and (ub in vb or vb in ub):
                value = max(value, 0.85)
            if value >= 0.35:
                signals["username"] = round(value, 3)
    if a["uid"] and a["uid"] == b["uid"] and a["platform"] and a["platform"] == b["platform"]:
        signals["user_id"] = 1.0
    if a["hash"] and b["hash"] and len(a["hash"]) == len(b["hash"]):
        try:
            distance = bin(int(a["hash"], 16) ^ int(b["hash"], 16)).count("1")
            bits = len(a["hash"]) * 4
            if distance <= bits * 0.15:
                signals["avatar"] = round(1.0 - distance / (bits * 0.15) * 0.4, 3)
        except ValueError:
            pass
    if a["created"] and a["created"] == b["created"]:
        signals["created"] = 1.0
    if len(a["name"]) >= 3 and len(b["name"]) >= 3:
        value = 1.0 if a["name"] == b["name"] else max(
            SequenceMatcher(None, a["name"], b["name"]).ratio(),
            len(a["tokens"] & b["tokens"]) / len(a["tokens"] | b["tokens"]) if a["tokens"] | b["tokens"] else 0.0)
        if len(a["tokens"]) < 2 or len(b["tokens"]) < 2:
            value *= 0.8  # a lone first name says little
        if value >= 0.4:
            signals["display_name"] = round(value, 3)
    if a["url"] and a["url"] == b["url"]:
        signals["profile_url"] = 1.0
    if a["site"] and a["site"] == b["site"]:
        signals["website"] = 1.0
    shared = a["bio_tokens"] & b["bio_tokens"]
    if len(shared) >= 2:
        signals["bio"] = round(min(1.0, len(shared) / max(3, min(len(a["bio_tokens"]), len(b["bio_tokens"])))), 3)
    if a["location"] and a["location"] == b["location"]:
        signals["location"] = 1.0
    if (len(b["user"]) >= 5 and b["user"] in a["text"]) or (len(a["user"]) >= 5 and a["user"] in b["text"]):
        signals["mention"] = 1.0
    for key in a["custom"].keys() & b["custom"].keys():
        left, right = a["custom"][key], b["custom"][key]
        if key.startswith("id:"):
            if left == right:
                signals[key] = 1.0  # A user-chosen identity column: exact equality only.
            continue
        if left == right:
            signals["column:" + key.removeprefix("column:")] = 1.0
        elif min(len(left), len(right)) >= 4:
            similarity = SequenceMatcher(None, left, right).ratio()
            if similarity >= 0.5:
                signals["column:" + key.removeprefix("column:")] = round(similarity, 3)
    return signals


def _is_substantive(signals: dict[str, float]) -> bool:
    """Retain explicit field links; a lone personal name or platform remains too weak."""
    return any(key.startswith(("column:", "id:")) for key in signals) or "location" in signals or bool(STRONG_SIGNALS & set(signals)) or ("display_name" in signals and signals["display_name"] >= 0.95
                                                    and len(signals) >= 2)


def _combine(signals: dict[str, float]) -> float:
    """Noisy-OR: several weak independent signals add up (similar handle + same display name)."""
    remaining = 1.0
    for name, value in signals.items():
        remaining *= 1.0 - SIGNAL_WEIGHTS.get(name, 0.99 if name.startswith("id:") else 0.65) * value
    return round(1.0 - remaining, 3)


def evidence_pairs(records: list[dict], existing: list[dict], per_source: int = 5,
                   threshold: float = 0.6, limit: int = 400, within: bool = False, allow_primary_name_candidates: bool = False) -> list[dict]:
    """Attach combined multi-field evidence to every known pair and add near-miss pairs.

    Cheap local signal for review ordering; not a calibrated match probability.
    """
    order = {}
    for record in records:
        order.setdefault(record["dataset"], len(order))
    prepared = []
    position = {}
    for record in records:
        fields = record["fields"]
        user = _stem(fields.get("username", ""))
        name = _stem(fields.get("display_name", ""))
        prepared.append({
            "custom": {key: normalize(value) for key, value in fields.items() if key not in FIELDS and value and not key.startswith("note:")},
            "record": record, "user": user, "user_base": user.rstrip("0123456789"), "name": name,
            "tokens": {t for t in re.split(r"\W+", normalize(fields.get("display_name", ""))) if len(t) > 1},
            "bio_tokens": {t for t in re.split(r"\W+", normalize(fields.get("bio", ""))) if len(t) >= 4},
            "text": _stem(" ".join([fields.get("bio", ""), fields.get("website", "")])),
            "url": _url_key(fields.get("profile_url", "")), "site": _url_key(fields.get("website", "")),
            "location": normalize(fields.get("location", "")),
            "uid": normalize(fields.get("user_id", "")), "platform": normalize(fields.get("platform", "")),
            "hash": normalize(fields.get("avatar_hash", "")), "created": normalize(fields.get("created", ""))[:10],
        })
        position[record["id"]] = len(prepared) - 1

    known = set()
    kept_existing = []
    for pair in existing:
        i, j = position.get(pair["left_id"]), position.get(pair["right_id"])
        if i is None or j is None:
            continue
        known.add(frozenset((pair["left_id"], pair["right_id"])))
        signals = _pair_signals(prepared[i], prepared[j])
        primary_name = allow_primary_name_candidates and (prepared[i]["record"].get("is_primary") or prepared[j]["record"].get("is_primary")) and signals.get("display_name", 0) >= 0.4
        if not (_is_substantive(signals) or primary_name):
            continue  # A shared first name or platform alone is insufficient by default.
        pair["evidence_score"] = _combine(signals)
        pair.setdefault("evidence", {})["signals"] = signals
        kept_existing.append(pair)

    def blocking_keys(item):
        keys = {"gram:" + gram for gram in _trigrams(item["user_base"]) | _trigrams(item["name"])}
        for key in ("url", "site", "location", "created", "hash"):
            if item[key]:
                keys.add(f"exact:{key}:{item[key]}")
        if item["uid"] and item["platform"]:
            keys.add(f"uid:{item['platform']}:{item['uid']}")
        keys.update("bio:" + token for token in item["bio_tokens"])
        for key, value in item["custom"].items():
            keys.add(f"custom-exact:{key}:{value}")
            keys.update(f"custom:{key}:{gram}" for gram in _trigrams(value))
        return keys

    index: dict[str, dict[str, list[int]]] = {}
    for i, item in enumerate(prepared):
        for key in blocking_keys(item):
            index.setdefault(key, {}).setdefault(item["record"]["dataset"], []).append(i)
    hashed = [(i, item["hash"]) for i, item in enumerate(prepared) if item["hash"]]
    near_hash: dict[int, set[int]] = {}
    if len(hashed) <= 3000:
        values = []
        for i, text in hashed:
            try:
                values.append((i, int(text, 16), len(text) * 4))
            except ValueError:
                continue
        for x in range(len(values)):
            for y in range(x + 1, len(values)):
                if values[x][2] == values[y][2] and bin(values[x][1] ^ values[y][1]).count("1") <= values[x][2] * 0.15:
                    near_hash.setdefault(values[x][0], set()).add(values[y][0])
    best: dict[str, list[tuple[float, dict]]] = {}
    for i, a in enumerate(prepared):
        counts: set[int] = set(near_hash.get(i, ()))
        # Keep representatives from every dataset even for common values; never discard a whole bucket.
        # Bound expensive similarity evaluations per source across very large tables.
        for key in sorted(blocking_keys(a), key=lambda key: (not key.startswith(("exact:", "custom-exact:", "uid:")), key)):
            for dataset, bucket in index.get(key, {}).items():
                if within or dataset != a["record"]["dataset"]:
                    counts.update(j for j in bucket[:max(1, per_source)] if j > i)
            if len(counts) >= 500:
                break
        counts = set(sorted(counts)[:500])
        counts.update(j for j, b in enumerate(prepared) if j > i and (
            (len(b["user"]) >= 5 and b["user"] in a["text"]) or (len(a["user"]) >= 5 and a["user"] in b["text"])))
        for j in sorted(counts)[:500]:
            b = prepared[j]
            if a["record"]["id"] == b["record"]["id"]:
                continue
            if a["record"].get("_comparison_group") and a["record"].get("_comparison_group") == b["record"].get("_comparison_group"):
                continue
            if not within and a["record"]["dataset"] == b["record"]["dataset"]:
                continue
            if frozenset((a["record"]["id"], b["record"]["id"])) in known:
                continue
            signals = _pair_signals(a, b)
            score = _combine(signals)
            # A named primary person is an explicit review target. Name similarity can
            # surface a low-score candidate without asserting an account identity.
            primary_name = allow_primary_name_candidates and (a["record"].get("is_primary") or b["record"].get("is_primary")) and signals.get("display_name", 0) >= 0.4
            if score < threshold or not (_is_substantive(signals) or primary_name):
                continue
            left, right = (a, b) if order[a["record"]["dataset"]] <= order[b["record"]["dataset"]] else (b, a)
            best.setdefault(left["record"]["id"], []).append((score, {
                "left_id": left["record"]["id"], "right_id": right["record"]["id"],
                "evidence_score": score, "evidence": {"signals": signals}}))
    def balanced(groups, maximum):
        # Scores order each group; round-robin prevents the first sheet monopolizing the queue.
        groups = [sorted(group, key=lambda entry: -entry[0]) for group in groups.values()]
        picked = []
        offset = 0
        while len(picked) < maximum:
            batch = [group[offset] for group in groups if offset < len(group)]
            if not batch:
                break
            picked.extend(batch[:maximum - len(picked)])
            offset += 1
        return picked

    out: dict[tuple[str, str], list[tuple[float, dict]]] = {}
    for items in best.values():
        destinations = {}
        for score, pair in items:
            dataset = records[position[pair["right_id"]]]["dataset"]
            destinations.setdefault(dataset, []).append((score, pair))
        for score, pair in balanced(destinations, per_source):
            dataset_pair = (records[position[pair["left_id"]]]["dataset"], records[position[pair["right_id"]]]["dataset"])
            out.setdefault(dataset_pair, []).append((score, pair))
    return kept_existing + [pair for _, pair in balanced(out, limit)]


def splink_pairs(records: list[dict], threshold: float, limit: int = 200) -> list[dict]:
    try:
        version = metadata.version("splink")
        if int(version.split(".")[0]) != 5:
            raise RuntimeError(f"Splink 5.x required; installed {version}.")
        import pyarrow as pa
        import splink.comparison_library as cl
        from splink import DuckDBAPI, Linker, SettingsCreator, block_on
    except ImportError as error:
        raise RuntimeError("Splink 5 and PyArrow are required in the configured Python environment.") from error
    except metadata.PackageNotFoundError as error:
        raise RuntimeError("Splink is missing. Install it in a project Python environment.") from error

    by_dataset = {}
    for record in records:
        by_dataset.setdefault(record["dataset"], []).append(record)
    if len(by_dataset) < 2:
        raise ValueError("Splink needs at least two CSV datasets.")
    if len(records) < 20:
        raise ValueError("Splink parameter training needs at least 20 usable records; use Jina-only mode for smaller inputs.")

    all_fields = ("username", "display_name", "website", "location")
    useful = [field for field in all_fields if sum(bool(r["fields"][field]) for r in records) >= 4]
    if len(useful) < 2:
        raise ValueError("Splink needs at least two populated comparison fields across the datasets.")
    blocking = [block_on(field) for field in useful[:3]]
    comparisons = [cl.ExactMatch("username").configure(term_frequency_adjustments=True)
                   if field == "username" else
                   cl.JaroWinklerAtThresholds(field) if field in ("display_name", "location") else
                   cl.ExactMatch(field)
                   for field in useful]
    db_api = DuckDBAPI()
    tables = []
    for index, (name, items) in enumerate(by_dataset.items()):
        rows = [{"unique_id": item["id"], **{
            field: normalize(item["fields"][field]) or None for field in all_fields
        }} for item in items]
        tables.append(db_api.register(pa.Table.from_pylist(rows), dataset_display_name=f"dataset_{index}"))
    settings = SettingsCreator(
        link_type="link_only", unique_id_column_name="unique_id",
        comparisons=comparisons, blocking_rules_to_generate_predictions=blocking,
        retain_matching_columns=True, retain_intermediate_calculation_columns=True,
    )
    linker = Linker(tables, settings)
    linker.training.estimate_probability_two_random_records_match(blocking, recall=0.7)
    linker.training.estimate_u_using_random_sampling(max_pairs=100_000)
    for field in useful[:2]:
        try:
            linker.training.estimate_parameters_using_expectation_maximisation(block_on(field), max_pairs=100_000)
        except Exception:
            # No record pairs share this field (common with small or sparse datasets); keep the other estimates.
            continue
    predictions = linker.inference.predict(threshold_match_probability=threshold)
    results = predictions.as_record_list(limit)
    return [{
        "left_id": row["unique_id_l"], "right_id": row["unique_id_r"],
        "match_weight": row.get("match_weight"),
        "match_probability": row.get("match_probability"),
        "evidence": {key: value for key, value in row.items() if key.startswith("gamma_") or key.startswith("mw_")},
    } for row in results]


@lru_cache(maxsize=1)
def load_reranker(model_path: str, device: str):
    path = Path(model_path).expanduser().resolve()
    if not path.is_dir() or not (path / "config.json").exists():
        raise RuntimeError("Jina model path must be a local directory containing config.json.")
    try:
        from transformers import AutoModel
    except ImportError as error:
        raise RuntimeError("Transformers and a compatible PyTorch installation are required for Jina.") from error
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    model = AutoModel.from_pretrained(
        str(path), trust_remote_code=True, local_files_only=True,
        dtype="auto", device_map="cpu" if device == "cpu" else "auto",
    )
    model.eval()
    return model


def rerank(query: str, candidates: list[dict], model_path: str, device: str) -> list[dict]:
    model = load_reranker(model_path, device)
    ranked = model.rerank(query, [item["text"] for item in candidates])
    return [{"id": candidates[int(item["index"])]["id"],
             "score": float(item["relevance_score"]), "rank": rank + 1}
            for rank, item in enumerate(ranked)]


def column_profile(names: list[str], rows: list[dict]) -> dict:
    """Sample values and fill statistics used to suggest column roles without reading whole files in the UI."""
    samples, filled, distinct = {}, {}, {}
    for name in names:
        values = [row.get(name, "") for row in rows if row.get(name, "")]
        unique = list(dict.fromkeys(values))
        samples[name] = unique[:8]
        filled[name] = len(values)
        distinct[name] = len(unique)
    examples = [{name: value for name, value in row.items() if value} for row in rows[:5]]
    return {"samples": samples, "filled": filled, "distinct": distinct, "rows": len(rows), "examples": examples}


def handle(request: dict) -> dict:
    action = request.get("action")
    if action == "columns":
        columns = []
        for dataset in request.get("datasets", []):
            if "records" in dataset:
                names = sorted({key for record in dataset["records"] for key in record["fields"]})
                rows = [record["fields"] for record in dataset["records"]]
                columns.append({"name": dataset["name"], "columns": names, **column_profile(names, rows)})
                continue
            table = list(csv.reader(io.StringIO(dataset.get("csv", "").lstrip("\ufeff"), newline="")))
            header_index, header = dataset_header(table)
            names = list(dict.fromkeys(cell for cell in header if cell))
            # Side-by-side blocks repeat headers; a column's value is its first filled occurrence in the row.
            rows = [{name: next((clean(row[i]) for i, cell in enumerate(header) if cell == name and i < len(row) and clean(row[i])), "")
                     for name in names} for row in table[header_index + 1:] if any(clean(cell) for cell in row)]
            columns.append({"name": dataset["name"], "columns": names, **column_profile(names, rows)})
        return columns
    if action == "records":
        return parse_datasets(request.get("datasets", []), request.get("mappings"))
    if action == "check":
        versions = {}
        for name in ("splink", "pyarrow", "transformers", "torch"):
            try:
                versions[name] = metadata.version(name)
            except metadata.PackageNotFoundError:
                versions[name] = None
        return {"versions": versions}
    if action == "rerank":
        return {"rankings": rerank(request["query"], request["candidates"],
                                   request["model_path"], request.get("device", "cpu"))}
    if action != "analyze":
        raise ValueError("Unknown analysis action.")
    records = parse_datasets(request.get("datasets", []), request.get("mappings"))
    mode = request.get("mode", "combined")
    if mode not in ("splink", "jina", "combined"):
        raise ValueError("Unknown analysis mode.")
    floor = max(0.0, min(1.0, float(request.get("low_threshold", 0.2)), float(request.get("threshold", 0.5))))
    # Small/custom tables can be compared locally without statistical training or a model.
    trainable = len({record["dataset"] for record in records}) >= 2 and len(records) >= 20 and sum(
        sum(bool(r["fields"].get(field)) for r in records) >= 4
        for field in ("username", "display_name", "website", "location")) >= 2
    pairs = splink_pairs(records, min(float(request.get("threshold", 0.5)), floor)) if mode != "jina" and trainable else []
    pairs = evidence_pairs(records, pairs, threshold=floor, per_source=30, within=bool(request.get("compare_within")),
                           allow_primary_name_candidates=request.get("allow_primary_name_candidates") is True)

    rankings = []
    if mode != "splink" and pairs and request.get("model_path"):
        by_id = {record["id"]: record for record in records}
        grouped = {}
        for pair in pairs:
            grouped.setdefault(pair["left_id"], []).append(pair["right_id"])
        for source_id, target_ids in grouped.items():
            ranked = rerank(profile_text(by_id[source_id]),
                            [{"id": candidate_id, "text": profile_text(by_id[candidate_id])}
                             for candidate_id in target_ids[:30]],
                            request.get("model_path", ""), request.get("device", "cpu"))
            rankings.extend({"source_id": source_id, **item} for item in ranked)
    return {"records": records, "pairs": pairs, "jina": rankings}


if __name__ == "__main__":
    try:
        result = handle(json.load(sys.stdin))
        print(json.dumps({"ok": True, "result": result}, ensure_ascii=False))
    except Exception as error:
        message = str(error) if isinstance(error, ValueError) else f"{type(error).__name__}: {error}"
        print(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
        sys.exit(1)
