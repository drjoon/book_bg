import { runAutoBooking, getBookingOpenTime } from "./debeach_auto.js";
import fs from "fs/promises";
import path from "path";
import moment from "moment-timezone";
import { fileURLToPath } from "url";
import { Booking } from "../web/backend/models.js";
import connectDB from "../web/backend/db.js";
import mongoose from "mongoose";

// --- Console Log Timestamp Monkey-Patch ---
const originalConsole = {
  log: console.log,
  error: console.error,
  warn: console.warn,
};

const getTimestamp = () => moment().tz("Asia/Seoul").format("HH:mm:ss.SSS");

console.log = (...args) => {
  originalConsole.log(`[${getTimestamp()}]`, ...args);
};

console.error = (...args) => {
  originalConsole.error(`[${getTimestamp()}]`, ...args);
};

console.warn = (...args) => {
  originalConsole.warn(`[${getTimestamp()}]`, ...args);
};
// --- End of Monkey-Patch ---

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const queuePath = path.resolve(__dirname, "./queue.json");
let processing = false;
let lastEmptyRebuildAtMs = 0;
const EMPTY_REBUILD_BACKOFF_MS = 30_000; // 큐 비었을 때 rebuild 간격 (30초)

function isTerminalStatus(status) {
  if (!status) return false;
  return (
    status === "성공" ||
    status === "실패" ||
    status === "취소" ||
    status === "cancel" ||
    status === "canceled" ||
    status === "cancelled"
  );
}

async function rebuildQueueFromDb() {
  try {
    // Ensure MongoDB is connected
    if (mongoose.connection.readyState !== 1) {
      console.warn("[WORKER] MongoDB not connected, skipping DB rebuild");
      return null;
    }

    const todayDigits = moment().tz("Asia/Seoul").format("YYYYMMDD");

    const normalizeDateDigits = (value) => {
      if (!value) return "";
      const digits = String(value).replace(/\D/g, "");
      return digits.length >= 8 ? digits.slice(0, 8) : digits;
    };

    const bookings = await Booking.find({
      status: {
        $nin: ["성공", "실패", "취소", "cancel", "canceled", "cancelled"],
      },
    })
      .select("account date startTime endTime status")
      .lean();

    const jobs = bookings
      .map((b) => ({
        account: b.account,
        date: b.date,
        startTime: b.startTime,
        endTime: b.endTime,
      }))
      .filter((j) => {
        if (!j.account || !j.date || !j.startTime || !j.endTime) return false;
        const d = normalizeDateDigits(j.date);
        if (d.length !== 8) return false;
        return d >= todayDigits;
      });

    if (jobs.length > 0) {
      await saveQueue(jobs);
      console.log(`[WORKER] Rebuilt queue from DB. jobs=${jobs.length}`);
    }
    return jobs;
  } catch (e) {
    console.error("[WORKER] Failed to rebuild queue from DB:", e.message);
    return null;
  }
}

