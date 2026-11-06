# /// script
# requires-python = ">=3.12"
# dependencies = ["onnx==1.18.0", "onnxruntime==1.23.2"]
# ///
"""Maintainer-only migration of the approved LateOn graph; users receive prepared assets through Pi updates."""
import argparse
import ctypes as C
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import stat
import sys

import onnx
from onnx import TensorProto, helper


class Options(C.Structure):
    _fields_ = [("abi", C.c_uint32), ("manifest", C.c_char_p), ("threads", C.c_uint32),
                ("cap", C.c_uint64), ("strict", C.c_uint32)]


def text(value):
    return value.decode() if value else ""


def recover(path):
    # Import only the generated schema, not the wheel's different native execution engine.
    package = importlib.util.find_spec("onnxruntime")
    if package is None or not package.submodule_search_locations:
        raise ImportError("the pinned maintainer onnxruntime schema package is missing")
    schema = Path(next(iter(package.submodule_search_locations))) / "tools/ort_format_model"
    sys.path.insert(0, str(schema))
    from ort_flatbuffers_py.fbs.InferenceSession import InferenceSession
    from ort_flatbuffers_py.fbs.TensorTypeAndShape import TensorTypeAndShape

    session = InferenceSession.GetRootAs(path.read_bytes(), 0)
    model = session.Model()
    graph = model.Graph()
    values = []
    for index in range(graph.NodeArgsLength()):
        argument = graph.NodeArgs(index)
        kind = argument.Type()
        # FlatBuffers TypeInfo union tag 1 is TensorTypeAndShape.
        if kind.ValueType() != 1:
            raise ValueError("source graph contains a non-tensor argument")
        table = kind.Value()
        tensor = TensorTypeAndShape()
        tensor.Init(table.Bytes, table.Pos)
        dimensions = None if tensor.Shape() is None else []
        if dimensions is not None:
            for offset in range(tensor.Shape().DimLength()):
                dimension = tensor.Shape().Dim(offset).Value()
                # Dimension tag 1 stores a fixed value; other dimensions are symbolic.
                dimensions.append(dimension.DimValue() if dimension.DimType() == 1 else text(dimension.DimParam()) or None)
        values.append(helper.make_tensor_value_info(text(argument.Name()), tensor.ElemType(), dimensions))
    initializers = []
    for index in range(graph.InitializersLength()):
        tensor = graph.Initializers(index)
        if tensor.ExternalDataOffset() != -1 or tensor.RawDataLength() == 0:
            raise ValueError("source graph initializer must have inline data")
        value = TensorProto(name=text(tensor.Name()), data_type=tensor.DataType())
        value.dims.extend(tensor.Dims(index) for index in range(tensor.DimsLength()))
        value.raw_data = tensor.RawDataAsNumpy().tobytes()
        initializers.append(value)
    nodes = []
    for index in range(graph.NodesLength()):
        node = graph.Nodes(index)
        attributes = {}
        for offset in range(node.AttributesLength()):
            attribute = node.Attributes(offset)
            if attribute.Type() != 2:  # The fixed approved model has integer attributes only.
                raise ValueError("unsupported attribute in source LateOn graph")
            attributes[text(attribute.Name())] = int(attribute.I())
        nodes.append(helper.make_node(text(node.OpType()), [text(node.Inputs(i)) for i in range(node.InputsLength())],
                                      [text(node.Outputs(i)) for i in range(node.OutputsLength())],
                                      name=text(node.Name()), domain=text(node.Domain()), **attributes))
    by_name = {value.name: value for value in values}
    recovered = helper.make_graph(nodes, "LateOnSegmented", [by_name[text(graph.Inputs(i))]
                                  for i in range(graph.InputsLength())], [by_name[text(graph.Outputs(i))]
                                  for i in range(graph.OutputsLength())], initializers)
    io = {value.name for value in recovered.input} | {value.name for value in recovered.output}
    recovered.value_info.extend(value for value in values if value.name not in io)
    imports = [helper.make_opsetid(text(model.OpsetImport(i).Domain()), model.OpsetImport(i).Version())
               for i in range(model.OpsetImportLength())]
    return helper.make_model(recovered, opset_imports=imports, producer_name="metis-segmented", ir_version=model.IrVersion())


