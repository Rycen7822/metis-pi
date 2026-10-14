import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { editWithExternalEditor } from "./external-editor.ts";

let fixtureDir: string;
let stdout: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	fixtureDir = mkdtempSync(join(tmpdir(), "rpiv-external-editor-test-"));
	stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
	stdout.mockRestore();
	rmSync(fixtureDir, { recursive: true, force: true });
});

describe("editWithExternalEditor", () => {
	it("cancels an active editor before restoring the TUI and removes its temporary answer", async () => {
		const editor = join(fixtureDir, "waiting-editor.mjs");
		const ready = join(fixtureDir, "ready.json");
		writeFileSync(editor, 'import { writeFileSync } from "node:fs";'
			+ 'process.on("SIGTERM", () => {});'
			+ 'writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid, file: process.argv[3] }));'
			+ 'setInterval(() => {}, 100);');
		const controller = new AbortController();
		const tui = { stop: vi.fn(), start: vi.fn(), requestRender: vi.fn() };
		const pending = editWithExternalEditor(tui, `${process.execPath} ${editor} ${ready}`, "draft", controller.signal);
		void pending.catch(() => {});
		let pid: number | undefined;
		try {
			await vi.waitFor(() => expect(existsSync(ready)).toBe(true));
			const child = JSON.parse(readFileSync(ready, "utf8")) as { pid: number; file: string };
			pid = child.pid;
			controller.abort(new Error("editor cancelled"));
			await vi.waitFor(() => expect(tui.start).toHaveBeenCalledOnce(), { timeout: 2500 });
			await expect(pending).rejects.toThrow("editor cancelled");
			expect(() => process.kill(child.pid, 0)).toThrow();
			expect(existsSync(child.file)).toBe(false);
			expect(tui.requestRender).toHaveBeenCalledWith(true);
		} finally {
			if (pid !== undefined) { try { process.kill(pid, "SIGKILL"); } catch {} }
			await pending.catch(() => {});
		}
	}, 10000);

	it("round-trips the temp file and restores the TUI after the editor exits", async () => {
		const editor = join(fixtureDir, "editor.mjs");
		writeFileSync(
			editor,
			'import { writeFileSync } from "node:fs"; writeFileSync(process.argv[2], "edited answer\\n");',
		);
		const tui = { stop: vi.fn(), start: vi.fn(), requestRender: vi.fn() };

		const result = await editWithExternalEditor(tui, `${process.execPath} ${editor}`, "draft");

		expect(result).toBe("edited answer");
		expect(tui.stop).toHaveBeenCalledOnce();
		expect(tui.start).toHaveBeenCalledOnce();
		expect(tui.requestRender).toHaveBeenCalledWith(true);
	});

	it("restores the TUI and rejects when the editor exits unsuccessfully", async () => {
		const editor = join(fixtureDir, "failing-editor.mjs");
		writeFileSync(editor, "process.exit(7);");
		const tui = { stop: vi.fn(), start: vi.fn(), requestRender: vi.fn() };

		await expect(editWithExternalEditor(tui, `${process.execPath} ${editor}`, "draft")).rejects.toThrow(
			"exit code 7",
		);
		expect(tui.start).toHaveBeenCalledOnce();
		expect(tui.requestRender).toHaveBeenCalledWith(true);
	});
});
