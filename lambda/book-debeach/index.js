import axios from "axios";
import { CookieJar } from "tough-cookie";
import { wrapper as axiosCookieJarSupport } from "axios-cookiejar-support";
import moment from "moment-timezone";
import * as cheerio from "cheerio";

// Lambda(Node 18) 환경에서 undici가 기대하는 File 전역이 없어서 ReferenceError가 나므로 간단한 폴리필
if (typeof File === "undefined") {
  globalThis.File = class File {};
}

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

// --- Core Booking Logic (from debeach_auto.js) ---

async function getLoginToken(client) {
  const res = await client.get("https://www.debeach.co.kr/auth/login", {
    headers: {
      Referer: "https://www.debeach.co.kr/",
      Origin: "https://www.debeach.co.kr", // 필수는 아니지만 XHR 패턴과 맞추는 용도
    },
  });
  const $ = cheerio.load(res.data);
  const token = $('meta[name="csrf-token"]').attr("content");
  return token;
}

async function doLogin(client, xsrfToken, loginId, loginPassword) {
  const payload = new URLSearchParams({
    username: loginId,
    password: loginPassword,
    remember: "1",
    _token: xsrfToken,
  });

  const res = await client.post(
    "https://www.debeach.co.kr/auth/login",
    payload.toString(),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-XSRF-TOKEN": xsrfToken,
        Origin: "https://www.debeach.co.kr",
        Referer: "https://www.debeach.co.kr/auth/login",
      },
    }
  );
  const isLoggedIn = res.request.path === "/";
  return isLoggedIn;
}

async function fetchBookingTimes(client, xsrfToken, dateStr) {
  const res = await client.get(
    `https://www.debeach.co.kr/booking/time/${dateStr}`,
    {
      headers: {
        Accept: "application/json, text/plain, */*",
        "X-Requested-With": "XMLHttpRequest",
        "X-XSRF-TOKEN": xsrfToken,
        Origin: "https://www.debeach.co.kr",
        Referer: `https://www.debeach.co.kr/booking/golf-calendar?date=${dateStr}`,
      },
    }
  );

  return res.data;
}

async function selectAndConfirmBooking(client, xsrfToken, timeSlot, dateStr) {
  const { bk_cours: cours, bk_time: time, bk_hole: hole } = timeSlot;
  const createUrl = `https://www.debeach.co.kr/booking/create?date=${dateStr}&cours=${cours}&time=${time}&hole=${hole}`;

  const createRes = await client.get(createUrl, {
    headers: {
      Accept: "*/*",
      "X-Requested-With": "XMLHttpRequest",
      "X-XSRF-TOKEN": xsrfToken,
      Referer: "https://www.debeach.co.kr/booking",
    },
    timeout: 3000,
  });

  const $ = cheerio.load(createRes.data);
  const bookingToken = $('form#form-create input[name="_token"]').val();
  const peopleCount = $('form#form-create input[name="incnt"]:checked').val();

  if (!bookingToken || !peopleCount) {
    throw new Error("Could not find booking token or people count.");
  }

  const payload = new URLSearchParams();
  payload.append("_token", bookingToken);
  payload.append("date", dateStr);
  payload.append("cours", cours);
  payload.append("time", time);
  payload.append("hole", hole);
  payload.append("incnt", peopleCount);
  payload.append("booking_agree", "0");
  payload.append("booking_agree", "1");

  const randomDelay = Math.floor(Math.random() * 431) + 300; // 300~730ms의 작은 지터
  await new Promise((resolve) => setTimeout(resolve, randomDelay));

  const confirmRes = await client.post(
    "https://www.debeach.co.kr/booking",
    payload.toString(),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Accept: "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
        "X-XSRF-TOKEN": xsrfToken,
        Referer: "https://www.debeach.co.kr/booking",
      },
      validateStatus: (status) => status >= 200 && status < 400,
      timeout: 5000,
    }
  );

  if (confirmRes.data && confirmRes.data.redirect) {
    return confirmRes.data;
  } else {
    const errorMessage =
      (confirmRes.data && confirmRes.data.message) ||
      "Booking failed for an unknown reason.";
    throw new Error(errorMessage);
  }
}

