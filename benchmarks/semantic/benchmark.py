#!/usr/bin/env python3
"""Prepare and run the RepoQA/CoSQA/EverTrace retrieval benchmark (Linux x64)."""
import argparse
import fcntl
from importlib.metadata import version
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys

sys.dont_write_bytecode = True
from datasets import HERE, prepare, read_json, write_json
from runtime import Service, bundle_identity, cold_gate, warm_gate
from summary import summarize

REPO = HERE.parents[1]
TRACE_FIELDS = ("candidates", "semantic_top200", "bm25_top200", "supplied", "exact", "union", "final")


def exact_comparison(left, right):
    a, b = Path(left["directory"]), Path(right["directory"])
    stdout_equal = (a / "stdout").read_bytes() == (b / "stdout").read_bytes()
    fields = {}
    if left["trace_enabled"] and right["trace_enabled"]:
        first, second = read_json(a / "trace.json"), read_json(b / "trace.json")
        fields = {field: first[field] == second[field] for field in TRACE_FIELDS}
    return dict(stdout_equal=stdout_equal, trace_fields_equal=fields,
                equal=stdout_equal and all(fields.values()))


def select(inputs, datasets, mode, smoke):
    panel = {(q["dataset"], q["id"]) for q in inputs["panel"]}
    scopes = [scope for scope in inputs["scopes"] if scope["dataset"] in datasets]
    missing = set(datasets) - {scope["dataset"] for scope in scopes}
    if missing or len(datasets) != len(set(datasets)):
        raise ValueError(f"missing or repeated datasets: {datasets}; missing={sorted(missing)}")
    if smoke:
        scopes = [next(scope for scope in scopes if scope["dataset"] == name) for name in datasets]
    result = []
    for scope in scopes:
        queries = [q for q in inputs["queries"] if q["dataset"] == scope["dataset"] and q["scope"] == scope["id"]]
        if mode == "latency":
            queries = [q for q in queries if q["dataset"] == "evertrace" or (q["dataset"], q["id"]) in panel]
        if smoke:
            queries = queries[:1]
        if not queries:
            raise ValueError(f"scope has no selected queries: {scope['id']}")
        result.append((scope, queries))
    return result


def trial(args, bundle, directory, scope, queries, metadata, save):
    service = Service(bundle, directory, args.budget, args.timeout)
    records = []
    try:
        if args.mode == "quality":
            for i, query in enumerate(queries):
                record = service.invoke(query, scope, f"quality-{i:04d}", trace=True)
                record.update(metadata, phase="quality")
                save(record)
                records.append(record)
            if any(record["valid"] for record in records):
                service.capture_loaded()
        else:
            query = queries[0]
            cold = service.invoke(query, scope, "cold")
            cold.update(metadata, phase="cold")
            if cold["valid"] and not cold_gate(cold["stage"], cold["publication"]):
                cold.update(valid=False, error="empty-index build failed complete-work/publication gate")
            save(cold)
            records.append(cold)
            if cold["valid"]:
                service.capture_loaded()
                first_hit = None
                expected = {query["id"]: cold}
                for repeat in range(args.warm_repeats):
                    for i, query in enumerate(queries):
                        hit = service.invoke(query, scope, f"warm-{repeat:02d}-{i:03d}")
                        hit.update(metadata, phase="warm", repeat=repeat)
                        if hit["valid"] and not warm_gate(hit["stage"]):
                            hit.update(valid=False, error="expected cache hit with zero document encodes")
                        previous = expected.get(query["id"])
                        if hit["valid"] and previous and not exact_comparison(previous, hit)["equal"]:
                            hit.update(valid=False, error="same-query stdout changed within one trial")
                        if repeat == 0 and i == 0:
                            first_hit = hit
                        expected.setdefault(query["id"], hit)
                        save(hit)
                        records.append(hit)
                        if not hit["valid"]:
                            break
                    if not records[-1]["valid"]:
                        break
                cold["verified_hit"] = bool(first_hit and first_hit["valid"])
                write_json(Path(cold["directory"]) / "result.json", cold)
    finally:
        service.close()
    return records


