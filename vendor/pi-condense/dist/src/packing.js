// Restrict lossy packing to recognizable successful build/test output. Reads,
// searches, arbitrary shell programs and failed tools retain the existing path.
function isBuildOutput(call) {
    if (call.isError || !["bash", "exec_command"].includes(call.toolName))
        return false;
    if (call.toolName === "exec_command" && call.exitCode !== 0)
        return false;
    const command = call.args.command ?? call.args.cmd;
    if (typeof command !== "string" || /[;|&\n]/.test(command))
        return false;
    return /^(?:rtk\s+)?(?:npm\s+(?:test|run\s+(?:test|build|check|lint|typecheck))|(?:pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|check|lint|typecheck)|cargo\s+(?:test|build|check|clippy)|(?:python3?\s+-m\s+)?pytest|(?:go\s+(?:test|build)))(?:\s|$)/.test(command.trim());
}
export function packToolResult(call) {
    if (call.fusionCommand) {
        const { fusionCommand, ...rest } = call;
        const packed = packToolResult({ ...rest, toolName: "exec_command", args: { cmd: fusionCommand.command }, resultText: fusionCommand.output });
        return packed === undefined ? undefined : `${call.resultPrefix ?? ""}\n${packed}`;
    }
    if (!isBuildOutput(call) || call.resultText.length < 2000)
        return undefined;
    const lines = call.resultText.split("\n");
    if (lines.length < 24)
        return undefined;
    const keep = new Set();
    for (let i = 0; i < Math.min(8, lines.length); i++)
        keep.add(i);
    for (let i = Math.max(0, lines.length - 12); i < lines.length; i++)
        keep.add(i);
    for (let i = 0; i < lines.length; i++) {
        if (/\b(error|fail(?:ed|ure|ures)?|warning|panic|exception|traceback|assert(?:ion)?|skipped|passed)\b/i.test(lines[i])) {
            for (let j = Math.max(0, i - 1); j <= Math.min(lines.length - 1, i + 1); j++)
                keep.add(j);
        }
    }
    const output = ["[Successful build/test output; selected original lines. Full captured output is archived.]"];
    let previous = -1;
    for (const i of [...keep].sort((a, b) => a - b)) {
        if (i > previous + 1)
            output.push(`[${i - previous - 1} lines omitted; recover through context_tree_query]`);
        output.push(lines[i]);
        previous = i;
    }
    const packed = output.join("\n");
    return packed.length < call.resultText.length ? packed : undefined;
}
/** Preparation is pure: no index/frontier changes before the model decision. */
export function prepareBatch(batch) {
    const packed = [];
    const originals = [];
    const candidate = {
        ...batch,
        toolCalls: batch.toolCalls.map((call) => {
            const text = packToolResult(call);
            if (text === undefined)
                return call;
            originals.push(call);
            const reduced = { ...call, resultText: text };
            packed.push(reduced);
            return reduced;
        }),
    };
    return {
        candidate,
        candidateChars: candidate.toolCalls.reduce((total, call) => total + call.resultText.length, 0),
        packedBatch: { ...batch, toolCalls: originals },
        packedText: packed.map((call, i) => `[[${i + 1}:${call.toolName}]]\n${call.resultText}`).join("\n\n"),
    };
}