async function pruneQueueByDb(queue) {
  if (!Array.isArray(queue) || queue.length === 0) return [];

  // Ensure MongoDB is connected
  if (mongoose.connection.readyState !== 1) {
    console.warn("[WORKER] MongoDB not connected, skipping queue prune");
    return queue;
  }

  const pairs = queue
    .map((job) => ({
      account: job.account ?? job.NAME,
      date: job.date ?? job.TARGET_DATE,
    }))
    .filter((p) => p.account && p.date);

  if (pairs.length === 0) return [];

  const uniquePairs = [];
  const seen = new Set();
  for (const p of pairs) {
    const key = `${p.account}::${p.date}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniquePairs.push(p);
  }

  let bookings = [];
  try {
    bookings = await Booking.find({
      $or: uniquePairs.map((p) => ({ account: p.account, date: p.date })),
    }).select("account date status");
  } catch (e) {
    console.error(
      "[WORKER] Failed to read bookings for queue prune:",
      e.message,
    );
    return queue;
  }

  const map = new Map(bookings.map((b) => [`${b.account}::${b.date}`, b]));

  return queue.filter((job) => {
    const account = job.account ?? job.NAME;
    const date = job.date ?? job.TARGET_DATE;
    const booking = map.get(`${account}::${date}`);
    if (!booking) return false;
    return !isTerminalStatus(booking.status);
  });
}

async function loadQueue() {
  try {
    return JSON.parse(await fs.readFile(queuePath, "utf-8"));
  } catch (e) {
    return [];
  }
}

async function saveQueue(queue) {
  await fs.writeFile(queuePath, JSON.stringify(queue, null, 2));
}

function isBookingTimeNear(job) {
  // 예약 오픈 2분 전 ~ 2분 후까지 실행 허용 (기존 90초에서 2분으로 확대)
  const now = moment().tz("Asia/Seoul");
  const date = job.date ?? job.TARGET_DATE;
  const openTime = getBookingOpenTime(date);
  return (
    now.isAfter(openTime.clone().subtract(2, "minutes")) &&
    now.isBefore(openTime.clone().add(2, "minute"))
  );
}

async function processQueue() {
  if (processing) return;
  processing = true;
  try {
    let queue = await loadQueue();
    if (!Array.isArray(queue) || queue.length === 0) {
      const nowMs = Date.now();
      if (nowMs - lastEmptyRebuildAtMs >= EMPTY_REBUILD_BACKOFF_MS) {
        lastEmptyRebuildAtMs = nowMs;
        const rebuilt = await rebuildQueueFromDb();
        if (Array.isArray(rebuilt) && rebuilt.length > 0) {
          queue = rebuilt;
        }
      }
    }
    const pruned = await pruneQueueByDb(queue);
    if (pruned.length !== queue.length) {
      await saveQueue(pruned);
    }
    const now = moment().tz("Asia/Seoul");
    const runnable = pruned.filter(isBookingTimeNear);

    // 만료 잡 정리: 오픈+2분 경과 항목 제거 및 DB 상태 실패 반영
    const expired = pruned.filter((job) => {
      const date = job.date ?? job.TARGET_DATE;
      const openTime = getBookingOpenTime(date);
      return now.isSameOrAfter(openTime.clone().add(2, "minute"));
    });
    if (expired.length > 0) {
      for (const job of expired) {
        const account = job.account ?? job.NAME;
        const date = job.date ?? job.TARGET_DATE;
        try {
          // Ensure MongoDB is connected
          if (mongoose.connection.readyState !== 1) {
            console.warn(
              "[WORKER] MongoDB not connected, skipping expired job update",
            );
            continue;
          }

          const existing = await Booking.findOne({ account, date });
          if (!existing) {
            continue;
          }
          if (
            existing &&
            (existing.status === "성공" || existing.status === "실패")
          ) {
            continue;
          }
          await Booking.updateOne(
            { account, date },
            { $set: { status: "실패" } },
            { upsert: false },
          );
        } catch (e) {
          console.error(
            "[WORKER] Failed to mark expired job as failed in DB:",
            account,
            date,
            e.message,
          );
        }
      }
      const remaining = pruned.filter((j) => !expired.includes(j));
      await saveQueue(remaining);
    }

    if (runnable.length > 0) {
      console.log(`[WORKER] Running auto-book for ${runnable.length} job(s)`);
      try {
        const normalized = runnable.map((j) => ({
          account: j.account ?? j.NAME,
          date: j.date ?? j.TARGET_DATE,
          startTime: j.startTime ?? j.START_TIME,
          endTime: j.endTime ?? j.END_TIME,
          force: j.force === true,
        }));
        const hasForce = normalized.some((j) => j.force === true);
        await runAutoBooking(normalized, { force: hasForce });
        // 실행된 작업은 큐에서 제거
        const currentQueue = await loadQueue();
        const remainingAfterRun = currentQueue.filter(
          (job) =>
            !runnable.some(
              (r) =>
                (r.account ?? r.NAME) === (job.account ?? job.NAME) &&
                (r.date ?? r.TARGET_DATE) === (job.date ?? job.TARGET_DATE),
            ),
        );
        await saveQueue(remainingAfterRun);
      } catch (err) {
        console.error("[WORKER] runAutoBooking failed:", err);
        // 실패 시 큐는 수정하지 않음 (다음 사이클에 재시도)
      }
    }
  } finally {
    processing = false;
  }
}

async function startWorker() {
  try {
    await connectDB();
    setInterval(processQueue, 2000); // 2초마다 체크 (기존 5초에서 단축)
    console.log("Worker started. Watching queue.json...");
  } catch (e) {
    console.error("[WORKER] Failed to initialize worker:", e.message);
  }
}

startWorker();
