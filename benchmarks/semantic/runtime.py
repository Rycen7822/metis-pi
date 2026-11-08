"""One private shared-service lifetime, driven through the normal CLI."""
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import time

from datasets import read_json, write_json
from scoring import score

ENCODE_COUNTERS = ("actual_encoded_chunks", "actual_encoded_windows", "actual_encoded_batches", "actual_encoded_tokens")


def cold_gate(stage, publication):
    chunks = stage.get("scope_chunks", 0)
    return (stage.get("cache_hit") is False and chunks > 0
            and stage.get("semantic_scored_chunks") == chunks
            and stage.get("actual_encoded_chunks") == chunks
            and stage.get("actual_encoded_windows", 0) > 0
            and stage.get("reused_scored_chunks") == 0
            and stage.get("discarded_cached_chunks") == 0
            and publication.get("published") is True)


def warm_gate(stage):
    return (stage.get("cache_hit") is True
            and stage.get("semantic_scored_chunks") == stage.get("scope_chunks")
            and stage.get("scope_chunks", 0) > 0
            and all(stage.get(name) == 0 for name in ENCODE_COUNTERS))


def wait_exited(descriptor, seconds):
    with selectors.DefaultSelector() as selector:
        selector.register(descriptor, selectors.EVENT_READ)
        return bool(selector.select(seconds))


def artifact(path):
    stat = path.stat()
    if path.is_symlink() or stat.st_nlink != 1 or not path.is_file():
        raise ValueError(f"runtime artifacts must be physical files: {path}")
    return dict(path=str(path), bytes=stat.st_size, modified_ns=stat.st_mtime_ns, inode=stat.st_ino)


def bundle_identity(root, build_record=None):
    result = {"root": str(root), "artifacts": {}}
    for name in ("bin/sgrep", "lib/libsgrep_cpu.so", "lib/libonnxruntime.so.1", "assets.json"):
        result["artifacts"][name] = artifact(root / name)
    result["catalog"] = read_json(root / "assets.json")  # Reuse the runtime's existing asset identities.
    for name in ("SOURCE_COMMIT", "QUALIFICATION.md"):
        if (root / name).is_file():
            result[name] = (root / name).read_text()
    result["build_record"] = read_json(build_record) if build_record else None
    return result


