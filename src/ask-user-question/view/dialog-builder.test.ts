import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import { makeTheme } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it } from "vitest";

const theme = makeTheme() as unknown as Theme;

describe("DialogView — topFixed / bottomFixed magic-constant invariants", () => {
	it("DynamicBorder renders exactly 1 row (topFixed assumes 1)", () => {
		const border = new DynamicBorder((s) => theme.fg("accent", s));
		expect(border.render(80).length).toBe(1);
	});

});
