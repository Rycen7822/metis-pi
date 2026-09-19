import { summarizeDiscoveryCommand } from "./command-discovery.js";
import { isPythonCommand, pythonWalksFiles } from "./command-operands.js";
import { summarizeReadCommand } from "./command-read.js";
import { pathlessListCommand, unknownCommand, } from "./parsed-command.js";
export { isSmallFormattingCommand } from "./formatting-command.js";
export function summarizeMainTokens(mainCommand) {
    const [head, ...tail] = mainCommand;
    if (!head)
        return unknownCommand(mainCommand);
    const discovery = summarizeDiscoveryCommand(head, tail, mainCommand);
    if (discovery)
        return discovery;
    const read = summarizeReadCommand(head, tail, mainCommand);
    if (read)
        return read;
    if (isPythonCommand(head)) {
        return pythonWalksFiles(tail)
            ? pathlessListCommand(mainCommand)
            : unknownCommand(mainCommand);
    }
    return unknownCommand(mainCommand);
}