class Service:
    def __init__(self, bundle, directory, budget, timeout):
        self.bundle, self.directory, self.timeout = bundle, directory, timeout
        self.binary = bundle / "bin/sgrep"
        self.pid = None
        self.pidfd = None
        self.directory.mkdir(parents=True, exist_ok=False)
        profile = directory / "profile"
        for name in ("home", "xdg", "config", "data", "cache", "tmp", "hf"):
            (profile / name).mkdir(parents=True)
        policy = profile / "budget.toml"
        policy.write_text(f"[neuralSearch.semantic]\ncacheBudgetMiB = {budget}\n")
        stat = policy.stat()
        selection = dict(budget_mib=budget, source=str(policy), stamp=dict(
            device=str(stat.st_dev), inode=str(stat.st_ino), length=str(stat.st_size),
            modified_ns=str(stat.st_mtime_ns), changed_ns=str(stat.st_ctime_ns)))
        self.env = {key: value for key, value in os.environ.items()
                    if not key.startswith(("SGREP_", "HF_")) and key not in ("LD_PRELOAD", "LD_LIBRARY_PATH")}
        self.env.update(HOME=str(profile / "home"), XDG_CACHE_HOME=str(profile / "xdg"),
                        XDG_CONFIG_HOME=str(profile / "config"), XDG_DATA_HOME=str(profile / "data"),
                        TMPDIR=str(profile / "tmp"), HF_HOME=str(profile / "hf"), HF_TOKEN="", HF_HUB_OFFLINE="1",
                        SGREP_CACHE_DIR=str(profile / "cache"), SGREP_RUNTIME_DIR=str(bundle),
                        SGREP_CACHE_POLICY_REQUEST=json.dumps(selection),
                        TREE_SITTER_LANGUAGE_PACK_CACHE_DIR=str(bundle / "parsers"),
                        TOKENIZERS_PARALLELISM="false", RAYON_NUM_THREADS="4", OMP_NUM_THREADS="1",
                        OPENBLAS_NUM_THREADS="1", MKL_NUM_THREADS="1", NUMEXPR_NUM_THREADS="1")
        write_json(directory / "environment.json", {key: value for key, value in self.env.items()
                                                   if key not in os.environ or value != os.environ[key]})
        if self.status() is not None:
            raise RuntimeError("new private HOME unexpectedly has a running service")

    def status(self):
        run = subprocess.run([str(self.binary), "--service-control", "status"], env=self.env,
                             capture_output=True, timeout=10)
        if run.returncode:
            return None
        result = json.loads(run.stdout)
        pid = result["pid"]
        if self.pid is not None and self.pid != pid:
            raise RuntimeError("private service restarted within a trial")
        self.pid = pid
        if self.pidfd is None:
            self.pidfd = os.pidfd_open(pid)
        return result

    def capture_loaded(self):
        state = self.status()
        if state is None:
            raise RuntimeError("successful request has no live private service")
        proc = Path(f"/proc/{self.pid}")
        maps = (proc / "maps").read_text()
        (self.directory / "service.maps").write_text(maps)
        (self.directory / "service.status").write_text((proc / "status").read_text())
        modules = {line.split()[-1] for line in maps.splitlines() if "/" in line}
        for name in ("libsgrep_cpu.so", "libonnxruntime.so.1"):
            if str(self.bundle / "lib" / name) not in modules:
                raise RuntimeError(f"unexpected loaded {name}; see service.maps")
        if state.get("computing_threads_per_request") != 4 or state.get("active_limit") not in (None, 3):
            raise RuntimeError("unexpected service compute budget")
        write_json(self.directory / "loaded.json", dict(state=state, executable=os.readlink(proc / "exe")))

    def invoke(self, query, scope, label, *, trace=False):
        directory = self.directory / label
        directory.mkdir()
        env = self.env | {
            "SGREP_STAGE_TIMINGS_PATH": str(directory / "stage.json"),
            "SGREP_SERVICE_INFO_PATH": str(directory / "service.json"),
            "SGREP_CACHE_DIAGNOSTICS_PATH": str(directory / "publication.json"),
        }
        if trace:
            env["SGREP_RETRIEVAL_TRACE_PATH"] = str(directory / "trace.json")
        argv = [str(self.binary), "--shared-service", "--service-timeout-seconds", str(self.timeout),
                "--json", "--explain", "--metis-protocol", "1", "--model", "code", "-n", str(query["limit"]),
                "--", query["query"], scope["root"]]
        write_json(directory / "started.json", dict(argv=argv, trace=trace))
        record = dict(query=query["id"], dataset=query["dataset"], scope=query["scope"], label=label,
                      directory=str(directory), valid=False, error=None, metrics=None)
        start_raw = time.clock_gettime_ns(time.CLOCK_MONOTONIC_RAW)
        start_mono = time.monotonic_ns()
        with (directory / "stdout").open("wb") as stdout, (directory / "stderr").open("wb") as stderr:
            process = subprocess.Popen(argv, env=env, stdout=stdout, stderr=stderr, start_new_session=True)
            try:
                descriptor = os.pidfd_open(process.pid)
                try:
                    if not wait_exited(descriptor, self.timeout + 10):
                        raise TimeoutError("client exit deadline")
                    ended_raw = time.clock_gettime_ns(time.CLOCK_MONOTONIC_RAW)
                    ended_mono = time.monotonic_ns()
                    code = process.wait()
                finally:
                    os.close(descriptor)
            except BaseException:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGKILL)
                process.wait()
                record["error"] = "client interrupted or timed out; private service cleanup follows"
                write_json(directory / "result.json", record)
                raise
        record.update(exit=code, wall_raw_ms=(ended_raw-start_raw)/1e6,
                      wall_monotonic_ms=(ended_mono-start_mono)/1e6, trace_enabled=trace)
        for field, name in (("stage", "stage"), ("service", "service"), ("publication", "publication")):
            path = directory / f"{name}.json"
            record[field] = read_json(path) if path.exists() else {}
        try:
            if code:
                raise ValueError(f"CLI exit {code}; see stderr")
            if not record["stage"] or not record["service"]:
                raise ValueError("requested stage/service diagnostics are missing")
            output = read_json(directory / "stdout")
            if output.get("protocol") != 1:
                raise ValueError("host protocol mismatch")
            results = output["results"]
            if trace:
                trace_data = read_json(directory / "trace.json")
                if trace_data.get("source_verified") is not True:
                    raise ValueError("unverified retrieval trace")
            record["metrics"] = score(query, scope["root"], results)
            record["valid"] = True
        except (ValueError, KeyError, TypeError, OSError) as error:
            record["error"] = str(error)
        if not trace and abs(record["wall_monotonic_ms"] / record["wall_raw_ms"] - 1) > .01:
            record.update(valid=False, error="clock rates diverged by more than 1%; retain as diagnostic")
        return record

    def close(self):
        try:
            if self.status() is None:
                return
            result = subprocess.run([str(self.binary), "--service-control", "stop"], env=self.env,
                                    capture_output=True, timeout=20)
            write_json(self.directory / "stop.json", dict(exit=result.returncode,
                       stdout=result.stdout.decode(), stderr=result.stderr.decode()))
            if not wait_exited(self.pidfd, 10):
                raise RuntimeError("private service stop deadline; forced cleanup follows")
            if result.returncode or self.status() is not None:
                raise RuntimeError("private service stop failed")
        finally:
            if self.pidfd is not None:
                try:
                    if not wait_exited(self.pidfd, 0):
                        signal.pidfd_send_signal(self.pidfd, signal.SIGTERM)
                        if not wait_exited(self.pidfd, 5):
                            signal.pidfd_send_signal(self.pidfd, signal.SIGKILL)
                            if not wait_exited(self.pidfd, 5):
                                raise RuntimeError("private service cleanup deadline")
                finally:
                    os.close(self.pidfd)
                    self.pidfd = None
