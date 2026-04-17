import http from "node:http";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile, access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const HOST = process.env.MAPPA_RENDER_HOST || "127.0.0.1";
const PORT = Number(process.env.MAPPA_RENDER_PORT || "3030");
const FFMPEG_BIN = process.env.FFMPEG_PATH || "ffmpeg";
const JOB_ROOT = path.join(os.tmpdir(), "mappa-native-render");
const jobs = new Map();

const encoderPreference = [
  "h264_nvenc",
  "h264_qsv",
  "h264_amf",
  "h264_videotoolbox",
  "libx264",
];

let ffmpegInfoPromise = null;

const server = http.createServer(async (req, res) => {
  try {
    setCorsHeaders(res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || `${HOST}:${PORT}`}`);

    if (req.method === "GET" && requestUrl.pathname === "/health") {
      const info = await getFfmpegInfo();
      if (!info.available) {
        sendJson(res, 503, info);
        return;
      }
      sendJson(res, 200, info);
      return;
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/render/start") {
      const info = await getFfmpegInfo();
      if (!info.available) {
        sendJson(res, 503, info);
        return;
      }

      const body = await readJson(req);
      const jobId = randomUUID();
      const rootDir = path.join(JOB_ROOT, jobId);
      const framesDir = path.join(rootDir, "frames");

      await mkdir(framesDir, { recursive: true });

      const requestedEncoder =
        typeof body.encoder === "string" && info.encoders.includes(body.encoder)
          ? body.encoder
          : info.preferredEncoder;

      jobs.set(jobId, {
        id: jobId,
        fps: Number(body.fps),
        width: Number(body.width),
        height: Number(body.height),
        encoder: requestedEncoder,
        rootDir,
        framesDir,
        outputPath: path.join(rootDir, "output.mp4"),
      });

      sendJson(res, 200, {
        ok: true,
        jobId,
        encoder: requestedEncoder,
      });
      return;
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/render/frame") {
      const job = getJobOrThrow(requestUrl.searchParams.get("jobId"));
      const frameIndex = Number(requestUrl.searchParams.get("frame"));
      const frameFile = path.join(job.framesDir, `frame-${String(frameIndex).padStart(6, "0")}.png`);
      const frameBuffer = await readBuffer(req);

      await writeFile(frameFile, frameBuffer);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/render/finish") {
      const job = getJobOrThrow(requestUrl.searchParams.get("jobId"));
      const info = await getFfmpegInfo();

      if (!info.available) {
        sendJson(res, 503, info);
        return;
      }

      let encoderUsed = job.encoder;
      try {
        await encodeJob(job, encoderUsed);
      } catch (err) {
        if (encoderUsed !== "libx264" && info.encoders.includes("libx264")) {
          encoderUsed = "libx264";
          await encodeJob(job, encoderUsed);
        } else {
          throw err;
        }
      }

      const downloadUrl = `http://${HOST}:${PORT}/api/render/file?jobId=${encodeURIComponent(job.id)}`;
      sendJson(res, 200, {
        ok: true,
        encoder: encoderUsed,
        downloadUrl,
      });
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/render/file") {
      const job = getJobOrThrow(requestUrl.searchParams.get("jobId"));
      await access(job.outputPath);

      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Disposition": `attachment; filename="mappa-render-${job.id}.mp4"`,
      });

      const fileStream = (await import("node:fs")).createReadStream(job.outputPath);
      fileStream.pipe(res);
      return;
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/render/cleanup") {
      const job = getJobOrThrow(requestUrl.searchParams.get("jobId"));
      jobs.delete(job.id);
      await rm(job.rootDir, { recursive: true, force: true });
      sendJson(res, 200, { ok: true });
      return;
    }

    sendJson(res, 404, { ok: false, error: "Not found" });
  } catch (err) {
    sendJson(res, 500, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Mappa native render server listening on http://${HOST}:${PORT}`);
});

const setCorsHeaders = (res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
};

const sendJson = (res, statusCode, body) => {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};

const readBuffer = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

const readJson = async (req) => {
  const buffer = await readBuffer(req);
  return buffer.length === 0 ? {} : JSON.parse(buffer.toString("utf8"));
};

const getJobOrThrow = (jobId) => {
  if (!jobId) {
    throw new Error("Missing jobId.");
  }

  const job = jobs.get(jobId);
  if (!job) {
    throw new Error(`Unknown render job: ${jobId}`);
  }

  return job;
};

const getFfmpegInfo = async () => {
  if (!ffmpegInfoPromise) {
    ffmpegInfoPromise = inspectFfmpeg();
  }
  return ffmpegInfoPromise;
};

const inspectFfmpeg = async () => {
  try {
    const output = await runCommand(FFMPEG_BIN, ["-hide_banner", "-encoders"]);
    const combined = `${output.stdout}\n${output.stderr}`;
    const availableEncoders = encoderPreference.filter((encoder) =>
      combined.includes(` ${encoder} `) || combined.includes(` ${encoder}\r`) || combined.includes(` ${encoder}\n`)
    );

    return {
      ok: true,
      available: true,
      ffmpeg: FFMPEG_BIN,
      preferredEncoder: availableEncoders[0] || "libx264",
      encoders: availableEncoders,
    };
  } catch (err) {
    return {
      ok: false,
      available: false,
      ffmpeg: FFMPEG_BIN,
      error:
        err instanceof Error
          ? err.message
          : "FFmpeg was not found. Install FFmpeg and restart the render server.",
    };
  }
};

const encodeJob = async (job, encoder) => {
  const args = [
    "-y",
    "-framerate",
    String(job.fps),
    "-i",
    path.join(job.framesDir, "frame-%06d.png"),
    ...getEncoderArgs(encoder),
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    job.outputPath,
  ];

  await runCommand(FFMPEG_BIN, args);
};

const getEncoderArgs = (encoder) => {
  switch (encoder) {
    case "h264_nvenc":
      return ["-c:v", "h264_nvenc", "-preset", "p5", "-cq", "19", "-b:v", "0"];
    case "h264_qsv":
      return ["-c:v", "h264_qsv", "-global_quality", "20"];
    case "h264_amf":
      return ["-c:v", "h264_amf", "-quality", "quality"];
    case "h264_videotoolbox":
      return ["-c:v", "h264_videotoolbox", "-b:v", "20M"];
    case "libx264":
    default:
      return ["-c:v", "libx264", "-preset", "slow", "-crf", "18"];
  }
};

const runCommand = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(
        new Error(
          stderr.trim() || stdout.trim() || `${command} exited with code ${String(code)}`
        )
      );
    });
  });
