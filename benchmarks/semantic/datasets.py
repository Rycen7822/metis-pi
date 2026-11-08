"""Prepare the frozen retrieval tasks; queries and gold stay outside search scopes."""
import json
from pathlib import Path
import shutil
import subprocess

HERE = Path(__file__).resolve().parent
EVERTRACE_QUERIES = [
    "assemble relational query results and resolve entity projections in the store",
    "recover persisted trace data after an interrupted transaction",
    "configure retention and delete expired trace events",
    "validate incoming requests and report structured errors",
    "coordinate asynchronous workers and handle cancellation",
]


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args])


def relative_path(name):
    path = Path(name)
    if not name or path.is_absolute() or ".." in path.parts or ".git" in path.parts:
        raise ValueError(f"unsafe corpus path: {name!r}")
    return path


def new_scope(root):
    root.mkdir(parents=True, exist_ok=False)
    subprocess.run(["git", "init", "-q", "--template=", str(root)], check=True, capture_output=True)


def materialize(root, files):
    new_scope(root)
    for name, text in files.items():
        target = root / relative_path(name)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(text.encode("utf-8"))
    listed = subprocess.check_output(["rg", "--no-config", "--files", "-0", "--", "."], cwd=root)
    visible = {name.decode().removeprefix("./") for name in listed.split(b"\0") if name}
    if visible != set(files):
        raise ValueError(f"corpus visibility differs from official input: {root}")
    return {"files": len(files), "bytes": sum(len(text.encode("utf-8")) for text in files.values())}


def snapshot_evertrace(source, root):
    source = source.resolve(strict=True)
    names = sorted(set(git(source, "ls-files", "--cached", "--others", "--exclude-standard", "-z").split(b"\0")) - {b""})
    new_scope(root)
    copied, total, deleted = [], 0, []
    for raw in names:
        name = raw.decode("utf-8")  # Fail on ambiguous display paths.
        relative = relative_path(name)
        path = source / relative
        if any(p.is_symlink() for p in (path, *path.parents)):
            raise ValueError(f"linked source is forbidden: {path}")
        if not path.exists():
            deleted.append(name)
            continue
        before = path.stat()
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)  # Physical copy; no symlinks or hardlinks.
        after = path.stat()
        if (before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns):
            raise ValueError(f"source changed while copying: {path}")
        copied.append(name)
        total += after.st_size
    if not copied:
        raise ValueError("EverTrace snapshot is empty")
    return {
        "files": len(copied), "bytes": total, "copied_paths": copied, "deleted_paths": deleted,
        "origin": str(source), "commit": git(source, "rev-parse", "HEAD").decode().strip(),
        "status": git(source, "status", "--porcelain=v1").decode(),
    }


def prepare(output, repoqa, cosqa, evertrace):
    output.mkdir(parents=True, exist_ok=False)
    queries, scopes = [], []
    raw = read_json(repoqa / "data/repoqa-2024-06-23.json")
    for language, repositories in sorted(raw.items()):
        for repository in repositories:
            name = f'{language}-{repository["repo"].replace("/", "__")}'
            root = output / "corpora/repoqa" / relative_path(name)
            meta = materialize(root, repository["content"])
            scopes.append(dict(dataset="repoqa", id=name, root=str(root), language=language,
                               commit=repository["commit_sha"], **meta))
            for ordinal, needle in enumerate(repository["needles"]):
                content = repository["content"][needle["path"]].encode("utf-8")
                a, b = needle["start_byte"], needle["end_byte"]
                if not 0 <= a < b <= len(content):
                    raise ValueError("invalid official byte interval")
                start, end = content[:a].count(b"\n") + 1, content[:b-1].count(b"\n") + 1
                if start != needle["start_line"] + 1 or end != needle["end_line"]:
                    raise ValueError("official byte and line spans disagree")
                queries.append(dict(dataset="repoqa", id=f"{name}-{ordinal:02d}", scope=name, language=language,
                                    query=needle["description"], limit=50,
                                    target=dict(path=needle["path"], start=start, end=end)))
    mapping = read_json(cosqa / "data/search/code_idx_map.txt")
    if len(mapping) != 6267 or sorted(mapping.values()) != list(range(6267)):
        raise ValueError("expected the 6267-candidate CoSQA retrieval corpus")
    files = {f"code_{index:05d}.py": text for text, index in mapping.items()}
    meta = materialize(output / "corpora/cosqa", files)
    scopes.append(dict(dataset="cosqa", id="cosqa", root=str(output / "corpora/cosqa"), **meta))
    for row in read_json(cosqa / "data/search/cosqa-retrieval-test-500.json"):
        path = f'code_{row["retrieval_idx"]:05d}.py'
        if row["label"] != 1 or files[path] != row["code"]:
            raise ValueError("CoSQA gold/candidate mismatch")
        queries.append(dict(dataset="cosqa", id=row["idx"], scope="cosqa", language="python",
                            query=row["doc"], limit=100, target=dict(path=path)))
    counts = {name: sum(q["dataset"] == name for q in queries) for name in ("repoqa", "cosqa")}
    if counts != dict(repoqa=600, cosqa=500) or len(scopes) != 61:
        raise ValueError(f"unexpected official dataset size: {counts}")
    if evertrace:
        meta = snapshot_evertrace(evertrace, output / "corpora/evertrace")
        scopes.append(dict(dataset="evertrace", id="evertrace", root=str(output / "corpora/evertrace"), **meta))
        queries.extend(dict(dataset="evertrace", id=f"evertrace-{i+1}", scope="evertrace", language="mixed",
                            query=query, limit=50, target=None) for i, query in enumerate(EVERTRACE_QUERIES))
    panel = read_json(HERE / "panel.json")
    identities = {(q["dataset"], q["id"]) for q in queries}
    if len(identities) != len(queries) or any((q["dataset"], q["id"]) not in identities for q in panel):
        raise ValueError("duplicate query identity or missing historical latency panel")
    inputs = dict(version=1, public_questions=counts, scopes=scopes, queries=queries, panel=panel,
                  sources={name: dict(path=str(path), commit=git(path, "rev-parse", "HEAD").decode().strip())
                           for name, path in (("repoqa", repoqa), ("cosqa", cosqa))})
    write_json(output / "inputs.json", inputs)
    return inputs
