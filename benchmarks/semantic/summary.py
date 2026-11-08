"""Summaries retain failed requests in quality denominators; timing uses qualified points."""
from collections import defaultdict
import statistics


def distribution(values):
    return dict(count=len(values), mean=statistics.mean(values) if values else None,
                median=statistics.median(values) if values else None,
                variance=statistics.variance(values) if len(values) > 1 else None,
                minimum=min(values) if values else None, maximum=max(values) if values else None)


def summarize(records, comparisons, *, complete, failure, mode, smoke):
    quality, latency, paired = defaultdict(list), defaultdict(list), defaultdict(dict)
    qualified = []
    for record in records:
        if record["phase"] == "quality" and record["dataset"] != "evertrace":
            quality[record["arm"], record["dataset"]].append(record)
        eligible = record["valid"] and (record["phase"] != "cold" or record.get("verified_hit") is True)
        if eligible and record["phase"] in ("cold", "warm"):
            key = (record["arm"], record["dataset"], record["scope"], record["phase"], record["pair_kind"])
            latency[key].append(record["wall_raw_ms"])
            qualified.append(record)
            if record["pair_kind"] in ("ab", "aa"):
                identity = (record["pair_kind"], record["pair"], record["dataset"], record["scope"],
                            record["phase"], record["query"], record.get("repeat"))
                paired[identity][record["position"]] = record
    qualities = []
    for (arm, dataset), points in quality.items():
        metrics = {"hit1", "hit5", "hit10", "hit100", "mrr10"}
        if dataset == "repoqa":
            metrics.update(("coverage2000", "coverage8000", "half2000", "half8000", "full8000"))
        qualities.append(dict(arm=arm, dataset=dataset, denominator=len(points), valid=sum(p["valid"] for p in points),
                              metrics={name: sum((p.get("metrics") or {}).get(name, 0) for p in points)/len(points)
                                       for name in metrics}))
    pairs = []
    for identity, points in paired.items():
        if len(points) != 2:
            continue
        left, right = points[0], points[1]
        if identity[0] == "ab" and left["arm"] == "candidate":
            left, right = right, left
        before, after = left["wall_raw_ms"], right["wall_raw_ms"]
        pairs.append(dict(kind=identity[0], pair=identity[1], dataset=identity[2], scope=identity[3],
                          phase=identity[4], query=identity[5], repeat=identity[6],
                          control_ms=before, comparison_ms=after, delta_pct=(after/before-1)*100))
    failures = [dict(directory=p["directory"], error=p["error"]) for p in records if not p["valid"]]
    differences = [row for row in comparisons if not row["equal"] or row.get("work_equal") is False]
    unverified_cold = [p["directory"] for p in records if p["phase"] == "cold" and not p.get("verified_hit")]
    return dict(
        version=1, passed=complete and bool(records) and not failures and not differences and not unverified_cold,
        unverified_cold=unverified_cold,
        complete=complete, failure=failure, mode=mode, smoke=smoke,
        meaning="harness/result-consistency checks only; not an automatic performance adoption decision",
        requests=len(records), invalid_requests=failures, differences=differences,
        quality=qualities,
        latency=[dict(arm=key[0], dataset=key[1], scope=key[2], phase=key[3], kind=key[4],
                      raw_ms=distribution(values)) for key, values in latency.items()],
        paired_deltas=pairs,
        paired_delta_summary=[dict(kind=kind, phase=phase,
                                   delta_pct=distribution([p["delta_pct"] for p in pairs
                                                           if p["kind"] == kind and p["phase"] == phase]))
                              for kind in ("ab", "aa") for phase in ("cold", "warm")],
        cold_with_verified_hit=sum(p["phase"] == "cold" for p in qualified),
    )
