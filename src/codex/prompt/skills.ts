export function hasNoSkillsFlag(argv: readonly string[] = process.argv): boolean {
	for (const arg of argv) {
		if (arg === "--") return false;
		if (arg === "--no-skills" || arg === "-ns") return true;
	}
	return false;
}
