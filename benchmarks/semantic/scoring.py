"""Historical retrieval adapter, not RepoQA's generation/SNF evaluator."""
from functools import lru_cache
from pathlib import Path
import tiktoken


@lru_cache(maxsize=2048)
def source_lines(file):
    text = Path(file).read_bytes().decode("utf-8").replace("\r\n", "\n")
    parts = text.split("\n")
    return [line + "\n" for line in parts[:-1]] + ([parts[-1]] if parts[-1] else [])


def validate(root, results):
    if not isinstance(results, list):
        raise ValueError("expected a JSON result list")
    for hit in results:
        path = Path(hit["path"])
        if path.is_absolute() or ".." in path.parts:
            raise ValueError("result escaped scope")
        lines = source_lines(str(Path(root) / path))
        start, end = hit["start"], hit["end"]
        if type(start) is not int or type(end) is not int or not 1 <= start <= end <= len(lines):
            raise ValueError("result has an invalid source interval")
        expected = "".join(lines[start-1:end]).removesuffix("\n")
        if hit["content"].replace("\r\n", "\n").removesuffix("\n") != expected:
            raise ValueError("result content differs from source")


def score(query, root, results):
    validate(root, results)
    if query["target"] is None:
        return None  # EverTrace has no invented relevance labels.
    files = list(dict.fromkeys(hit["path"] for hit in results))
    target = query["target"]
    rank = files.index(target["path"]) + 1 if target["path"] in files else None
    metrics = {f"hit{k}": bool(rank and rank <= k) for k in (1, 5, 10, 100)}
    metrics.update(rank=rank, mrr10=1/rank if rank and rank <= 10 else 0)
    if query["dataset"] == "repoqa":
        seen, sequence, offset = set(), [], 0
        for hit in results:
            lines = source_lines(str(Path(root) / hit["path"]))
            for number in range(hit["start"], hit["end"] + 1):
                identity = (hit["path"], number)
                if identity in seen:
                    continue
                seen.add(identity)
                text = lines[number-1]
                offset += len(text.encode("utf-8"))
                sequence.append((identity, offset, text))
        encoder = tiktoken.get_encoding("o200k_base")
        tokens = encoder.encode("".join(row[2] for row in sequence), disallowed_special=())
        gold = {(target["path"], number) for number in range(target["start"], target["end"] + 1)}
        for budget in (2000, 8000):
            end = len(encoder.decode_bytes(tokens[:budget]))
            covered = {identity for identity, limit, _ in sequence if limit <= end}
            fraction = len(gold & covered) / len(gold)
            metrics[f"coverage{budget}"] = fraction
            metrics[f"half{budget}"] = fraction >= .5
            if budget == 8000:
                metrics["full8000"] = fraction == 1
    return metrics
