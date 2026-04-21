import axios from "axios";
import { CookieJar } from "tough-cookie";
import { wrapper as axiosCookieJarSupport } from "axios-cookiejar-support";
import moment from "moment-timezone";
import * as cheerio from "cheerio";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const LOGIN_ATTEMPT_TIMEOUT_MS = 10000;
const PRELOGIN_LEAD_MS = 90000;
const PRELOGIN_DEADLINE_BEFORE_OPEN_MS = 5000;

// DynamoDB 클라이언트 초기화
const dynamoClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: "ap-south-1" }),
);
const SLOT_CLAIMS_TABLE = "book-debeach-slot-claims";
const BOOKING_RESULTS_TABLE = "book-debeach-results";

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

// HHMM 문자열을 분 단위 정수로 변환 (예: "1254" → 774)
function hhmmToMinutes(hhmm) {
  const s = hhmm.replace(":", "");
  return parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(2, 4), 10);
}

// 슬롯을 목표 시간에 가까운 순서로 정렬
function sortSlotsByProximity(slots, targetTimeStr) {
  if (!Array.isArray(slots) || slots.length === 0) return [];

  const targetMin = hhmmToMinutes(targetTimeStr);
  return slots.slice().sort((a, b) => {
    const diffA = Math.abs(hhmmToMinutes(a.bk_time) - targetMin);
    const diffB = Math.abs(hhmmToMinutes(b.bk_time) - targetMin);
    return diffA - diffB;
  });
}

// 계정별로 슬롯 우선순위를 회전시켜 첫 시도 슬롯이 겹치지 않도록 함
function rotateSlotsForAccount(slots, config) {
  if (!Array.isArray(slots) || slots.length === 0) return [];

  const offset = config.PRIMARY_SLOT_OFFSET || 0;
  if (offset === 0) return slots;

  const rotated = slots.slice();
  const actualOffset = offset % rotated.length;
  return [...rotated.slice(actualOffset), ...rotated.slice(0, actualOffset)];
}

async function getLoginToken(client, timeoutMs = LOGIN_ATTEMPT_TIMEOUT_MS) {
  const res = await client.get("https://www.debeach.co.kr/auth/login", {
    headers: {
      Referer: "https://www.debeach.co.kr/",
      Origin: "https://www.debeach.co.kr", // 필수는 아니지만 XHR 패턴과 맞추는 용도
    },
    timeout: timeoutMs,
  });
  const $ = cheerio.load(res.data);
  const token = $('meta[name="csrf-token"]').attr("content");
  if (!token) {
    throw new Error("Login page did not provide csrf token");
  }
  return token;
}

async function doLogin(
  client,
  xsrfToken,
  loginId,
  loginPassword,
  timeoutMs = LOGIN_ATTEMPT_TIMEOUT_MS,
) {
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
      timeout: timeoutMs,
    },
  );
  const isLoggedIn = res.request.path === "/";
  const responseMessage =
    typeof res.data === "string"
      ? res.data.match(/아이디|비밀번호|로그인|오류|error/i)?.[0] || ""
      : typeof res.data?.message === "string"
        ? res.data.message
        : "";
  return {
    isLoggedIn,
    responseMessage,
    finalPath: res.request.path,
  };
}

async function refreshLogin(account, timeoutMs = LOGIN_ATTEMPT_TIMEOUT_MS) {
  const { client, config } = account;
  const logPrefix = `[${config.NAME}]`;
  console.warn(`${logPrefix} 🔐 Refreshing login session after 401 response.`);
  const token = await getLoginToken(client, timeoutMs);
  const loginResult = await doLogin(
    client,
    token,
    config.LOGIN_ID,
    config.LOGIN_PASSWORD,
    timeoutMs,
  );
  if (!loginResult.isLoggedIn) {
    throw new Error(
      `Re-login failed${loginResult.responseMessage ? `: ${loginResult.responseMessage}` : ""}`,
    );
  }
  account.token = token;
  console.log(`${logPrefix} 🔐 Re-login succeeded.`);
  return token;
}

function createCorrectedNow(offsetMs) {
  const baseNow = () => moment().tz("Asia/Seoul");
  return typeof offsetMs === "number" && !Number.isNaN(offsetMs)
    ? () => baseNow().add(offsetMs, "ms")
    : () => baseNow();
}

