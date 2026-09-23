"""Do not substitute registration or lifetime ingestion counts for coverage."""
from datetime import datetime, timezone, timedelta


def is_test_source(source):
    name = str(source.get("name", "")).lower()
    return (source.get("is_test") is True or
            source.get("environment") in ("test", "verification") or
            name.startswith(("verification-", "test-")) or
            name == "humint-source-meridian-07")


def coverage(sources, keywords, now=None):
    now = now or datetime.now(timezone.utc)
    registered, productive, verified = [], [], []
    for source in sources:
        label = (str(source.get("name", "")) + " " + str(source.get("uri", ""))).lower()
        if not any(keyword in label for keyword in keywords):
            continue
        registered.append(source)
        if is_test_source(source) or source.get("enabled") is not True:
            continue
        if (source.get("items_total") or 0) > 0:
            productive.append(source)
        # These fields must come from measured, deduplicated ingestion, never
        # from an inference made over the lifetime counter or last_status.
        try:
            start = datetime.fromisoformat(source["coverage_window_start"].replace("Z", "+00:00"))
            end = datetime.fromisoformat(source["coverage_window_end"].replace("Z", "+00:00"))
            count = source["unique_items_in_window"]
            if (isinstance(count, int) and not isinstance(count, bool) and count > 0 and
                    timedelta(0) < end - start <= timedelta(days=7) and
                    timedelta(0) <= now - end <= timedelta(hours=24) and
                    source.get("coverage_evidence_id")):
                verified.append(source)
        except (KeyError, TypeError, ValueError):
            pass
    return {
        "registered": len(registered),
        "historically_productive": len(productive),
        "recent_coverage": "verified" if verified else "not_demonstrated",
        "evidence_ids": [s["coverage_evidence_id"] for s in verified],
    }


def quality_summary(sources):
    production = [s for s in sources if not is_test_source(s)]
    tests = [s for s in sources if is_test_source(s)]
    return {
        "production_sources": len(production),
        "test_sources": len(tests),
        "test_raw_items": sum(s.get("items_total") or 0 for s in tests),
        "ok_without_items": [s.get("name") for s in production
                             if s.get("last_status") == "ok" and not s.get("items_total")],
        "non_letter_reliability": [s.get("name") for s in sources
                                   if s.get("reliability") not in ("A", "B", "C", "D", "E", "F", None)],
    }