def segment(model):
    counts = dict(rope=0, local=0, global_attention=0)
    for node in model.graph.node:
        if node.op_type in ("SgrepRopePackF32", "SgrepLocalAttentionF32"):
            node.input.append("sequence_offsets")
            counts["rope" if node.op_type == "SgrepRopePackF32" else "local"] += 1
        elif node.op_type == "MultiHeadAttention":
            attributes = {attribute.name: helper.get_attribute_value(attribute) for attribute in node.attribute}
            if attributes != dict(num_heads=4, unidirectional=0):
                raise ValueError("unsupported source attention contract")
            node.domain = "com.metis.sgrep"
            node.op_type = "SgrepSegmentedGlobalAttentionF32"
            node.input.append("sequence_offsets")
            del node.attribute[:]
            counts["global_attention"] += 1
    # The approved seven-layer checkpoint has 4 local/3 global layers and 46 weight tensors.
    if counts != dict(rope=7, local=4, global_attention=3) or len(model.graph.initializer) != 46:
        raise ValueError("unexpected source LateOn architecture")
    model.graph.input.append(helper.make_tensor_value_info("sequence_offsets", TensorProto.INT64, ["boundaries"]))
    onnx.checker.check_model(model)


def convert(library, output):
    native = C.CDLL(str(library.resolve()))
    native.sgrep_runtime_create.argtypes = [C.POINTER(Options), C.POINTER(C.c_void_p)]
    native.sgrep_runtime_save_optimized.argtypes = [C.c_void_p, C.c_char_p]
    native.sgrep_runtime_destroy.argtypes = [C.c_void_p]
    native.sgrep_runtime_create.restype = native.sgrep_runtime_save_optimized.restype = C.c_int
    handle = C.c_void_p()
    # Match the public ABI and ordinary four-thread, 128MiB strict runtime contract.
    options = Options(abi=3, manifest=str(output / "manifest.json").encode(), threads=4, cap=128 << 20, strict=1)
    status = native.sgrep_runtime_create(C.byref(options), C.byref(handle))
    if status:
        raise RuntimeError(f"native ABI3 graph creation failed: status {status}")
    try:
        status = native.sgrep_runtime_save_optimized(handle, str(output / "backbone.ort").encode())
        if status:
            raise RuntimeError(f"native graph conversion failed: status {status}")
    finally:
        native.sgrep_runtime_destroy(handle)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True, help="approved format-3 prepared LateOn directory")
    parser.add_argument("--output", type=Path, required=True, help="new prepared model directory, must not exist")
    parser.add_argument("--library", type=Path, required=True, help="newly built native ABI3 library")
    args = parser.parse_args()
    manifest = json.loads((args.source / "manifest.json").read_text())
    if manifest["format_version"] != 3 or manifest["arithmetic_revision"] != "ort-1.31-erf-v1":
        raise ValueError("source must be the approved non-segmented FP16-preLN/FP32 model; reuse format-4 assets directly")
    model = recover(args.source / "backbone.ort")
    segment(model)
    args.output.mkdir(parents=True, exist_ok=False)
    for name in ("embedding_preln_f16.pack", "tokenizer.json"):
        source = args.source / name
        if not stat.S_ISREG(source.lstat().st_mode):
            raise ValueError(f"source asset is not a physical file: {source}")
        shutil.copyfile(source, args.output / name)
    onnx.save_model(model, args.output / "backbone.onnx")
    manifest.update(format_version=4, sequence_layout="segmented-v1", graph_format="onnx", graph_file="backbone.onnx")
    # Approval belongs to the release catalog, not stale preparation flags or a second graph digest.
    for field in ("graph_sha256", "release_ready", "candidate_validation"):
        manifest.pop(field, None)
    target = args.output / "manifest.json"
    target.write_text(json.dumps(manifest, indent=2) + "\n")
    convert(args.library, args.output)
    manifest.update(graph_format="ort", graph_file="backbone.ort")
    target.write_text(json.dumps(manifest, indent=2) + "\n")
    (args.output / "backbone.onnx").unlink()
    # Required asset-catalog identities, computed once at preparation, not on queries.
    files = {}
    for name in ("manifest.json", "backbone.ort", "embedding_preln_f16.pack", "tokenizer.json"):
        path = args.output / name
        with path.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        files[name] = dict(bytes=path.stat().st_size, sha256=digest)
    print(json.dumps(dict(revision=manifest["revision"], directory=str(args.output.resolve()), files=files), indent=2))


if __name__ == "__main__":
    main()
