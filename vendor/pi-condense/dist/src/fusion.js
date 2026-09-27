/** Structural versioned boundary; never infer execution success from log text. */
export function captureFusionResult(result) {
    const receipt = result?.details?.metisActionFusion;
    const command = receipt?.command;
    const content = result?.content;
    if (receipt?.version !== 1 || !command || typeof command.command !== "string"
        || !Array.isArray(content) || !Number.isInteger(command.outputBlock) || command.outputBlock < 1
        || content[command.outputBlock]?.type !== "text")
        return {};
    const resultPrefix = content.slice(0, command.outputBlock).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    return {
        resultPrefix,
        fusionCommand: { command: command.command, output: content[command.outputBlock].text },
        isError: result.isError === true || receipt.mutationStatus !== "success" || command.status !== "succeeded" || command.exitCode !== 0,
        ...(typeof command.exitCode === "number" ? { exitCode: command.exitCode } : {}),
        ...(typeof command.fullOutputPath === "string" ? { outputArchive: {
                path: command.fullOutputPath,
                ...(typeof command.fullOutputBytes === "number" ? { bytes: command.fullOutputBytes } : {}),
                complete: command.fullOutputComplete !== false,
                appendOnly: command.fullOutputAppendOnly === true,
                source: "fused-command-output",
            } } : {}),
    };
}
export function captureFusionJournal(result) {
    const journal = result?.details?.fusionEvidence;
    if (!journal || typeof journal.path !== "string" || !Number.isSafeInteger(journal.offsetBytes) || journal.offsetBytes < 0
        || !Number.isSafeInteger(journal.bytes) || journal.bytes < 1)
        return {};
    return { outputArchive: { ...journal, complete: !result.details.fusionEvidenceError, source: "fusion-journal" } };
}