function computeTeeStats(availableTimes, startHHmm, endHHmm) {
  if (!Array.isArray(availableTimes) || availableTimes.length === 0) {
    return {
      teeTotal: 0,
      teeFirstHalf: 0,
      teeSecondHalf: 0,
      teeInRange: 0,
    };
  }

  const total = availableTimes.length;
  const firstHalf = availableTimes.filter((s) => s.bk_time < "0900").length;
  const secondHalf = availableTimes.filter((s) => s.bk_time >= "0900").length;

  const start = startHHmm;
  const end = endHHmm;
  const inRange = availableTimes.filter(
    (s) => s.bk_time >= start && s.bk_time <= end
  ).length;

  return {
    teeTotal: total,
    teeFirstHalf: firstHalf,
    teeSecondHalf: secondHalf,
    teeInRange: inRange,
  };
}

async function attemptBooking(account, targetSlot, failedSlots) {
  const { client, token, config } = account;
  const logPrefix = `[${config.NAME}]`;

  try {
    const jitter = Math.floor(Math.random() * 401) - 200; // -200~+200ms
    const randomDelay = Math.max(0, jitter);
    await new Promise((resolve) => setTimeout(resolve, randomDelay));

    console.log(
      `${logPrefix} ➡️ Trying to book time: ${targetSlot.bk_time} on course ${targetSlot.bk_cours} (delay: ${randomDelay}ms)`
    );
    await selectAndConfirmBooking(
      client,
      token,
      targetSlot,
      config.TARGET_DATE
    );
    console.log(
      `${logPrefix} 🎉 Successfully booked time: ${targetSlot.bk_time}`
    );

    return { success: true, slot: targetSlot };
  } catch (error) {
    const url = error.config && error.config.url;
    const t = error.config && error.config.timeout;
    console.error(
      `${logPrefix} ❌ HTTP error on ${
        url || "unknown URL"
      } (timeout: ${t}ms):`,
      error.message
    );

    if (error.response && error.response.status === 422) {
      console.log(
        `${logPrefix} ⚠️ Slot ${targetSlot.bk_time} was taken. Breaking to refetch slots.`
      );
      if (failedSlots && typeof failedSlots.add === "function") {
        failedSlots.add(targetSlot.bk_time);
      }
      return { success: false, slot: targetSlot, wasTaken: true };
    } else if (error.response && error.response.status === 429) {
      const retryAfter = Math.random() * 800 + 1200; // 1200~2000ms로 backoff 단축
      console.log(
        `${logPrefix} ⏳ 429 Too Many Requests. Retrying after ${Math.round(
          retryAfter
        )}ms...`
      );
      await new Promise((resolve) => setTimeout(resolve, retryAfter));
      return await attemptBooking(account, targetSlot, failedSlots);
    } else {
      console.error(
        `${logPrefix} ❌ Unexpected error for ${targetSlot.bk_time}:`,
        error.message
      );
    }
    return { success: false, slot: targetSlot };
  }
}

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function rotateSlotsForAccount(slots, config) {
  if (!Array.isArray(slots) || slots.length === 0) {
    return slots;
  }
  // 오수양 계정은 슬롯 순서를 회전시키지 않고, 설정한 시간 범위 내에서
  // 정렬된 순서 그대로 시도하도록 예외 처리한다.
  if (config.NAME === "오수양") {
    return slots;
  }

  const id = config.NAME || config.LOGIN_ID || "";
  if (!id) return slots;

  const n = slots.length;
  // 기본은 계정 이름/ID 기반 해시로 분산
  let offset = simpleHash(id) % n;
  // Orchestrator에서 PRIMARY_SLOT_OFFSET을 넘겨주면 이를 추가로 반영해
  // 동일 계정군 내 1순위 타겟 충돌을 더 줄인다.
  if (typeof config.PRIMARY_SLOT_OFFSET === "number") {
    offset = (offset + (config.PRIMARY_SLOT_OFFSET % n) + n) % n;
  }
  if (offset === 0) return slots;

  const rotated = new Array(n);
  for (let i = 0; i < n; i++) {
    rotated[i] = slots[(offset + i) % n];
  }
  return rotated;
}