async function waitUntil(targetTime, logPrefix, offsetMs, label) {
  const correctedNow = createCorrectedNow(offsetMs);
  let waitTime = targetTime.diff(correctedNow());
  if (waitTime <= 5) {
    console.log(
      `${logPrefix} ${label} has already passed. Proceeding immediately.`,
    );
    return;
  }

  console.log(
    `${logPrefix} Waiting until ${label}: ${targetTime.format("YYYY-MM-DD HH:mm:ss.SSS")}`,
  );

  while (waitTime > 5) {
    const sleepTime =
      waitTime > 1000
        ? Math.min(waitTime - 5, 500)
        : Math.min(waitTime - 5, 100);
    if (sleepTime <= 0) break;
    await sleep(sleepTime);
    waitTime = targetTime.diff(correctedNow());
  }
}

async function runLoginAttempt(
  client,
  config,
  timeoutMs = LOGIN_ATTEMPT_TIMEOUT_MS,
) {
  const token = await getLoginToken(client, timeoutMs);
  const loginResult = await doLogin(
    client,
    token,
    config.LOGIN_ID,
    config.LOGIN_PASSWORD,
    timeoutMs,
  );
  if (!loginResult.isLoggedIn) {
    throw new Error(
      `Login rejected${loginResult.responseMessage ? `: ${loginResult.responseMessage}` : loginResult.finalPath ? ` (path: ${loginResult.finalPath})` : ""}`,
    );
  }
  return token;
}

async function loginWithRetriesBeforeOpen(
  client,
  config,
  bookingOpenTime,
  logPrefix,
  offsetMs,
) {
  const correctedNow = createCorrectedNow(offsetMs);
  const preloginStart = bookingOpenTime
    .clone()
    .subtract(PRELOGIN_LEAD_MS, "milliseconds");
  const preloginDeadline = bookingOpenTime
    .clone()
    .subtract(PRELOGIN_DEADLINE_BEFORE_OPEN_MS, "milliseconds");

  console.log(
    `${logPrefix} 🔐 Pre-login start: ${preloginStart.format("HH:mm:ss.SSS")}, deadline: ${preloginDeadline.format("HH:mm:ss.SSS")}. Starting login immediately.`,
  );

  let attempt = 0;
  while (correctedNow().isBefore(preloginDeadline)) {
    attempt += 1;
    const remainingMs = preloginDeadline.diff(correctedNow());
    const attemptBudgetMs = Math.min(LOGIN_ATTEMPT_TIMEOUT_MS, remainingMs);
    if (attemptBudgetMs <= 250) {
      break;
    }

    console.log(
      `${logPrefix} 🔐 Pre-login attempt ${attempt} starting with budget ${attemptBudgetMs}ms. Deadline: ${preloginDeadline.format("HH:mm:ss.SSS")}`,
    );

    try {
      const token = await Promise.race([
        runLoginAttempt(client, config, attemptBudgetMs),
        new Promise((_, reject) => {
          setTimeout(() => {
            reject(
              new Error(
                `Pre-login attempt timed out after ${attemptBudgetMs}ms`,
              ),
            );
          }, attemptBudgetMs);
        }),
      ]);
      console.log(
        `${logPrefix} 🔐 Pre-login succeeded on attempt ${attempt}. Completed at ${correctedNow().format("HH:mm:ss.SSS")}`,
      );
      return token;
    } catch (error) {
      console.warn(
        `${logPrefix} 🔐 Pre-login attempt ${attempt} failed: ${error.message}`,
      );
      await sleep(
        Math.min(
          700,
          Math.max(
            150,
            preloginDeadline.diff(correctedNow(), "milliseconds") - 50,
          ),
        ),
      );
    }
  }

  console.warn(
    `${logPrefix} 🔐 Pre-login window missed (deadline: ${preloginDeadline.format("HH:mm:ss.SSS")}, now: ${correctedNow().format("HH:mm:ss.SSS")}). Attempting fallback login (20s timeout)...`,
  );
  attempt += 1;
  const FALLBACK_TIMEOUT_MS = 20000;
  const token = await Promise.race([
    runLoginAttempt(client, config, FALLBACK_TIMEOUT_MS),
    new Promise((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `Fallback login timed out after ${FALLBACK_TIMEOUT_MS}ms`,
            ),
          ),
        FALLBACK_TIMEOUT_MS,
      ),
    ),
  ]);
  console.log(
    `${logPrefix} 🔐 Fallback login succeeded on attempt ${attempt}. Completed at ${correctedNow().format("HH:mm:ss.SSS")}`,
  );
  return token;
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
    },
  );

  return res.data;
}

