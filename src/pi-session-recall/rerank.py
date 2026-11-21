"""Private, offline BF16 scorer for the pinned Yuanbao 0.6B Recall recipe."""
import hashlib
import json
from pathlib import Path
import sys

LIMIT = 1024
BUDGET = 2048
PREFIX = ('<|im_start|>system\nJudge whether the Document meets the requirements based on the Query and the Instruct provided. '
          'Note that the answer can only be "yes" or "no".<|im_end|>\n<|im_start|>user\n')
RULE = ('Retrieve excerpts from previous conversations that provide concrete evidence for answering the question. '
        'An excerpt that only discusses the same topic is not evidence.')
SUFFIX = '<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n'
ARTIFACTS = {
    'config.json': (64_000, '48d60f3a8b44c23dc5fc76a247ccfc3876cf011472eda340bc5d1588620c5938'),
    'tokenizer.json': (12_000_000, 'be75606093db2094d7cd20f3c2f385c212750648bd6ea4fb2bf507a6a4c55506'),
    'tokenizer_config.json': (64_000, '397bdca5697f44ab70a567f196203e396fc904b1891bb79fc107e304fb3d8f2c'),
    'model.safetensors': (1_192_000_000, '5518577ec411e854485f0424a67dd93729a17c1f9f500200f4ce3438ee3477e1'),
}


class InputLimit(Exception):
    pass


class Reranker:
    def __init__(self, directory):
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer

        if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():
            raise RuntimeError('Enhanced Recall requires CUDA BF16')
        for name, (limit, digest) in ARTIFACTS.items():
            with (directory/name).open('rb') as f:
                if f.seek(0, 2) > limit:
                    raise ValueError('Oversized local reranker artifact')
                f.seek(0)
                if hashlib.file_digest(f, 'sha256').hexdigest() != digest:
                    raise ValueError('Mismatched local reranker artifact')
        torch.set_num_threads(4)
        self.torch = torch
        self.tokenizer = AutoTokenizer.from_pretrained(directory, local_files_only=True, trust_remote_code=False)
        self.model = AutoModelForCausalLM.from_pretrained(
            directory, local_files_only=True, trust_remote_code=False, dtype=torch.bfloat16,
            device_map={'': 'cuda:0'}, attn_implementation='sdpa', use_safetensors=True,
        ).eval()
        if any(p.device != torch.device('cuda:0') or p.dtype != torch.bfloat16 for p in self.model.parameters()):
            raise ValueError('Unexpected reranker runtime placement')
        yes, = self.tokenizer.encode('yes', add_special_tokens=False)
        no, = self.tokenizer.encode('no', add_special_tokens=False)
        self.head = self.model.lm_head.weight[[yes, no]].contiguous()
        self.pad = self.tokenizer.pad_token_id if self.tokenizer.pad_token_id is not None else self.tokenizer.eos_token_id

    def encode(self, query, centers):
        prefix = f'{PREFIX}<Instruct>: {RULE}\n\n<Query>: {query}\n\n<Document>: '
        prompts = [prefix + item['text'] + SUFFIX for item in centers]
        ids = self.tokenizer(prompts, add_special_tokens=False)['input_ids']
        if any(len(row) > LIMIT for row in ids):
            raise InputLimit()
        return ids

    def rank(self, pairs, centers):
        # Preserve the independently batched K16 and K64 views; sharing logits changed displayed evidence in development.
        torch = self.torch
        slots = sorted(range(len(pairs)), key=lambda i: len(pairs[i]))
        margins = [0.0] * len(pairs)
        start = 0
        while start < len(slots):
            end = start + 1
            while end < len(slots) and len(pairs[slots[end]]) * (end - start + 1) <= 8192:
                end += 1
            indices = slots[start:end]
            seqs = [pairs[i] for i in indices]
            width = len(seqs[-1])
            ids = torch.tensor([s + [self.pad] * (width-len(s)) for s in seqs], dtype=torch.long, device='cuda:0')
            tail = torch.tensor([len(s)-1 for s in seqs], dtype=torch.long, device='cuda:0')
            with torch.inference_mode():
                hidden = self.model.model(input_ids=ids, use_cache=False).last_hidden_state
                logits = torch.nn.functional.linear(hidden[torch.arange(len(seqs), device='cuda:0'), tail], self.head).float()
                if not torch.isfinite(logits).all():
                    raise ValueError('Nonfinite reranker result')
                for i, (yes, no) in zip(indices, logits.cpu().tolist(), strict=True):
                    margins[i] = yes - no
            start = end
        return [centers[i] for i in sorted(range(len(centers)), key=lambda i: (-margins[i], i))]

    def count(self, text):
        return len(self.tokenizer.encode(text, add_special_tokens=False))


def render(ordered, count, cap):
    output = ''
    selected = []
    sources = {}
    for item in ordered:
        source, entry = item['source'], item['entry']
        seen = sources.get(source, set())
        if not item['passage'] or entry in seen or len(seen) == 3:
            continue
        section = output + item['passage']
        if count(section) > cap:
            continue
        selected.append(item)
        sources.setdefault(source, set()).add(entry)
        output = section
        if len(selected) == 10:
            break
    return selected, count(output)


def allocate(reference, wide, count):
    old, cap = render(reference, count, BUDGET)
    featured = {}
    for item in old:
        featured.setdefault(item['source'], item)
        if len(featured) == 5:
            break
    prefix = list(featured.values())
    chosen, tokens = render(prefix + wide, count, cap)
    if chosen[:len(prefix)] != prefix:
        chosen, tokens = old, cap
    return dict(ids=[x['id'] for x in chosen], tokens=tokens, cap=cap)


def main():
    request = json.loads(sys.stdin.buffer.readline(1024 * 1024 + 1))
    query, reference, wide = (request[k] for k in ('query', 'reference', 'wide'))
    if not 0 < len(reference) <= 16 or not 0 < len(wide) <= 64:
        raise ValueError('Unexpected Recall candidate budget')
    scorer = Reranker(Path(sys.argv[1]))
    try:
        old_pairs = scorer.encode(query, reference)
        wide_pairs = scorer.encode(query, wide)
    except InputLimit:
        return 12
    old = scorer.rank(old_pairs, reference)
    new = scorer.rank(wide_pairs, wide)
    print(json.dumps(allocate(old, new, scorer.count)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
