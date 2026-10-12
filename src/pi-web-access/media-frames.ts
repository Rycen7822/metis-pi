import type { ExtractedContent, ExtractOptions, VideoFrame } from "./content.ts";
import { formatSeconds } from "./media-errors.ts";
import { isVideoFile, extractVideoFrame, getLocalVideoDuration } from "./video-extract.ts";
import { isYouTubeURL, getYouTubeStreamInfo, extractYouTubeFrame, extractYouTubeFrames, type StreamInfo } from "./youtube-extract.ts";

function parseTimestamp(ts: string): number | null {
	const num = Number(ts);
	if (Number.isFinite(num) && num >= 0) return Math.floor(num);
	const parts = ts.split(":").map(Number);
	if (parts.some(p => !Number.isFinite(p) || p < 0)) return null;
	if (parts.length === 3) return Math.floor(parts[0] * 3600 + parts[1] * 60 + parts[2]);
	if (parts.length === 2) return Math.floor(parts[0] * 60 + parts[1]);
	return null;
}

type TimestampSpec = { type: "single"; seconds: number } | { type: "range"; start: number; end: number };

function parseTimestampSpec(ts: string): TimestampSpec | null {
	const dashIdx = ts.indexOf("-", 1);
	if (dashIdx > 0) {
		const start = parseTimestamp(ts.slice(0, dashIdx));
		const end = parseTimestamp(ts.slice(dashIdx + 1));
		if (start !== null && end !== null && end > start) return { type: "range", start, end };
	}
	const seconds = parseTimestamp(ts);
	return seconds !== null ? { type: "single", seconds } : null;
}

const DEFAULT_RANGE_FRAMES = 6;
const MIN_FRAME_INTERVAL = 5;

function computeRangeTimestamps(start: number, end: number, maxFrames: number = DEFAULT_RANGE_FRAMES): number[] {
	if (maxFrames <= 1) return [start];
	const duration = end - start;
	const idealInterval = duration / (maxFrames - 1);
	if (idealInterval < MIN_FRAME_INTERVAL) {
		const timestamps: number[] = [];
		for (let t = start; t <= end && timestamps.length < maxFrames; t += MIN_FRAME_INTERVAL) {
			timestamps.push(t);
		}
		return timestamps;
	}
	return Array.from({ length: maxFrames }, (_, i) => Math.round(start + i * idealInterval));
}

function buildFrameResult(
	url: string, label: string, requestedCount: number,
	frames: VideoFrame[], error: string | null, duration?: number,
): ExtractedContent {
	if (frames.length === 0) {
		const msg = error ?? "Frame extraction failed";
		return { url, title: `Frames ${label} (0/${requestedCount})`, content: msg, error: msg };
	}
	return {
		url,
		title: `Frames ${label} (${frames.length}/${requestedCount})`,
		content: `${frames.length} frames extracted from ${label}`,
		error: null,
		frames,
		...(duration !== undefined ? { duration } : {}),
	};
}

async function extractLocalFrames(
	filePath: string, timestamps: number[], signal?: AbortSignal,
): Promise<{ frames: VideoFrame[]; error: string | null }> {
	const results = await Promise.all(timestamps.map(async (t) => {
		const frame = await extractVideoFrame(filePath, t, signal);
		if ("error" in frame) return { error: frame.error };
		return { ...frame, timestamp: formatSeconds(t) };
	}));
	const frames = results.filter((f): f is VideoFrame => "data" in f);
	const firstError = results.find((f): f is { error: string } => "error" in f);
	return { frames, error: frames.length === 0 && firstError ? firstError.error : null };
}

/** Own timestamp parsing, sampling and frame-result presentation for both sources. */
export async function extractMediaFrames(
	url: string,
	options: Pick<ExtractOptions, "timestamp" | "frames">,
	signal?: AbortSignal,
): Promise<ExtractedContent> {
	const failed = (error: string, title = ""): ExtractedContent => ({ url, title, content: title ? error : "", error });
	const aborted = (): ExtractedContent => failed("Aborted");
	if (signal?.aborted) return aborted();
	const spec = options.timestamp ? parseTimestampSpec(options.timestamp) : null;
	if (options.timestamp && !spec) {
		return failed(`Invalid timestamp format: "${options.timestamp}". Use "H:MM:SS", "MM:SS", "85", or "start-end".`);
	}
	let start = spec?.type === "range" ? spec.start : spec?.seconds ?? 0;
	let end = spec?.type === "range" ? spec.end : options.frames ? start + (options.frames - 1) * MIN_FRAME_INTERVAL : null;
	const multiple = !spec || spec.type === "range" || Boolean(options.frames);
	const title = multiple ? end === null || !spec ? "Frames" : `Frames ${formatSeconds(start)}-${formatSeconds(end)}` : `Frame at ${options.timestamp}`;
	const youtube = isYouTubeURL(url);
	let source: { kind: "youtube"; videoId: string; stream: StreamInfo } | { kind: "local"; path: string };
	let duration: number | undefined;
	try {
		if (youtube.isYouTube && youtube.videoId) {
			const streamInfo = await getYouTubeStreamInfo(youtube.videoId, signal);
			if (signal?.aborted) return aborted();
			if ("error" in streamInfo) return failed(streamInfo.error, title);
			source = { kind: "youtube", videoId: youtube.videoId, stream: streamInfo };
			duration = streamInfo.duration ?? undefined;
		} else {
			const local = isVideoFile(url);
			if (!local) return failed(`${options.timestamp ? "Timestamp" : "Frame"} extraction only works with YouTube and local video files`);
			source = { kind: "local", path: local.absolutePath };
			if (!spec) {
				const result = await getLocalVideoDuration(source.path, signal);
				if (signal?.aborted) return aborted();
				if (typeof result !== "number") return failed(result.error, title);
				duration = result;
			}
		}
	} catch (err) {
		return signal?.aborted ? aborted() : failed(err instanceof Error ? err.message : String(err));
	}
	if (!spec) {
		if (duration === undefined) return failed("Cannot determine video duration. Use a timestamp range instead.", title);
		start = 0;
		end = Math.floor(duration);
	}
	// YouTube exposes duration with its stream. Local explicit timestamps do
	// not require ffprobe; keep that source-specific capability intact.
	const lastTimestamp = end ?? start;
	if (duration !== undefined && lastTimestamp > duration) {
		return failed(`Timestamp ${formatSeconds(lastTimestamp)} exceeds video duration (${formatSeconds(Math.floor(duration))})`, title);
	}
	if (!multiple) {
		const frame = source.kind === "youtube"
			? await extractYouTubeFrame(source.videoId, start, source.stream, signal)
			: await extractVideoFrame(source.path, start, signal);
		if (signal?.aborted) return aborted();
		if ("error" in frame) return failed(frame.error, title);
		return { url, title, content: `Video frame at ${options.timestamp}`, error: null, thumbnail: frame };
	}
	const rangeEnd = end ?? start;
	const timestamps = computeRangeTimestamps(start, rangeEnd, options.frames ?? DEFAULT_RANGE_FRAMES);
	const result = source.kind === "youtube"
		? await extractYouTubeFrames(source.videoId, timestamps, source.stream, signal)
		: await extractLocalFrames(source.path, timestamps, signal);
	if (signal?.aborted) return aborted();
	const label = `${formatSeconds(start)}-${formatSeconds(rangeEnd)}`;
	return buildFrameResult(url, label, timestamps.length, result.frames, result.error, duration);
}
