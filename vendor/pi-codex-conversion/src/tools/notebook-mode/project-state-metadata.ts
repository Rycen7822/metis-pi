import { join, resolve } from "node:path";
import {
	type ProjectStateEntry,
	projectStatePaths,
	hasPayloadLayout,
	readProjectStateManifest,
} from "./project-state-format.ts";

export interface RetainedProjectBinding {
	name: string;
	kind: ProjectStateEntry["kind"];
	bytes: number;
	updatedAt: string;
	pinned: boolean;
	description?: string | undefined;
	usage?: string | undefined;
}

export function readRetainedProjectBindings(
	identity: {
		project: string;
		agentDir: string;
	},
	maxBytes: number,
): RetainedProjectBinding[] {
	const paths = projectStatePaths(identity.project, identity.agentDir);
	const manifest = readProjectStateManifest(paths.manifest);
	if (!manifest || manifest.project !== resolve(identity.project)) return [];
	if (!hasPayloadLayout(manifest.entries, join(paths.directory, manifest.payload), maxBytes)) return [];
	return manifest.entries.map((entry) => ({
		name: entry.name,
		kind: entry.kind,
		bytes: entry.length,
		updatedAt: entry.updatedAt ?? manifest.createdAt,
		pinned: entry.pinned === true,
		...(entry.description === undefined ? {} : { description: entry.description }),
		...(entry.usage === undefined ? {} : { usage: entry.usage }),
	}));
}
