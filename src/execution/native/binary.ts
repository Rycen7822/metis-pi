import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TOOL_DIRS: Record<string, string> = {
	exec_bridge: "exec",
	view_image: "view-image",
};

export function getBundledToolBinaryPath(toolName: string, target: { platform?: NodeJS.Platform; arch?: string } = {}, customDir?: string | undefined): string | undefined {
	const toolDir = TOOL_DIRS[toolName] ?? toolName;
	const platform = target.platform ?? process.platform;
	const arch = target.arch ?? process.arch;
	const exe = platform === "win32" ? `${toolName}.exe` : toolName;
	const custom = customDir?.trim();
	if (custom) {
		const customBinary = join(custom, exe);
		if (existsSync(customBinary)) return customBinary;
	}
	const toolsDirectory = fileURLToPath(new URL("../../../assets/native-tools/", import.meta.url));
	const binary = join(toolsDirectory, toolDir, `${platform}-${arch}`, exe);
	return existsSync(binary) ? binary : undefined;
}