// DynamoDB에 예약 결과 저장 (EBS 폴링용)
async function saveBookingResult(accountName, dateStr, result) {
  try {
    await dynamoClient.send(
      new PutCommand({
        TableName: BOOKING_RESULTS_TABLE,
        Item: {
          pk: `${dateStr}#${accountName}`,
          accountName,
          dateStr,
          success: result.success,
          slot: result.slot || null,
          reason: result.reason || null,
          stats: result.stats || null,
          slots: result.slots || null,
          savedAt: Date.now(),
          ttl: Math.floor(Date.now() / 1000) + 3600, // 1시간 TTL
        },
      }),
    );
    console.log(
      `[${accountName}] 📝 Booking result saved to DynamoDB (success=${result.success})`,
    );
  } catch (e) {
    console.warn(
      `[${accountName}] Failed to save booking result to DynamoDB: ${e.message}`,
    );
  }
}

// DynamoDB 슬롯 예약 함수
async function claimSlot(dateStr, slot, accountName) {
  const slotKey = `${dateStr}#${slot.bk_time}#${slot.bk_cours}`;
  const nowSec = Math.floor(Date.now() / 1000);

  try {
    await dynamoClient.send(
      new PutCommand({
        TableName: SLOT_CLAIMS_TABLE,
        Item: {
          PK: slotKey,
          accountName: accountName,
          claimedAt: Date.now(),
          TTL: nowSec + 60, // 60초 후 만료
        },
        // 레코드가 없거나, TTL이 만료된 경우에만 claim 허용
        ConditionExpression: "attribute_not_exists(PK) OR #ttl <= :now",
        ExpressionAttributeNames: { "#ttl": "TTL" },
        ExpressionAttributeValues: { ":now": nowSec },
      }),
    );

    return true;
  } catch (error) {
    if (error.name === "ConditionalCheckFailedException") {
      return false;
    }
    console.warn(`[${accountName}] DynamoDB claim error: ${error.message}`);
    return false;
  }
}

// DynamoDB 슬롯 claim TTL 연장 (서버 422: 실제 마감된 슬롯을 모든 Lambda가 5분간 건너뜀)
async function markSlotTaken(dateStr, slot, accountName) {
  const slotKey = `${dateStr}#${slot.bk_time}#${slot.bk_cours}`;
  const nowSec = Math.floor(Date.now() / 1000);
  try {
    await dynamoClient.send(
      new PutCommand({
        TableName: SLOT_CLAIMS_TABLE,
        Item: {
          PK: slotKey,
          accountName: accountName,
          claimedAt: Date.now(),
          TTL: nowSec + 20, // 20초간 유지
          serverTaken: true,
        },
      }),
    );
    console.log(
      `[${accountName}] 🚫 Marked slot ${slot.bk_time} (${slot.bk_cours}) as server-taken (TTL +20s)`,
    );
  } catch (e) {
    console.warn(`[${accountName}] Failed to mark slot as taken: ${e.message}`);
  }
}

// 이미 예약된 슬롯 조회 (TTL 미만료 항목만)
async function getClaimedSlots(dateStr) {
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const result = await dynamoClient.send(
      new ScanCommand({
        TableName: SLOT_CLAIMS_TABLE,
        FilterExpression: "begins_with(PK, :datePrefix) AND #ttl > :now",
        ExpressionAttributeNames: { "#ttl": "TTL" },
        ExpressionAttributeValues: {
          ":datePrefix": dateStr,
          ":now": nowSec,
        },
        ProjectionExpression: "PK",
      }),
    );

    return new Set(result.Items?.map((item) => item.PK) || []);
  } catch (error) {
    console.warn(`DynamoDB scan error: ${error.message}`);
    return new Set();
  }
}

