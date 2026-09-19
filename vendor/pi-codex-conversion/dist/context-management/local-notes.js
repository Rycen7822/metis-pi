const CONTEXT_NOTE_ENTRY_TYPE = "codex-context-note";
export const CONTEXT_NOTE_SNAPSHOT_ENTRY_TYPE = "codex-context-note-snapshot";
const NOTE_PROTOCOL = 1;
const CURRENT_NOTES_ROOT = "/root/notes";
const MAX_FILE_BYTES = 1_000_000;
const MAX_SNAPSHOT_BYTES = 10_000_000;
const MAX_LIST_RESULTS = 100;
const MAX_SEARCH_FILES = 100;
const MAX_MATCHES_PER_FILE = 100;
const THREAD_HINT_NOTE_LIMIT = 5;
export function usePiSessionNotes(pi, action, params, ctx) {
    const notes = collectNotes(ctx.sessionManager.getBranch());
    if (action === "list_files_by_prefix")
        return listNotes(notes, params);
    if (action === "read_file")
        return readNote(notes, params);
    if (action === "search_contents")
        return searchNotes(notes, params);
    return writeNote(pi, notes, action, params);
}
export function createPiSessionNotesSnapshot(entries, path) {
    const files = [...collectNotes(entries).values()]
        .filter((note) => path === undefined || note.path === path)
        .sort((left, right) => left.path.localeCompare(right.path))
        .map((note) => ({
        path: note.path,
        text: note.text,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
    }));
    const snapshot = {
        protocol: NOTE_PROTOCOL,
        timestamp: Date.now(),
        files,
    };
    if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > MAX_SNAPSHOT_BYTES)
        throw new Error("Context note snapshot exceeds the 10,000,000-byte limit");
    return snapshot;
}
export function renderPiSessionNotesThreadHint(entries, maxBytes) {
    const header = "Recent notes (up to 5, most-recent first):";
    const lines = [];
    const notes = [...collectNotes(entries).values()].sort((left, right) => right.updatedAt - left.updatedAt || left.path.localeCompare(right.path));
    for (const note of notes) {
        if (lines.length >= THREAD_HINT_NOTE_LIMIT)
            break;
        const lineCount = note.text === "" ? 0 : note.text.split("\n").length;
        const line = `- ${note.path} (${lineCount} ${lineCount === 1 ? "line" : "lines"}, ${Buffer.byteLength(note.text, "utf8")} UTF-8 bytes)`;
        const candidate = [header, ...lines, line].join("\n");
        if (Buffer.byteLength(candidate, "utf8") <= maxBytes)
            lines.push(line);
    }
    return lines.length > 0 ? [header, ...lines].join("\n") : undefined;
}
function collectNotes(entries) {
    const notes = new Map();
    for (const entry of entries) {
        // A managed jump carries only its handoff, never replacing destination notes.
        if (entry.type === "branch_summary" && entry.details && typeof entry.details === "object" &&
            "codexContextNoteHandoff" in entry.details && isNoteSnapshotData(entry.details.codexContextNoteHandoff)) {
            for (const file of entry.details.codexContextNoteHandoff.files)
                notes.set(file.path, { ...file });
            continue;
        }
        if (entry.type === "custom" &&
            entry.customType === CONTEXT_NOTE_SNAPSHOT_ENTRY_TYPE &&
            isNoteSnapshotData(entry.data)) {
            notes.clear();
            for (const file of entry.data.files)
                notes.set(file.path, { ...file });
            continue;
        }
        if (entry.type !== "custom" ||
            entry.customType !== CONTEXT_NOTE_ENTRY_TYPE ||
            !isNoteEntryData(entry.data))
            continue;
        const previous = notes.get(entry.data.path);
        const text = entry.data.action === "append"
            ? (previous?.text ?? "") + entry.data.text
            : entry.data.text;
        notes.set(entry.data.path, {
            path: entry.data.path,
            text,
            createdAt: previous?.createdAt ?? entry.data.timestamp,
            updatedAt: entry.data.timestamp,
        });
    }
    return notes;
}
function listNotes(notes, params) {
    const prefix = normalizePrefix(params["prefix"]);
    const orderBy = params["file_order_by"] === "created_at" ||
        params["file_order_by"] === "updated_at"
        ? params["file_order_by"]
        : "name";
    const direction = params["file_order"] === "descending" ? -1 : 1;
    const files = [...notes.values()]
        .filter((note) => note.path.startsWith(prefix))
        .sort((left, right) => {
        const compared = orderBy === "name"
            ? left.path.localeCompare(right.path)
            : orderBy === "created_at"
                ? left.createdAt - right.createdAt
                : left.updatedAt - right.updatedAt;
        return compared * direction;
    })
        .slice(0, boundedInteger(params["max_results"], 20, MAX_LIST_RESULTS))
        .map(noteMetadata);
    return { source: "pi-session", files };
}
function readNote(notes, params) {
    const path = normalizeFilePath(params["path"]);
    const note = notes.get(path);
    if (!note)
        return { source: "pi-session", file: null };
    const lines = note.text.split("\n");
    const start = lineIndex(params["start_line"], lines.length, 0);
    const stop = lineIndex(params["stop_line"], lines.length, lines.length - 1);
    return {
        source: "pi-session",
        file: {
            ...noteMetadata(note),
            content: start <= stop ? lines.slice(start, stop + 1).join("\n") : "",
            start_line: start + 1,
            stop_line: Math.max(start, stop) + 1,
            total_lines: lines.length,
        },
    };
}
function searchNotes(notes, params) {
    const query = requiredString(params["query"], "notes search_contents requires query");
    const prefix = normalizePrefix(params["path_prefix"]);
    const fileLimit = boundedInteger(params["max_files"], 20, MAX_SEARCH_FILES);
    const matchLimit = boundedInteger(params["max_matches_per_file"], 20, MAX_MATCHES_PER_FILE);
    let candidates = [...notes.values()].filter((note) => note.path.startsWith(prefix));
    if (params["recent_file_first"] === true)
        candidates.sort((left, right) => right.createdAt - left.createdAt);
    else
        candidates.sort((left, right) => left.path.localeCompare(right.path));
    const files = [];
    for (const note of candidates) {
        const matches = note.text
            .split("\n")
            .map((line, index) => ({ line_number: index + 1, line }))
            .filter(({ line }) => line.includes(query))
            .slice(0, matchLimit);
        if (matches.length === 0)
            continue;
        files.push({ path: note.path, matches });
        if (files.length >= fileLimit)
            break;
    }
    return { source: "pi-session", files };
}
function writeNote(pi, notes, action, params) {
    const path = normalizeFilePath(params["path"]);
    const text = requiredString(params["text"], `notes ${action} requires text`, true);
    const previous = notes.get(path);
    const nextText = action === "append_to_file"
        ? (previous?.text ?? "") + text
        : text;
    const bytes = Buffer.byteLength(nextText, "utf8");
    if (bytes > MAX_FILE_BYTES)
        throw new Error("Note file exceeds the 1,000,000-byte limit");
    const timestamp = Date.now();
    pi.appendEntry(CONTEXT_NOTE_ENTRY_TYPE, {
        protocol: NOTE_PROTOCOL,
        action: action === "append_to_file" ? "append" : "write",
        path,
        text,
        timestamp,
    });
    return {
        source: "pi-session",
        file: noteMetadata({
            path,
            text: nextText,
            createdAt: previous?.createdAt ?? timestamp,
            updatedAt: timestamp,
        }),
    };
}
function normalizeFilePath(value) {
    const input = requiredString(value, "Note file path is required");
    const path = input.startsWith("/") ? input : `${CURRENT_NOTES_ROOT}/${input}`;
    const components = path.slice(1).split("/");
    if (components.some((component) => !component || component === "." || component === ".."))
        throw new Error("Note paths cannot contain empty, . or .. components");
    const notesIndex = components.indexOf("notes");
    if (notesIndex <= 0 || notesIndex === components.length - 1)
        throw new Error("Absolute note paths must use <agent>/notes/<path>");
    return `/${components.join("/")}`;
}
function normalizePrefix(value) {
    if (value === undefined || value === null || value === "")
        return `${CURRENT_NOTES_ROOT}/`;
    if (typeof value !== "string")
        throw new Error("Note prefix must be a string");
    const path = value.startsWith("/") ? value : `${CURRENT_NOTES_ROOT}/${value}`;
    const components = path.slice(1).split("/");
    if (components.some((component) => !component || component === "." || component === ".."))
        throw new Error("Note prefixes cannot contain empty, . or .. components");
    const notesIndex = components.indexOf("notes");
    if (notesIndex <= 0)
        throw new Error("Absolute note prefixes must use <agent>/notes[/path]");
    if (notesIndex === components.length - 1)
        return `${path}/`;
    return `/${components.join("/")}`;
}
function noteMetadata(note) {
    return {
        path: note.path,
        bytes: Buffer.byteLength(note.text, "utf8"),
        created_at: new Date(note.createdAt).toISOString(),
        updated_at: new Date(note.updatedAt).toISOString(),
    };
}
function lineIndex(value, lineCount, fallback) {
    if (typeof value !== "number" || !Number.isInteger(value) || value === 0)
        return fallback;
    const index = value > 0 ? value - 1 : lineCount + value;
    return Math.max(0, Math.min(index, Math.max(0, lineCount - 1)));
}
function boundedInteger(value, fallback, maximum) {
    return typeof value === "number" && Number.isInteger(value)
        ? Math.max(1, Math.min(value, maximum))
        : fallback;
}
function requiredString(value, message, allowEmpty = false) {
    if (typeof value !== "string" || (!allowEmpty && value === ""))
        throw new Error(message);
    return value;
}
function isNoteEntryData(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const entry = value;
    return entry["protocol"] === NOTE_PROTOCOL &&
        (entry["action"] === "append" || entry["action"] === "write") &&
        typeof entry["path"] === "string" &&
        typeof entry["text"] === "string" &&
        typeof entry["timestamp"] === "number";
}
function isNoteSnapshotData(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const snapshot = value;
    return snapshot["protocol"] === NOTE_PROTOCOL &&
        typeof snapshot["timestamp"] === "number" &&
        Array.isArray(snapshot["files"]) &&
        snapshot["files"].every((file) => {
            if (!file || typeof file !== "object" || Array.isArray(file))
                return false;
            const record = file;
            return typeof record["path"] === "string" &&
                typeof record["text"] === "string" &&
                Buffer.byteLength(record["text"], "utf8") <= MAX_FILE_BYTES &&
                typeof record["createdAt"] === "number" &&
                typeof record["updatedAt"] === "number";
        });
}