// --- Helper Functions for Lambda ---

function getBookingOpenTime(targetDateStr) {
  const targetDate = moment.tz(targetDateStr, "YYYYMMDD", "Asia/Seoul");
  const dayOfWeek = targetDate.day();
  let openTime = targetDate.clone().set({ hour: 0, minute: 0, second: 0 });

  if (dayOfWeek === 0) {
    // 일요일
    openTime.add(10, "hours").subtract(11, "days");
  } else if (dayOfWeek === 6) {
    // 토요일
    openTime.add(10, "hours").subtract(10, "days");
  } else {
    // 평일
    openTime.add(9, "hours").subtract(14, "days");
  }
  return openTime;
}

async function waitForBookingOpen(openTime, logPrefix, offsetMs) {
  console.log(
    `${logPrefix} Starting precision wait. Target time (window start or open): ${openTime.format()}`
  );

  const baseNow = () => moment().tz("Asia/Seoul");
  const correctedTime =
    typeof offsetMs === "number" && !Number.isNaN(offsetMs)
      ? () => baseNow().add(offsetMs, "ms")
      : () => baseNow();

  if (typeof offsetMs === "number" && !Number.isNaN(offsetMs)) {
    console.log(
      `${logPrefix} Using precomputed NTP offset from payload: ${offsetMs}ms`
    );
  } else {
    console.log(
      `${logPrefix} No valid offsetMs provided. Using system time as-is (Asia/Seoul).`
    );
  }

  let waitTime = openTime.diff(correctedTime());
  if (waitTime <= 5) {
    console.log(
      `${logPrefix} Target time has already passed. Proceeding immediately.`
    );
    return;
  }

  // 정밀 대기 루프
  while (waitTime > 5) {
    // 1초 이상 남았으면 500ms 대기, 그 외에는 busy-wait에 가깝게 짧게 대기
    const sleepTime = waitTime > 1000 ? 500 : Math.min(waitTime - 5, 100);
    if (sleepTime <= 0) break;

    await new Promise((resolve) => setTimeout(resolve, sleepTime));
    waitTime = openTime.diff(correctedTime());
  }
  console.log(
    `${logPrefix} Precision wait finished. Corrected time: ${correctedTime().format(
      "HH:mm:ss.SSS"
    )}`
  );
}

// --- Lambda Handler ---