async function selectAndConfirmBooking(
  client,
  xsrfToken,
  timeSlot,
  dateStr,
  logPrefix,
) {
  const { bk_cours: cours, bk_time: time, bk_hole: hole } = timeSlot;
  const createUrl = `https://www.debeach.co.kr/booking/create?date=${dateStr}&cours=${cours}&time=${time}&hole=${hole}`;
  const createStartedAt = Date.now();

  const createRes = await client.get(createUrl, {
    headers: {
      Accept: "*/*",
      "X-Requested-With": "XMLHttpRequest",
      "X-XSRF-TOKEN": xsrfToken,
      Referer: "https://www.debeach.co.kr/booking",
    },
    timeout: 3000,
  });
  const createElapsedMs = Date.now() - createStartedAt;

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

  const postDelayMs = Math.floor(Math.random() * 401) + 800; // 800~1200ms (수동 스크립트는 1000ms 고정)
  console.log(
    `${logPrefix} ⏱️ create completed for ${time} in ${createElapsedMs}ms. Waiting ${postDelayMs}ms before final booking POST.`,
  );
  await sleep(postDelayMs);

  const confirmStartedAt = Date.now();
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
      timeout: 3000,
    },
  );
  const confirmElapsedMs = Date.now() - confirmStartedAt;
  console.log(
    `${logPrefix} ⏱️ final booking POST completed for ${time} in ${confirmElapsedMs}ms.`,
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

async function attemptBooking(
  account,
  targetSlot,
  failedSlots,
  hasRetried401 = false,
  retry429Count = 0,
) {
  const { client, config } = account;
  const logPrefix = `[${config.NAME}]`;

  try {
    const jitterDelayMs = Math.floor(Math.random() * 51) + 20; // 20~70ms (수동 스크립트는 지터 없음)
    await sleep(jitterDelayMs);

    console.log(
      `${logPrefix} ➡️ Trying to book time: ${targetSlot.bk_time} on course ${targetSlot.bk_cours} (delay: ${jitterDelayMs}ms)`,
    );
    const bookingStartedAt = Date.now();
    await selectAndConfirmBooking(
      client,
      account.token,
      targetSlot,
      config.TARGET_DATE,
      logPrefix,
    );
    const bookingElapsedMs = Date.now() - bookingStartedAt;
    console.log(
      `${logPrefix} 🎉 Successfully booked time: ${targetSlot.bk_time} (total booking sequence: ${bookingElapsedMs}ms)`,
    );

    return { success: true, slot: targetSlot };
  } catch (error) {
    const url = error.config && error.config.url;
    const t = error.config && error.config.timeout;
    console.error(
      `${logPrefix} ❌ HTTP error on ${
        url || "unknown URL"
      } (timeout: ${t}ms):`,
      error.message,
    );

    if (error.response && error.response.status === 422) {
      console.log(
        `${logPrefix} ⚠️ Slot ${targetSlot.bk_time} (course ${targetSlot.bk_cours}) was taken. Continuing to next slot.`,
      );
      if (failedSlots && typeof failedSlots.add === "function") {
        failedSlots.add(`${targetSlot.bk_time}_${targetSlot.bk_cours}`);
      }
      // 서버에서 이미 마감된 슬롯 → TTL 20초 연장해 모든 Lambda가 재시도하지 않도록
      await markSlotTaken(config.TARGET_DATE, targetSlot, config.NAME);
      return { success: false, slot: targetSlot, wasTaken: true };
    } else if (!error.response) {
      // axios error가 아닌 경우 (파싱 실패 등) → failedSlots에 추가해 동일 Lambda가 재시도하지 않도록
      if (failedSlots && typeof failedSlots.add === "function") {
        failedSlots.add(`${targetSlot.bk_time}_${targetSlot.bk_cours}`);
      }
      return { success: false, slot: targetSlot };
    } else if (error.response && error.response.status === 401) {
      if (hasRetried401) {
        console.warn(
          `${logPrefix} 🔐 Received 401 again during booking attempt for ${targetSlot.bk_time}. Giving up on this slot after one re-login.`,
        );
        return { success: false, slot: targetSlot };
      }
      console.log(
        `${logPrefix} 🔐 Received 401 during booking attempt for ${targetSlot.bk_time}. Re-authenticating and retrying once.`,
      );
      await refreshLogin(account);
      return await attemptBooking(account, targetSlot, failedSlots, true);
    } else if (error.response && error.response.status === 429) {
      if (retry429Count >= 3) {
        console.warn(
          `${logPrefix} ⏳ 429 Too Many Requests. Max retries (3) reached for ${targetSlot.bk_time}. Giving up.`,
        );
        return { success: false, slot: targetSlot };
      }
      const retryAfter = Math.random() * 800 + 1200; // 1200~2000ms로 backoff 단축
      console.log(
        `${logPrefix} ⏳ 429 Too Many Requests. Retrying after ${Math.round(
          retryAfter,
        )}ms... (attempt ${retry429Count + 1}/3)`,
      );
      await sleep(retryAfter);
      return await attemptBooking(
        account,
        targetSlot,
        failedSlots,
        hasRetried401,
        retry429Count + 1,
      );
    } else {
      console.error(
        `${logPrefix} ❌ Unexpected error for ${targetSlot.bk_time}:`,
        error.message,
      );
    }
    return { success: false, slot: targetSlot };
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
    (s) => s.bk_time >= start && s.bk_time <= end,
  ).length;

  return {
    teeTotal: total,
    teeFirstHalf: firstHalf,
    teeSecondHalf: secondHalf,
    teeInRange: inRange,
  };
}

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
    `${logPrefix} Starting precision wait. Target time (window start or open): ${openTime.format()}`,
  );

  const correctedTime = createCorrectedNow(offsetMs);

  if (typeof offsetMs === "number" && !Number.isNaN(offsetMs)) {
    console.log(
      `${logPrefix} Using precomputed NTP offset from payload: ${offsetMs}ms`,
    );
  } else {
    console.log(
      `${logPrefix} No valid offsetMs provided. Using system time as-is (Asia/Seoul).`,
    );
  }

  let waitTime = openTime.diff(correctedTime());
  if (waitTime <= 5) {
    console.log(
      `${logPrefix} Target time has already passed. Proceeding immediately.`,
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
      "HH:mm:ss.SSS",
    )}`,
  );
}

// --- Lambda Handler ---

async function getOutboundIp() {
  try {
    const res = await axios.get("https://checkip.amazonaws.com", {
      timeout: 3000,
    });
    return String(res.data).trim();
  } catch {
    return "unknown";
  }
}

export const handler = async (event) => {
  const invokeReceivedAt = moment().tz("Asia/Seoul").format("HH:mm:ss.SSS");
  console.log("Lambda invoked with event:", event);
  const { config, immediate, offsetMs } = event;
  const logName = config.NAME || config.LOGIN_ID;
  try {
    // 1. HTTP client 준비
    const jar = new CookieJar();
    const client = axiosCookieJarSupport(
      axios.create({
        jar,
        withCredentials: true,
        timeout: LOGIN_ATTEMPT_TIMEOUT_MS,
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
      }),
    );

    // 2. 예약 오픈 시간 계산 및 정밀 대기 (즉시 실행이 아닐 경우에만)
    const bookingOpenTime = getBookingOpenTime(config.TARGET_DATE);
    // 오픈 시각 + 50~350ms에 fetch 시작 → fetch 완료(~250ms) 후 바로 booking 시도 → booking 시작 ≈ open + 300~600ms
    const firstFetchOffsetMs = 50 + Math.floor(Math.random() * 301); // 50~350ms
    const windowStart = bookingOpenTime
      .clone()
      .add(firstFetchOffsetMs, "milliseconds");
    let windowEnd = bookingOpenTime.clone().add(40, "seconds");

    let token;
    if (!immediate) {
      token = await loginWithRetriesBeforeOpen(
        client,
        config,
        bookingOpenTime,
        `[${logName}]`,
        offsetMs,
      );
    } else {
      token = await runLoginAttempt(client, config);
    }

    const outboundIp = await getOutboundIp();
    console.log(
      `[${logName}] 🌐 Outbound IP: ${outboundIp}, invoke received at: ${invokeReceivedAt}`,
    );

    const account = { client, token, config };

    // login 완료 후 현재 시각 기준 최소 30초를 보장 (늦게 invoke된 Lambda 대응)
    const MIN_WINDOW_AFTER_LOGIN_MS = 30000;
    const loginDoneTime = createCorrectedNow(offsetMs)();
    const windowEndFromLogin = loginDoneTime
      .clone()
      .add(MIN_WINDOW_AFTER_LOGIN_MS, "milliseconds");
    if (windowEnd.isBefore(windowEndFromLogin)) {
      windowEnd = windowEndFromLogin;
    }

    if (!immediate) {
      await waitForBookingOpen(windowStart, `[${logName}]`, offsetMs);
    } else {
      console.log(`[${logName}] Immediate execution. Skipping wait.`);
    }

    const startStr = config.START_TIME.replace(":", "");
    const endStr = config.END_TIME.replace(":", "");
    const s = startStr <= endStr ? startStr : endStr;
    const e = startStr <= endStr ? endStr : startStr;

    // 첫 슬롯 조회 기준 통계를 저장하기 위한 변수
    let baseSlots = null;
    let baseStats = null;

    // 3. 예약 시도
    if (immediate) {
      // ✅ 즉시 실행 모드: 각 시간대를 한 번씩만 시도하고, 실패하면 바로 종료
      let availableTimes = [];
      try {
        const fetchStartedAt = Date.now();
        console.log(
          `[${logName}] ⏱️ Starting initial slot fetch (immediate mode) for ${config.TARGET_DATE}`,
        );
        availableTimes = await fetchBookingTimes(
          client,
          token,
          config.TARGET_DATE,
        );
        const fetchElapsedMs = Date.now() - fetchStartedAt;
        console.log(
          `[${logName}] ✅ Slot fetch completed (immediate). Count: ${availableTimes.length}, elapsed: ${fetchElapsedMs}ms`,
        );
      } catch (e) {
        if (e.response && e.response.status === 401) {
          await refreshLogin(account);
          try {
            const retryFetchStartedAt = Date.now();
            console.log(
              `[${logName}] ⏱️ Retrying initial slot fetch after re-login (immediate mode).`,
            );
            availableTimes = await fetchBookingTimes(
              client,
              account.token,
              config.TARGET_DATE,
            );
            const retryFetchElapsedMs = Date.now() - retryFetchStartedAt;
            console.log(
              `[${logName}] ✅ Slot fetch completed after re-login (immediate). Count: ${availableTimes.length}, elapsed: ${retryFetchElapsedMs}ms`,
            );
          } catch (retryError) {
            console.warn(
              `[${logName}] Slot fetch failed after re-login: ${retryError.message}`,
            );
            const r1 = {
              success: false,
              reason: `Slot fetch failed after re-login: ${retryError.message}`,
              resultKey: `${config.TARGET_DATE}#${logName}`,
            };
            await saveBookingResult(logName, config.TARGET_DATE, r1);
            return r1;
          }
        } else {
          console.warn(`[${logName}] Slot fetch failed: ${e.message}`);
          const r2 = {
            success: false,
            reason: `Slot fetch failed: ${e.message}`,
            resultKey: `${config.TARGET_DATE}#${logName}`,
          };
          await saveBookingResult(logName, config.TARGET_DATE, r2);
          return r2;
        }
      }

      // 수동 스크립트는 250ms 대기 후 바로 시도
      const immediatePostFetchDelayMs = 200 + Math.floor(Math.random() * 101); // 200~300ms
      console.log(
        `[${logName}] ⏱️ Waiting ${immediatePostFetchDelayMs}ms after initial slot fetch before booking attempts (immediate mode).`,
      );
      await sleep(immediatePostFetchDelayMs);

      if (availableTimes.length === 0) {
        console.log(`[${logName}] No available slots returned from server.`);
        const stats = computeTeeStats(availableTimes, s, e);
        if (!baseStats) {
          baseStats = stats;
          baseSlots = availableTimes;
          console.log(
            `[${logName}] 📊 Initial tee stats - total: ${stats.teeTotal}, firstHalf: ${stats.teeFirstHalf}, secondHalf: ${stats.teeSecondHalf}, inRange: ${stats.teeInRange}`,
          );
        }
        const r0 = {
          success: false,
          reason: "No available slots.",
          stats,
          resultKey: `${config.TARGET_DATE}#${logName}`,
        };
        await saveBookingResult(logName, config.TARGET_DATE, r0);
        return r0;
      }

      const stats = computeTeeStats(availableTimes, s, e);
      if (!baseStats) {
        baseStats = stats;
        baseSlots = availableTimes;
        console.log(
          `[${logName}] 📊 Initial tee stats - total: ${stats.teeTotal}, firstHalf: ${stats.teeFirstHalf}, secondHalf: ${stats.teeSecondHalf}, inRange: ${stats.teeInRange}`,
        );
      }

      let targetTimes = availableTimes.filter(
        (slot) => slot.bk_time >= s && slot.bk_time <= e,
      );
      targetTimes = sortSlotsByProximity(targetTimes, startStr);

      if (targetTimes.length === 0) {
        console.log(
          `[${logName}] No slots in desired range: ${s}~${e}. Total slots: ${availableTimes.length}`,
        );
        const r = {
          success: false,
          reason: "No slots in desired range.",
          stats,
          resultKey: `${config.TARGET_DATE}#${logName}`,
        };
        await saveBookingResult(logName, config.TARGET_DATE, r);
        return r;
      }

      const primary = targetTimes[0];
      console.log(
        `[${logName}] 🎯 Primary target (immediate): ${primary.bk_time} on course ${primary.bk_cours} (totalTargets=${targetTimes.length})`,
      );

      for (const targetSlot of targetTimes) {
        // DynamoDB에 슬롯 예약 시도 (immediate 모드에서도 충돌 방지)
        const claimed = await claimSlot(
          config.TARGET_DATE,
          targetSlot,
          logName,
        );
        if (!claimed) {
          console.log(
            `[${logName}] ⚠️ Slot ${targetSlot.bk_time} (${targetSlot.bk_cours}) already claimed by another Lambda (immediate). Skipping.`,
          );
          continue;
        }

        console.log(
          `[${logName}] ✅ Claimed slot ${targetSlot.bk_time} (${targetSlot.bk_cours}) in DynamoDB (immediate)`,
        );

        const result = await attemptBooking(account, targetSlot);
        if (result.success) {
          console.log(`[${logName}] Booking successful (immediate).`);
          const r = {
            success: true,
            slot: result.slot,
            stats: baseStats || stats,
            slots: baseSlots || availableTimes,
            resultKey: `${config.TARGET_DATE}#${logName}`,
          };
          await saveBookingResult(logName, config.TARGET_DATE, r);
          return r;
        }
        // 즉시 실행에서는 wasTaken 이어도 refetch 하지 않고 바로 실패
      }

      const failedImmediate = {
        success: false,
        reason: "All target slots failed in immediate mode.",
        stats: baseStats || stats,
        slots: baseSlots || availableTimes,
        resultKey: `${config.TARGET_DATE}#${logName}`,
      };
      await saveBookingResult(logName, config.TARGET_DATE, failedImmediate);
      return failedImmediate;
    } else {
      // ✅ 예약 실행 모드: 예약 윈도우 내에서 반복 시도
      const windowEndTs = windowEnd.valueOf();
      const correctedNow = createCorrectedNow(offsetMs);
      const failedSlotTimes = new Set();
      let lastStats = null;

      while (correctedNow().valueOf() < windowEndTs) {
        let availableTimes = [];
        try {
          const fetchStartedAt = Date.now();
          console.log(
            `[${logName}] ⏱️ Starting slot fetch (queued mode) for ${config.TARGET_DATE}`,
          );
          availableTimes = await fetchBookingTimes(
            client,
            account.token,
            config.TARGET_DATE,
          );
          const fetchElapsedMs = Date.now() - fetchStartedAt;
          console.log(
            `[${logName}] ✅ Slot fetch completed (queued). Count: ${availableTimes.length}, elapsed: ${fetchElapsedMs}ms`,
          );
        } catch (e) {
          const status = e.response && e.response.status;

          if (status === 429) {
            const backoffMs = Math.floor(Math.random() * 800) + 1200; // 1200~2000ms로 단축
            console.warn(
              `[${logName}] Slot fetch failed with 429. Backing off for ${backoffMs}ms: ${e.message}`,
            );
            await sleep(backoffMs);
          } else if (status === 401) {
            console.warn(
              `[${logName}] Slot fetch failed with 401. Re-authenticating before retry: ${e.message}`,
            );
            try {
              await refreshLogin(account);
            } catch (loginError) {
              console.warn(
                `[${logName}] Re-login failed after 401 during slot fetch: ${loginError.message}`,
              );
              await sleep(800);
            }
          } else {
            console.warn(`[${logName}] Slot fetch failed: ${e.message}`);
            await sleep(400);
          }

          continue;
        }

        if (!Array.isArray(availableTimes)) {
          console.warn(
            `[${logName}] Slot fetch returned non-array (type=${typeof availableTimes}). Treating as empty and retrying.`,
          );
          await sleep(400);
          continue;
        }

        if (availableTimes.length === 0) {
          await sleep(500);
          continue;
        }

        const stats = computeTeeStats(availableTimes, s, e);
        if (!baseStats) {
          baseStats = stats;
          baseSlots = availableTimes;
          console.log(
            `[${logName}] 📊 Initial tee stats - total: ${stats.teeTotal}, firstHalf: ${stats.teeFirstHalf}, secondHalf: ${stats.teeSecondHalf}, inRange: ${stats.teeInRange}`,
          );
        }
        lastStats = stats;

        // DynamoDB에서 이미 다른 Lambda가 예약한 슬롯 조회
        const claimedSlots = await getClaimedSlots(config.TARGET_DATE);
        if (claimedSlots.size > 0) {
          console.log(
            `[${logName}] 📋 Already claimed by other Lambdas: ${claimedSlots.size} slots`,
          );
        }

        let targetTimes = availableTimes.filter((slot) => {
          const slotKey = `${config.TARGET_DATE}#${slot.bk_time}#${slot.bk_cours}`;
          return (
            slot.bk_time >= s &&
            slot.bk_time <= e &&
            !failedSlotTimes.has(`${slot.bk_time}_${slot.bk_cours}`) &&
            !claimedSlots.has(slotKey) // DynamoDB에 이미 예약된 슬롯 제외
          );
        });
        targetTimes = sortSlotsByProximity(targetTimes, startStr);

        // 계정별로 첫 시도 슬롯이 겹치지 않도록 순서를 회전
        targetTimes = rotateSlotsForAccount(targetTimes, config);

        if (targetTimes.length > 0) {
          const primary = targetTimes[0];
          console.log(
            `[${logName}] 🎯 Primary target (queued loop): ${primary.bk_time} on course ${primary.bk_cours} (totalTargets=${targetTimes.length})`,
          );
        }

        if (targetTimes.length === 0) {
          console.log(
            `[${logName}] ⚠️ No target slots available. Total slots: ${availableTimes.length}, Range: ${s}-${e}, Failed slots: ${failedSlotTimes.size}`,
          );
          if (failedSlotTimes.size > 0) {
            console.log(
              `[${logName}] 📋 Failed slot list: ${Array.from(failedSlotTimes).join(", ")}`,
            );
          }
          // Fallback: try any available slot not already failed or claimed (outside preferred range)
          let fallbackTimes = availableTimes.filter((slot) => {
            const slotKey = `${config.TARGET_DATE}#${slot.bk_time}#${slot.bk_cours}`;
            return (
              !failedSlotTimes.has(`${slot.bk_time}_${slot.bk_cours}`) &&
              !claimedSlots.has(slotKey)
            );
          });
          fallbackTimes = sortSlotsByProximity(fallbackTimes, startStr);
          fallbackTimes = rotateSlotsForAccount(fallbackTimes, config);
          if (fallbackTimes.length === 0) {
            await sleep(600);
            continue;
          }
          console.log(
            `[${logName}] 🔄 Fallback: trying ${fallbackTimes[0].bk_time} (${fallbackTimes[0].bk_cours}) — ${fallbackTimes.length} slots available outside preferred range`,
          );
          targetTimes = fallbackTimes;
        }

        let bookedThisRound = false;
        for (const targetSlot of targetTimes) {
          // DynamoDB에 슬롯 예약 시도 — 1개만 claim하고 즉시 break (다음 round에서 재시도)
          const claimed = await claimSlot(
            config.TARGET_DATE,
            targetSlot,
            logName,
          );
          if (!claimed) {
            console.log(
              `[${logName}] ⚠️ Slot ${targetSlot.bk_time} (${targetSlot.bk_cours}) already claimed by another Lambda. Skipping.`,
            );
            continue;
          }

          console.log(
            `[${logName}] ✅ Claimed slot ${targetSlot.bk_time} (${targetSlot.bk_cours}) in DynamoDB`,
          );

          const result = await attemptBooking(
            account,
            targetSlot,
            failedSlotTimes,
          );
          if (result.success) {
            console.log(`[${logName}] Booking successful (queued mode).`);
            const r = {
              success: true,
              slot: result.slot,
              stats: baseStats || stats,
              slots: baseSlots || availableTimes,
              resultKey: `${config.TARGET_DATE}#${logName}`,
            };
            await saveBookingResult(logName, config.TARGET_DATE, r);
            return r;
          }
          // claim 후 시도 1회 — 성공·실패 무관하게 이번 round 종료, 다음 fetch에서 재시도
          bookedThisRound = true;
          break;
        }

        if (!bookedThisRound) {
          await sleep(500);
        }
      }

      const failedQueued = {
        success: false,
        reason: "Booking failed within allowed window.",
        stats: baseStats || lastStats,
        slots: baseSlots,
        resultKey: `${config.TARGET_DATE}#${logName}`,
      };
      await saveBookingResult(logName, config.TARGET_DATE, failedQueued);
      return failedQueued;
    }
  } catch (error) {
    console.error(`[${logName}] An error occurred in Lambda:`, error.message);
    const errorResult = {
      success: false,
      reason: error.message,
      resultKey: `${config.TARGET_DATE}#${logName}`,
    };
    await saveBookingResult(logName, config.TARGET_DATE, errorResult);
    return errorResult;
  }
};
