import { runAutoBooking, getBookingOpenTime } from "./debeach_auto.js";
import moment from "moment-timezone";
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

let processing = false;

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

// 현재 시간이 예약 오픈 2분 전~후인지 확인 (부킹 시각: 평일 9시, 수요일 10시)
function isInBookingWindow() {
  const now = moment().tz("Asia/Seoul");
  const dayOfWeek = now.day(); // 0=일, 1=월, ..., 3=수, ..., 6=토
  const hour = now.hour();
  const minute = now.minute();
  const totalMinutes = hour * 60 + minute;

  // 평일(월~금): 9:00 오픈 => 8:58 ~ 9:02
  if (dayOfWeek >= 1 && dayOfWeek <= 5) {
    const openMinutes = 9 * 60; // 540
    // 2분 전 ~ 2분 후
    if (totalMinutes >= openMinutes - 2 && totalMinutes <= openMinutes + 2) {
      return true;
    }
  }

  // 수요일: 10:00 추가 오픈 => 9:58 ~ 10:02
  if (dayOfWeek === 3) {
    const openMinutes = 10 * 60; // 600
    if (totalMinutes >= openMinutes - 2 && totalMinutes <= openMinutes + 2) {
      return true;
    }
  }

  return false;
}

async function processQueue() {
  if (processing) return;

  // 예약 오픈 2분 전~후가 아니면 스킵
  if (!isInBookingWindow()) {
    return;
  }

  processing = true;
  try {
    // 예약 오픈 시간대에만 DB에서 읽기
    let queue = [];
    if (mongoose.connection.readyState === 1) {
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
      queue = bookings
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
      if (queue.length > 0) {
        console.log(
          `[WORKER] Booking window detected: ${queue.length} job(s) from DB`,
        );
      }
    }

    const pruned = await pruneQueueByDb(queue);
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
      // Expired jobs are marked as failed in DB above
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
        // Completed - status is saved to DB by runAutoBooking
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
    setInterval(processQueue, 2000); // 2초마다 체크
    console.log(
      "Worker started. Will read from DB only during booking windows (weekdays 9AM, Wed 10AM)...",
    );
  } catch (e) {
    console.error("[WORKER] Failed to initialize worker:", e.message);
  }
}

startWorker();
