import fs from "node:fs";

export function trackExecSpools(t) {
	const directories = [];
	const mkdtemp = fs.mkdtempSync;
	t.mock.method(fs, "mkdtempSync", (...args) => {
		const directory = mkdtemp(...args);
		if (String(args[0]).includes("pi-exec-output-")) directories.push(directory);
		return directory;
	});
	return directories;
}