export const handler = async (event) => {
  console.log("Lambda invoked with event:", event);
  const { config, immediate, offsetMs } = event;
  const logName = config.NAME || config.LOGIN_ID;
  try {
    // 1. 로그인 (오픈 전 미리 세션 준비)
    const jar = new CookieJar();
    const client = axiosCookieJarSupport(
      axios.create({
        jar,
        withCredentials: true,
        timeout: 5000,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9," +
            "image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
          Connection: "keep-alive",
        },
      })
    );
    const token = await getLoginToken(client);
    const isLoggedIn = await doLogin(
      client,
      token,
      config.LOGIN_ID,
      config.LOGIN_PASSWORD
    );
    if (!isLoggedIn) {
      throw new Error("Login failed");
    }

    const account = { client, token, config };

    // 2. 예약 오픈 시간 계산 및 정밀 대기 (즉시 실행이 아닐 경우에만)
    const bookingOpenTime = getBookingOpenTime(config.TARGET_DATE);
    // 슬롯 첫 조회를 오픈 시각(예: 09:00:00) 이후 약 200ms 시점에 맞추기 위한 오프셋
    const firstFetchOffsetMs = 200;
    const windowStart = bookingOpenTime
      .clone()
      .add(firstFetchOffsetMs, "milliseconds");
    const windowEnd = bookingOpenTime.clone().add(20, "seconds");

    if (!immediate) {
      await waitForBookingOpen(windowStart, `[${logName}]`, offsetMs);
    } else {
      console.log(`[${logName}] Immediate execution. Skipping wait.`);
    }

    const startStr = config.START_TIME.replace(":", "");
    const endStr = config.END_TIME.replace(":", "");
    const s = startStr <= endStr ? startStr : endStr;
    const e = startStr <= endStr ? endStr : startStr;
    const descending = startStr > endStr;

    // 첫 슬롯 조회 기준 통계를 저장하기 위한 변수
    let baseSlots = null;
    let baseStats = null;

    // 3. 예약 시도
    if (immediate) {
      // ✅ 즉시 실행 모드: 각 시간대를 한 번씩만 시도하고, 실패하면 바로 종료
      let availableTimes = [];
      try {
        console.log(
          `[${logName}] ⏱️ Starting initial slot fetch (immediate mode) for ${config.TARGET_DATE}`
        );
        availableTimes = await fetchBookingTimes(
          client,
          token,
          config.TARGET_DATE
        );
        console.log(
          `[${logName}] ✅ Slot fetch completed (immediate). Count: ${availableTimes.length}`
        );
      } catch (e) {
        console.warn(`[${logName}] Slot fetch failed: ${e.message}`);
        return { success: false, reason: `Slot fetch failed: ${e.message}` };
      }

      // 너무 빠른 부킹 시도로 인한 봇 차단을 피하기 위해
      // 슬롯 조회 직후 최소 400ms 정도 대기 후 부킹을 시도한다 (400~450ms 랜덤)
      const immediatePostFetchDelayMs = 350 + Math.floor(Math.random() * 51);
      console.log(
        `[${logName}] ⏱️ Waiting ${immediatePostFetchDelayMs}ms after initial slot fetch before booking attempts (immediate mode).`
      );
      await new Promise((r) => setTimeout(r, immediatePostFetchDelayMs));

      if (availableTimes.length === 0) {
        console.log(`[${logName}] No available slots returned from server.`);
        const stats = computeTeeStats(availableTimes, s, e);
        if (!baseStats) {
          baseStats = stats;
          baseSlots = availableTimes;
          console.log(
            `[${logName}] 📊 Initial tee stats - total: ${stats.teeTotal}, firstHalf: ${stats.teeFirstHalf}, secondHalf: ${stats.teeSecondHalf}, inRange: ${stats.teeInRange}`
          );
        }
        return { success: false, reason: "No available slots.", stats };
      }

      const stats = computeTeeStats(availableTimes, s, e);
      if (!baseStats) {
        baseStats = stats;
        baseSlots = availableTimes;
        console.log(
          `[${logName}] 📊 Initial tee stats - total: ${stats.teeTotal}, firstHalf: ${stats.teeFirstHalf}, secondHalf: ${stats.teeSecondHalf}, inRange: ${stats.teeInRange}`
        );
      }

      const targetTimes = availableTimes
        .filter((slot) => slot.bk_time >= s && slot.bk_time <= e)
        .sort((a, b) =>
          descending
            ? b.bk_time.localeCompare(a.bk_time)
            : a.bk_time.localeCompare(b.bk_time)
        );

      if (targetTimes.length === 0) {
        console.log(
          `[${logName}] No slots in desired range: ${s}~${e}. Total slots: ${availableTimes.length}`
        );
        return { success: false, reason: "No slots in desired range.", stats };
      }

      const primary = targetTimes[0];
      console.log(
        `[${logName}] 🎯 Primary target (immediate): ${primary.bk_time} on course ${primary.bk_cours} (totalTargets=${targetTimes.length})`
      );

      for (const targetSlot of targetTimes) {
        const result = await attemptBooking(account, targetSlot);
        if (result.success) {
          console.log(`[${logName}] Booking successful (immediate).`);
          return {
            success: true,
            slot: result.slot,
            stats: baseStats || stats,
            slots: baseSlots || availableTimes,
          };
        }
        // 즉시 실행에서는 wasTaken 이어도 refetch 하지 않고 바로 실패
      }

      return {
        success: false,
        reason: "All target slots failed in immediate mode.",
        stats: baseStats || stats,
        slots: baseSlots || availableTimes,
      };
    } else {
      // ✅ 예약 실행 모드: 예약 윈도우 내에서 반복 시도
      const windowEndTs = windowEnd.valueOf();
      const failedSlotTimes = new Set();
      let lastStats = null;

      while (Date.now() < windowEndTs) {
        let availableTimes = [];
        try {
          console.log(
            `[${logName}] ⏱️ Starting slot fetch (queued mode) for ${config.TARGET_DATE}`
          );
          availableTimes = await fetchBookingTimes(
            client,
            token,
            config.TARGET_DATE
          );
          console.log(
            `[${logName}] ✅ Slot fetch completed (queued). Count: ${availableTimes.length}`
          );
        } catch (e) {
          const status = e.response && e.response.status;

          if (status === 429) {
            const backoffMs = Math.floor(Math.random() * 800) + 1200; // 1200~2000ms로 단축
            console.warn(
              `[${logName}] Slot fetch failed with 429. Backing off for ${backoffMs}ms: ${e.message}`
            );
            await new Promise((r) => setTimeout(r, backoffMs));
          } else if (status === 401) {
            const backoffMs = Math.floor(Math.random() * 2000) + 2000; // 2000~4000ms
            console.warn(
              `[${logName}] Slot fetch failed with 401. Backing off for ${backoffMs}ms: ${e.message}`
            );
            await new Promise((r) => setTimeout(r, backoffMs));
          } else {
            console.warn(`[${logName}] Slot fetch failed: ${e.message}`);
            await new Promise((r) => setTimeout(r, 400));
          }

          continue;
        }

        if (availableTimes.length === 0) {
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }

        const stats = computeTeeStats(availableTimes, s, e);
        // 슬롯 응답을 받은 뒤 너무 빠르게 부킹을 시도하면 봇으로 인식될 수 있으므로
        // 최소 400ms 정도는 쉬고(400~450ms 랜덤) 부킹 시도 시작
        const postFetchDelayMs = 300 + Math.floor(Math.random() * 51); // 400~450ms
        console.log(
          `[${logName}] ⏱️ Waiting ${postFetchDelayMs}ms after slot fetch before booking attempts.`
        );
        await new Promise((r) => setTimeout(r, postFetchDelayMs));
        if (!baseStats) {
          baseStats = stats;
          baseSlots = availableTimes;
          console.log(
            `[${logName}] 📊 Initial tee stats - total: ${stats.teeTotal}, firstHalf: ${stats.teeFirstHalf}, secondHalf: ${stats.teeSecondHalf}, inRange: ${stats.teeInRange}`
          );
        }
        lastStats = stats;

        let targetTimes = availableTimes
          .filter(
            (slot) =>
              slot.bk_time >= s &&
              slot.bk_time <= e &&
              !failedSlotTimes.has(slot.bk_time)
          )
          .sort((a, b) =>
            descending
              ? b.bk_time.localeCompare(a.bk_time)
              : a.bk_time.localeCompare(b.bk_time)
          );

        // 계정별로 첫 시도 슬롯이 겹치지 않도록 순서를 회전
        targetTimes = rotateSlotsForAccount(targetTimes, config);

        if (targetTimes.length > 0) {
          const primary = targetTimes[0];
          console.log(
            `[${logName}] 🎯 Primary target (queued loop): ${primary.bk_time} on course ${primary.bk_cours} (totalTargets=${targetTimes.length})`
          );
        }

        if (targetTimes.length === 0) {
          await new Promise((r) => setTimeout(r, 600));
          continue;
        }

        for (const targetSlot of targetTimes) {
          const result = await attemptBooking(
            account,
            targetSlot,
            failedSlotTimes
          );
          if (result.success) {
            console.log(`[${logName}] Booking successful (queued mode).`);
            return {
              success: true,
              slot: result.slot,
              stats: baseStats || stats,
              slots: baseSlots || availableTimes,
            };
          }
          if (result.wasTaken) {
            // 슬롯 목록이 낡았으니 다시 전체를 refetch 하기 위해 while 루프 재진입
            break;
          }
        }

        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      return {
        success: false,
        reason: "Booking failed within allowed window.",
        stats: baseStats || lastStats,
        slots: baseSlots,
      };
    }
  } catch (error) {
    console.error(`[${logName}] An error occurred in Lambda:`, error.message);
    return { success: false, reason: error.message };
  }
};
