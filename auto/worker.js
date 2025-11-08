import { runAutoBooking, getBookingOpenTime } from "./debeach_auto.js";
import fs from "fs/promises";
import path from "path";
import moment from "moment-timezone";
import { fileURLToPath } from "url";
import { Booking } from "../web/backend/models.js";
import connectDB from "../web/backend/db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const queuePath = path.resolve(__dirname, "./queue.json");
let processing = false;


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
  // 예약 오픈 1분 전 ~ 2분 후까지 실행 허용
  const now = moment().tz("Asia/Seoul");
  const date = job.date ?? job.TARGET_DATE;
  const openTime = getBookingOpenTime(date);
  return (
    now.isAfter(openTime.clone().subtract(1, "minute")) &&
    now.isBefore(openTime.clone().add(2, "minute"))
  );
}

async function processQueue() {
  if (processing) return;
  processing = true;
  try {
    const queue = await loadQueue();
    const now = moment().tz("Asia/Seoul");
    const runnable = queue.filter(isBookingTimeNear);

    // 만료 잡 정리: 오픈+2분 경과 항목 제거 및 DB 상태 실패 반영
    const expired = queue.filter((job) => {
      const date = job.date ?? job.TARGET_DATE;
      const openTime = getBookingOpenTime(date);
      return now.isSameOrAfter(openTime.clone().add(2, "minute"));
    });
    if (expired.length > 0) {
      for (const job of expired) {
        const account = job.account ?? job.NAME;
        const date = job.date ?? job.TARGET_DATE;
        try {
          const existing = await Booking.findOne({ account, date });
          if (existing && (existing.status === '성공' || existing.status === '실패')) {
            continue;
          }
          await Booking.updateOne(
            { account, date },
            { $set: { status: "실패" } },
            { upsert: true }
          );
        } catch (e) {
          console.error(
            "[WORKER] Failed to mark expired job as failed in DB:",
            account,
            date,
            e.message
          );
        }
      }
      const remaining = queue.filter((j) => !expired.includes(j));
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
        const remainingAfterRun = (await loadQueue()).filter(
          (j) => !runnable.includes(j)
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

connectDB();
setInterval(processQueue, 5000);
console.log("Worker started. Watching queue.json...");
