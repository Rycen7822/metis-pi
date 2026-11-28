import { createHash } from "node:crypto";
import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import baseline from "./approved-comments.json" with { type: "json" };

const root = fileURLToPath(new URL("../../", import.meta.url));
const digest = value => createHash("sha256").update(value.replaceAll("\r\n", "\n").trim()).digest("hex");

export default {
  meta: { name: "approved-comments" },
  rules: {
    ratchet: {
      meta: { type: "suggestion", schema: [] },
      create(context) {
        return {
          Program(node) {
            const path = relative(root, context.physicalFilename).split(sep).join("/");
            const approved = [...(baseline[path] ?? [])];
            for (const comment of context.sourceCode.getAllComments()) {
              if (comment.type === "Shebang") continue;
              const hash = digest(comment.value);
              const index = approved.indexOf(hash);
              if (index >= 0) approved.splice(index, 1);
              else context.report({ loc: comment.loc, message: `Unapproved comment (${hash}). Remove it or review it for the keep list.` });
            }
            for (const hash of approved) {
              context.report({ node, message: `Remove unused approval ${hash} from approved-comments.json.` });
            }
          },
        };
      },
    },
  },
};
