
import { buildDiffRows } from "./src/write-tracker.ts";
console.log("A:", JSON.stringify(buildDiffRows("one\ntwo\n", "one\ntwo\nthree\n")?.rows));
console.log("B:", JSON.stringify(buildDiffRows("", "first\n")?.rows));
console.log("C:", JSON.stringify(buildDiffRows("x\n", "")?.rows));