def run(args):
    if sys.platform != "linux" or platform.machine() not in ("x86_64", "AMD64"):
        raise ValueError("this runtime benchmark requires Linux x64 with pidfd support")
    if args.mode == "quality" and (args.pairs != 1 or args.aa_pairs):
        raise ValueError("quality is one full pass; use latency for repeated pairs")
    data, output = args.data.resolve(strict=True), args.output.resolve()
    inputs = read_json(data / "inputs.json")
    chosen = select(inputs, args.datasets, args.mode, args.smoke)
    for scope, _ in chosen:
        if output.is_relative_to(Path(scope["root"])):
            raise ValueError("results must be outside every searched scope")
        if not Path(scope["root"]).is_dir():
            raise ValueError(f"missing prepared corpus: {scope['root']}")
    bundles = dict(control=args.control.resolve(strict=True))
    if args.candidate:
        bundles["candidate"] = args.candidate.resolve(strict=True)
    identities = {name: bundle_identity(bundle, getattr(args, f"{name}_build")) for name, bundle in bundles.items()}
    output.mkdir(parents=True, exist_ok=False)
    snapshot = output / "harness"
    snapshot.mkdir()
    for path in sorted(HERE.iterdir()):
        if path.is_file() and path.suffix in (".py", ".json", ".txt", ".md"):
            shutil.copyfile(path, snapshot / path.name)
    os.environ.setdefault("TIKTOKEN_CACHE_DIR", str(data / "tokenizer-cache"))
    # Load evaluator resources before any timed model work; evaluation is outside CLI timing.
    if "repoqa" in args.datasets:
        import tiktoken
        tiktoken.get_encoding("o200k_base")
    plans = [("ab" if args.candidate else "single", pair,
              ["control", "candidate"] if args.candidate else ["control"]) for pair in range(args.pairs)]
    plans.extend(("aa", pair, ["control", "control"]) for pair in range(args.aa_pairs))
    git_info = dict(head=subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, text=True).strip(),
                    status=subprocess.check_output(["git", "status", "--short"], cwd=REPO, text=True))
    write_json(output / "identity.json", dict(
        version=1, harness=git_info | {"snapshot": str(snapshot)}, bundles=identities,
        platform=platform.platform(), python=sys.version,
        logical_cpus=os.cpu_count(), cpuinfo=Path("/proc/cpuinfo").read_text(),
        evaluator={name: version(name) for name in ("tiktoken", "regex")},
        clocksource=Path("/sys/devices/system/clocksource/clocksource0/current_clocksource").read_text().strip(),
        data=str(data / "inputs.json"), sources=inputs["sources"], budget_mib=args.budget,
        mode=args.mode, smoke=args.smoke, warm_repeats=args.warm_repeats,
        order=[dict(kind=kind, pair=pair, arms=arms if pair % 2 == 0 else arms[::-1]) for kind, pair, arms in plans],
        scopes=[{key: value for key, value in scope.items() if key != "copied_paths"} for scope, _ in chosen],
        timing="pidfd process-exit; CLOCK_MONOTONIC_RAW wall; existing phase diagnostics; no physical cold-page claim"))
    records, comparisons = [], []
    complete, failure = False, None

    def save(record):
        write_json(Path(record["directory"]) / "result.json", record)
        with (output / "records.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(record, ensure_ascii=False, allow_nan=False) + "\n")
        print(json.dumps({key: record.get(key) for key in
                          ("dataset", "scope", "arm", "phase", "query", "valid", "wall_raw_ms", "error")}), flush=True)

    try:
        for kind, pair, arms in plans:
            order = arms if pair % 2 == 0 else arms[::-1]
            for ordinal, (scope, queries) in enumerate(chosen):
                runs = []
                for position, arm in enumerate(order):
                    trial_id = f"{kind}-{pair:02d}-{ordinal:02d}-{position}-{arm}"
                    directory = output / "runs" / trial_id
                    metadata = dict(arm=arm, pair=pair, pair_kind=kind, position=position, trial=trial_id)
                    points = trial(args, bundles[arm], directory, scope, queries, metadata, save)
                    records.extend(points)
                    runs.append(points)
                if len(runs) == 2:
                    left = {(record["phase"], record["query"], record.get("repeat")): record for record in runs[0]}
                    for right in runs[1]:
                        key = (right["phase"], right["query"], right.get("repeat"))
                        first = left.get(key)
                        if first and first["valid"] and right["valid"]:
                            work_fields = ("scope_chunks", "semantic_scored_chunks", "actual_encoded_chunks",
                                           "actual_encoded_windows", "actual_encoded_tokens", "query_encoded_tokens",
                                           "scored_document_tokens")
                            same_work = all(first["stage"].get(f) == right["stage"].get(f) for f in work_fields)
                            comparisons.append(dict(kind=kind, pair=pair, scope=scope["id"],
                                                    query=right["query"], phase=right["phase"], work_equal=same_work,
                                                    **exact_comparison(first, right)))
        complete = True
    except BaseException as error:
        failure = f"{type(error).__name__}: {error}"
        raise
    finally:
        write_json(output / "records.json", records)
        write_json(output / "comparisons.json", comparisons)
        result = summarize(records, comparisons, complete=complete, failure=failure,
                           mode=args.mode, smoke=args.smoke)
        write_json(output / "summary.json", result)
        print(json.dumps(result, ensure_ascii=False), flush=True)
    return 0 if result["passed"] else 1


def positive(value):
    result = int(value)
    if result <= 0:
        raise argparse.ArgumentTypeError("must be positive")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    prep = commands.add_parser("prepare", help="materialize complete public corpora and optional EverTrace")
    prep.add_argument("--output", type=Path, required=True)
    prep.add_argument("--repoqa", type=Path, default=REPO / "references/repoqa")
    prep.add_argument("--cosqa", type=Path, default=REPO / "references/cosqa")
    prep.add_argument("--evertrace", type=Path)
    execute = commands.add_parser("run", help="normal shared CLI, isolated service and quota profile per scope/trial")
    execute.add_argument("--data", type=Path, required=True)
    execute.add_argument("--output", type=Path, required=True)
    execute.add_argument("--control", type=Path, required=True, help="complete staged runtime bundle")
    execute.add_argument("--candidate", type=Path)
    execute.add_argument("--control-build", type=Path, help="existing JSON build provenance (optional)")
    execute.add_argument("--candidate-build", type=Path)
    execute.add_argument("--mode", choices=("latency", "quality"), required=True)
    execute.add_argument("--datasets", nargs="+", choices=("repoqa", "cosqa", "evertrace"),
                         default=["repoqa", "cosqa", "evertrace"])
    execute.add_argument("--budget", type=int, choices=(256, 512, 1024), default=512)
    execute.add_argument("--pairs", type=positive, default=1)
    execute.add_argument("--aa-pairs", type=int, choices=range(0, 21), default=0)
    execute.add_argument("--warm-repeats", type=positive, default=6)
    execute.add_argument("--timeout", type=positive, default=600)
    execute.add_argument("--smoke", action="store_true", help="one full scope and one query per dataset; not full quality")
    args = parser.parse_args()
    if args.command == "prepare":
        result = prepare(args.output.resolve(), args.repoqa.resolve(), args.cosqa.resolve(), args.evertrace)
        print(json.dumps(dict(questions=result["public_questions"], scopes=len(result["scopes"]))))
        return 0
    if args.timeout > 3600:
        parser.error("service timeout must be <=3600 seconds")
    lock = REPO / ".work/semantic-benchmark/performance.lock"
    lock.parent.mkdir(parents=True, exist_ok=True)
    with lock.open("a") as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            parser.error("another benchmark owns .work/semantic-benchmark/performance.lock")
        return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
