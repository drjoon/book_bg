import ntpClient from "ntp-client";
import moment from "moment-timezone";
import mongoose from "mongoose";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

import { Booking, User } from "../web/backend/models.js";
import { saveTeeSnapshot } from "../web/backend/s3.js";
import connectDB from "../web/backend/db.js";
import {
  decryptCredential,
  looksEncryptedCredential,
} from "../web/backend/crypto.js";

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

// NTP 시간 동기화 함수 (재시도 및 대체 서버 기능 추가)
const NTP_SERVERS = ["time.apple.com", "time.google.com", "pool.ntp.org"];
const MAX_NTP_RETRIES = 3;

const getNtpTime = async () => {
  for (let i = 0; i < MAX_NTP_RETRIES; i++) {
    for (const server of NTP_SERVERS) {
      try {
        const time = await new Promise((resolve, reject) => {
          ntpClient.getNetworkTime(server, 123, (err, date) => {
            if (err) {
              reject(err);
            } else {
              resolve(date);
            }
          });
        });
        console.log(`NTP time synchronized with ${server}:`, time);
        return time;
      } catch (err) {
        console.warn(
          `NTP Error with ${server} (Attempt ${i + 1}/${MAX_NTP_RETRIES}):`,
          err,
        );
      }
    }
  }

  console.error("All NTP servers failed. Falling back to system time.");
  return new Date(); // 모든 시도 실패 시 시스템 시간 사용
};

// Lambda 클라이언트 초기화 (리전은 실제 환경에 맞게 설정)
const LAMBDA_REGION =
  process.env.LAMBDA_REGION || process.env.AWS_REGION || "ap-south-1";
const LAMBDA_FUNCTION_NAME = process.env.LAMBDA_FUNCTION_NAME || "book-debeach";
const lambda = new LambdaClient({ region: LAMBDA_REGION });
console.log(
  `[LAMBDA] Using region=${LAMBDA_REGION}, function=${LAMBDA_FUNCTION_NAME}`,
);

const isTerminalStatus = (status) => {
  if (!status) return false;
  return (
    status === "성공" ||
    status === "실패" ||
    status === "취소" ||
    status === "cancel" ||
    status === "canceled" ||
    status === "cancelled"
  );
};

// 특정 날짜 그룹에 대한 전체 예약 과정을 관리하는 함수 (Lambda 호출자로 변경)
async function runBookingGroup(group, options) {
  const { date, configs } = group;
  const logPrefix = `[GROUP ${date}]`;
  const force = options && options.force === true;
  let finalConfigs = configs;
  let offsetMs = null;

  console.log(
    `${logPrefix} Starting booking process for ${configs.length} accounts via Lambda.`,
  );

  // 1. 각 계정별 상태를 '접수'로 초기화
  for (const config of configs) {
    if (!force) {
      try {
        const existing = await Booking.findOne({ account: config.NAME, date });
        if (
          existing &&
          (existing.status === "성공" || existing.status === "실패")
        ) {
          console.log(
            `[${config.NAME}][${date}] Skip initializing status as it's already '${existing.status}'.`,
          );
          return null;
        }
      } catch (e) {
        console.warn(
          `[${config.NAME}][${date}] Failed to read existing status: ${e.message}`,
        );
      }
    }
    await updateBookingStatus(config.NAME, date, "접수", {
      startTime: config.START_TIME,
      endTime: config.END_TIME,
      successTime: null,
      bookedSlot: null,
    });
  }

  // 2. 예약 시간 10초 전까지 대기
  if (!options.immediate) {
    const bookingOpenTime = getBookingOpenTime(date);
    const invokeAt = bookingOpenTime.clone().subtract(35, "seconds");
    let now = moment().tz("Asia/Seoul");

    if (now.isBefore(invokeAt)) {
      const waitTime = invokeAt.diff(now);
      console.log(
        `${logPrefix} Waiting ${Math.round(
          waitTime / 1000,
        )}s until 35 seconds before booking time...`,
      );
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }
    console.log(
      `${logPrefix} It's 35 seconds to booking. Invoking Lambda functions...`,
    );

    // 오픈 10초 전: NTP로 시스템 시간 오프셋 계산 (그룹당 1회)
    try {
      const ntpTime = await getNtpTime();
      offsetMs = moment(ntpTime).diff(moment().tz("Asia/Seoul"));
      console.log(
        `${logPrefix} Using NTP offset for Lambda payload: ${offsetMs}ms`,
      );
    } catch (e) {
      console.warn(
        `${logPrefix} Failed to get NTP time for offset. Proceeding without offset: ${e.message}`,
      );
      offsetMs = null;
    }

    // 오픈 10초 전: MongoDB에서 최신 예약 정보를 다시 읽어와 실행 대상 계정을 재계산
    const activeUsers = await User.find({ granted: true }).select(
      "name debeachLoginId debeachLoginPassword",
    );
    const activeUserNames = activeUsers.map((u) => u.name);
    const accountMap = new Map(activeUsers.map((u) => [u.name, u]));

    const latestBookings = await Booking.find({
      account: { $in: activeUserNames },
      date,
      status: { $nin: ["성공", "실패"] },
    });

    const snapshotConfigs = latestBookings
      .map((booking) => {
        const account = accountMap.get(booking.account);
        if (!account) return null;
        if (!account.debeachLoginPassword) {
          console.warn(
            `[${booking.account}] 골프장 비밀번호가 설정되지 않아 예약을 건너뜁니다.`,
          );
          return null;
        }
        const plainPassword = looksEncryptedCredential(
          account.debeachLoginPassword,
        )
          ? decryptCredential(account.debeachLoginPassword)
          : account.debeachLoginPassword;
        return {
          NAME: booking.account,
          LOGIN_ID: account.debeachLoginId,
          LOGIN_PASSWORD: plainPassword,
          TARGET_DATE: booking.date,
          START_TIME: booking.startTime,
          END_TIME: booking.endTime,
        };
      })
      .filter(Boolean);

    if (snapshotConfigs.length === 0) {
      console.log(
        `${logPrefix} No booking configurations found from latest DB snapshot. Skipping Lambda invocation.`,
      );
      return;
    }

    console.log(
      `${logPrefix} Using latest DB snapshot for ${snapshotConfigs.length} account(s): ${snapshotConfigs.map((c) => c.NAME).join(", ")}`,
    );
    finalConfigs = snapshotConfigs;
  } else {
    console.log(
      `${logPrefix} Immediate execution. Invoking Lambda functions...`,
    );
  }

  // 2-1. 동일한 시간대(START_TIME/END_TIME 완전 일치) 계정들끼리는
  // 티 간격 7분을 기준으로 계정별로 7분씩 START/END를 밀어서
  // 첫 시도 시간대가 완전히 겹치지 않도록 보정
  const groupByTimeKey = new Map();
  for (const cfg of finalConfigs) {
    const key = `${cfg.START_TIME}-${cfg.END_TIME}`;
    if (!groupByTimeKey.has(key)) {
      groupByTimeKey.set(key, []);
    }
    groupByTimeKey.get(key).push(cfg);
  }

  for (const cfgs of groupByTimeKey.values()) {
    if (cfgs.length <= 1) continue;

    // 이름 기준 정렬로 계정 순서를 결정 (deterministic)
    cfgs.sort((a, b) => {
      const an = a.NAME || "";
      const bn = b.NAME || "";
      // 오수양은 항상 첫 번째
      if (an === "오수양") return -1;
      if (bn === "오수양") return 1;
      // 나머지는 START_TIME 순서로 정렬
      const aTime = a.START_TIME || "";
      const bTime = b.START_TIME || "";
      return aTime.localeCompare(bTime);
    });

    cfgs.forEach((cfg, index) => {
      if (index === 0) return; // 첫 계정은 원래 시간 유지

      const offsetMinutes = 7 * index; // 7분씩 증가 (슬롯 탐색 7분 간격)

      const parseHHmm = (hhmm) => {
        const h = parseInt(hhmm.slice(0, 2), 10);
        const m = parseInt(hhmm.slice(2, 4), 10);
        return { h, m };
      };

      const toHHmm = (h, m) => {
        const mmTotal = h * 60 + m;
        const clamped = Math.max(0, Math.min(23 * 60 + 59, mmTotal));
        const nh = Math.floor(clamped / 60);
        const nm = clamped % 60;
        return `${String(nh).padStart(2, "0")}${String(nm).padStart(2, "0")}`;
      };

      const s = parseHHmm(cfg.START_TIME.replace(":", ""));
      const e = parseHHmm(cfg.END_TIME.replace(":", ""));

      // START_TIME이 END_TIME보다 늦으면 역순 탐색 (예: 1000 -> 0800)
      const isReverseOrder = s.h * 60 + s.m > e.h * 60 + e.m;

      let startTotal, endTotal;
      if (isReverseOrder) {
        // 역순: START_TIME에서 시작하여 END_TIME으로 (늦은 시간 → 이른 시간)
        // 시작 시각을 벗어나지 않도록 START_TIME에서 offsetMinutes를 뺌
        startTotal = s.h * 60 + s.m - offsetMinutes;
        endTotal = e.h * 60 + e.m; // END_TIME은 고정
        console.log(
          `${logPrefix} ${cfg.NAME}: Reverse order mode (later → earlier): ${cfg.START_TIME} → ${cfg.END_TIME}`,
        );
      } else {
        // 정순: START_TIME에서 시작하여 END_TIME으로 (이른 시간 → 늦은 시간)
        // 시작 시각을 벗어나지 않도록 START_TIME에서 offsetMinutes를 더함
        startTotal = s.h * 60 + s.m + offsetMinutes;
        endTotal = e.h * 60 + e.m; // END_TIME은 고정
      }

      const newStart = toHHmm(0, startTotal);
      const newEnd = toHHmm(0, endTotal);

      cfg.START_TIME = newStart;
      cfg.END_TIME = newEnd;

      console.log(
        `${logPrefix} Adjusted time range for ${cfg.NAME}: ${cfg.START_TIME}~${cfg.END_TIME} (offset +${offsetMinutes}min)`,
      );
    });
  }

  // 2-2. 전체 계정에 걸쳐 전역 슬롯 인덱스 부여
  // 시간대가 달라도 가용 슬롯이 겹칠 경우 충돌을 방지하기 위해
  // 오수양을 첫 번째로, 나머지는 예약 설정 시각(START_TIME) 순서로 정렬
  {
    const globalSorted = [...finalConfigs].sort((a, b) => {
      const aN = a.NAME || "";
      const bN = b.NAME || "";
      // 오수양은 항상 첫 번째
      if (aN === "오수양") return -1;
      if (bN === "오수양") return 1;
      // 나머지는 START_TIME 순서로 정렬
      const aTime = a.START_TIME || "";
      const bTime = b.START_TIME || "";
      return aTime.localeCompare(bTime);
    });
    globalSorted.forEach((cfg, globalIdx) => {
      cfg.PRIMARY_SLOT_OFFSET = globalIdx;
      if (globalIdx > 0) {
        console.log(
          `${logPrefix} Global slot offset for ${cfg.NAME}: PRIMARY_SLOT_OFFSET=${globalIdx}, START_TIME=${cfg.START_TIME}`,
        );
      }
    });
  }

  // 3. 각 계정에 대해 순차적으로 Lambda 함수 호출 (staggered 방식)
  console.log(
    `${logPrefix} Will invoke ${finalConfigs.length} Lambda function(s) sequentially with stagger delay for: ${finalConfigs.map((c) => c.NAME).join(", ")}`,
  );

  // 시간 오프셋: 계정당 7분씩 (오수양 0분, 2번째 7분, 3번째 14분...)
  const TIME_OFFSET_MINUTES = 7;

  // Lambda 순차 호출 (자연스러운 stagger로 로그인 시차 발생)
  const LAMBDA_STAGGER_MS = 1000 + Math.floor(Math.random() * 1000);

  for (let i = 0; i < finalConfigs.length; i++) {
    const config = finalConfigs[i];
    const logName = config.NAME || config.LOGIN_ID;

    // Lambda 호출 stagger 적용 (로그인 자동 stagger됨)
    if (i > 0) {
      const staggerDelay = i * LAMBDA_STAGGER_MS;
      console.log(
        `[${logName}] Waiting ${staggerDelay}ms before invoking (stagger order: ${i + 1}/${finalConfigs.length})...`,
      );
      await new Promise((resolve) => setTimeout(resolve, staggerDelay));
    }

    // 로그인 stagger 없음 - Lambda 뜨면 바로 로그인 시작

    // 실행 직전 DB 상태 재확인: 취소/삭제/종료 상태면 로그인(람다 호출) 자체를 스킵
    if (!force) {
      try {
        const existing = await Booking.findOne({ account: config.NAME, date });
        if (!existing) {
          console.log(
            `[${logName}][${date}] Skip invoking Lambda because booking was deleted.`,
          );
          return null;
        }
        if (isTerminalStatus(existing.status)) {
          console.log(
            `[${logName}][${date}] Skip invoking Lambda because booking status is '${existing.status}'.`,
          );
          return null;
        }
      } catch (e) {
        console.warn(
          `[${logName}][${date}] Failed to re-check booking status before invoke: ${e.message}`,
        );
      }
    }

    console.log(
      `[${logName}] Invoking Lambda function synchronously... (START_TIME: ${config.START_TIME}, END_TIME: ${config.END_TIME}, PRIMARY_SLOT_OFFSET: ${config.PRIMARY_SLOT_OFFSET || 0})`,
    );

    const payload = {
      config,
      immediate: options.immediate || false,
      offsetMs,
      // loginStaggerMs 없음 - Lambda 뜨면 바로 로그인
    };

    const command = new InvokeCommand({
      FunctionName: LAMBDA_FUNCTION_NAME,
      InvocationType: "RequestResponse", // 동기 호출
      Payload: JSON.stringify(payload),
    });

    try {
      const response = await lambda.send(command);
      const result = JSON.parse(new TextDecoder().decode(response.Payload));
      console.log(`[${logName}] ✅ Lambda returned result:`, result);

      if (result.success) {
        const stats = result.stats || {};
        const wasUpdated = await updateBookingStatus(
          config.NAME,
          date,
          "성공",
          {
            successTime: moment().tz("Asia/Seoul").format(),
            bookedSlot: result.slot,
            teeTotal: stats.teeTotal,
            teeFirstHalf: stats.teeFirstHalf,
            teeSecondHalf: stats.teeSecondHalf,
            teeInRange: stats.teeInRange,
          },
        );

        if (Array.isArray(result.slots) && result.slots.length > 0) {
          await saveTeeSnapshot(result.slots, {
            roundDate: date,
          });
        }

        // Broadcast success to WebSocket clients
        if (wasUpdated) {
          try {
            const { broadcastLambdaResult } =
              await import("../web/backend/server.js");
            broadcastLambdaResult({
              type: "booking_success",
              account: config.NAME,
              date,
              slot: result.slot,
              stats,
            });
          } catch (wsError) {
            console.warn(
              `[${logName}] Failed to broadcast success via WebSocket:`,
              wsError.message,
            );
          }
        }
      } else {
        const stats = result.stats || {};
        const wasUpdated = await updateBookingStatus(
          config.NAME,
          date,
          "실패",
          {
            reason: result.reason || "Lambda에서 예약 실패",
            teeTotal: stats.teeTotal,
            teeFirstHalf: stats.teeFirstHalf,
            teeSecondHalf: stats.teeSecondHalf,
            teeInRange: stats.teeInRange,
          },
        );

        // Broadcast failure to WebSocket clients
        if (wasUpdated) {
          try {
            const { broadcastLambdaResult } =
              await import("../web/backend/server.js");
            broadcastLambdaResult({
              type: "booking_failure",
              account: config.NAME,
              date,
              reason: result.reason || "Lambda에서 예약 실패",
              stats,
            });
          } catch (wsError) {
            console.warn(
              `[${logName}] Failed to broadcast failure via WebSocket:`,
              wsError.message,
            );
          }
        }
      }
    } catch (error) {
      console.error(
        `[${logName}] 🚨 Failed to invoke or process Lambda response:`,
        error,
      );
      const wasUpdated = await updateBookingStatus(config.NAME, date, "실패", {
        reason: `Lambda 호출 오류: ${error.message}`,
      });

      // Broadcast error to WebSocket clients
      if (wasUpdated) {
        try {
          const { broadcastLambdaResult } =
            await import("../web/backend/server.js");
          broadcastLambdaResult({
            type: "booking_error",
            account: config.NAME,
            date,
            reason: `Lambda 호출 오류: ${error.message}`,
          });
        } catch (wsError) {
          console.warn(
            `[${logName}] Failed to broadcast error via WebSocket:`,
            wsError.message,
          );
        }
      }
    }
  }

  console.log(`${logPrefix} --- All Lambda invocations completed ---`);
}

function getBookingOpenTime(targetDateStr) {
  const targetDate = moment.tz(targetDateStr, "YYYYMMDD", "Asia/Seoul");
  const dayOfWeek = targetDate.day();
  let openTime = targetDate.clone().set({ hour: 0, minute: 0, second: 0 });

  if (dayOfWeek === 0) {
    openTime.add(10, "hours").subtract(11, "days");
  } // 일요일
  else if (dayOfWeek === 6) {
    openTime.add(10, "hours").subtract(10, "days");
  } // 토요일
  else {
    openTime.add(9, "hours").subtract(14, "days"); //.add(5, "minutes");
  } // 평일

  return openTime;
}

// 1분 전까지 대기하는 함수
async function waitForBookingReady(openTime, dateStr) {
  const oneMinuteBefore = openTime.clone().subtract(1, "minute");
  let now = moment().tz("Asia/Seoul");

  // 이미 1분 이내로 남았으면 바로 진행
  if (now.isAfter(oneMinuteBefore)) {
    console.log(
      `[WAIT ${dateStr}] Less than 1 minute to booking, proceeding to login.`,
    );
    return true;
  }

  while (moment().tz("Asia/Seoul").isBefore(oneMinuteBefore)) {
    const waitTimeMs = oneMinuteBefore.diff(moment().tz("Asia/Seoul"));
    const sleepTime = Math.min(waitTimeMs, 30000); // 최대 30초마다 체크
    console.log(
      `[WAIT ${dateStr}] Booking opens in ${Math.round(
        openTime.diff(moment().tz("Asia/Seoul")) / 1000,
      )}s. Waiting for ${sleepTime / 1000}s...`,
    );
    await new Promise((resolve) => setTimeout(resolve, sleepTime));
  }
  return true;
}

// 예약 시간까지 정밀 대기하는 함수
async function waitForBookingOpen(openTime, dateStr) {
  console.log(
    `[WAIT ${dateStr}] Starting precision wait. Booking open time: ${openTime.format()}`,
  );

  // 초기 NTP 시간 동기화 (한 번만)
  let ntpTime = await getNtpTime();
  let offset = moment(ntpTime).diff(moment().tz("Asia/Seoul"));
  let correctedTime = () => moment().tz("Asia/Seoul").add(offset, "ms");
  let waitTime = openTime.diff(correctedTime());

  if (waitTime <= 5) {
    console.log(
      `[WAIT ${dateStr}] Booking time has already passed. Proceeding immediately.`,
    );
  } else {
    // 5분 이상 남았으면 5분 전까지 대기
    if (waitTime > 300000) {
      const sleepUntilFiveMinBefore = waitTime - 300000; // 5분 전까지의 시간
      console.log(
        `[WAIT ${dateStr}] Booking opens in ${Math.round(
          waitTime / 1000,
        )}s. Sleeping until 5 minutes before...`,
      );
      await new Promise((resolve) =>
        setTimeout(resolve, sleepUntilFiveMinBefore),
      );

      // 5분 이내에 도달했으므로 NTP 재동기화 (한 번만)
      ntpTime = await getNtpTime();
      offset = moment(ntpTime).diff(moment().tz("Asia/Seoul"));
      waitTime = openTime.diff(correctedTime());
    }

    // 5분 이내: 정밀 대기
    while (waitTime > 5) {
      const sleepTime = Math.min(waitTime - 5, 5000); // 5초 또는 남은 시간
      if (sleepTime <= 0) break;

      console.log(
        `[WAIT ${dateStr}] Booking opens in ${Math.round(
          waitTime / 1000,
        )}s. Waiting for ${sleepTime / 1000}s...`,
      );
      await new Promise((resolve) => setTimeout(resolve, sleepTime));

      // 로컬 시간으로만 계산 (NTP 재동기화 없음)
      waitTime = openTime.diff(correctedTime());
    }
  }

  // 100um 더 대기
  await new Promise((resolve) => setTimeout(resolve, 100));
}

// 예약 상태를 파일에 저장/업데이트하는 함수
async function updateBookingStatus(name, date, status, bookingData = {}) {
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // 연결 상태 확인 (0: disconnected, 1: connected, 2: connecting, 3: disconnecting)
      if (mongoose.connection.readyState !== 1) {
        console.warn(
          `[DB] MongoDB not fully connected (state: ${mongoose.connection.readyState}). Retrying...`,
        );
      }
      const filter = { account: name, date: date };
      if (status === "실패") {
        filter.status = { $ne: "성공" };
      }
      const result = await Booking.updateOne(filter, {
        $set: { status, ...bookingData },
      });
      if (result.matchedCount === 0) {
        const existing = await Booking.findOne(
          { account: name, date: date },
          { status: 1 },
        );
        if (!existing) {
          console.log(
            `[DB] Skip status update for ${name} ${date} because booking no longer exists.`,
          );
        } else {
          console.log(
            `[DB] Skip '${status}' update for ${name} ${date} because booking is already '${existing.status}'.`,
          );
        }
        return false;
      }
      return true;
    } catch (error) {
      const wait = 300 * attempt;
      console.warn(
        `Retry ${attempt}/${maxRetries} updating booking status for ${name} ${date}: ${error.message}. Waiting ${wait}ms...`,
      );
      await new Promise((r) => setTimeout(r, wait));
      if (attempt === maxRetries) {
        console.error(
          `Failed to update booking status for ${name} on ${date} in DB after retries:`,
          error,
        );
      }
    }
  }
}

async function runAutoBooking(bookingRequests, options = { immediate: false }) {
  // Ensure DB is connected before proceeding
  await connectDB();

  // 1. DB에서 활성(granted: true) 사용자 목록을 먼저 가져옵니다.
  const activeUsers = await User.find({ granted: true }).select(
    "name debeachLoginId debeachLoginPassword",
  );
  const activeUserNames = activeUsers.map((u) => u.name);
  const accountMap = new Map(activeUsers.map((u) => [u.name, u]));

  // 2. 인자로 받은 bookingRequests가 있으면, 활성 사용자의 요청만 필터링합니다.
  if (bookingRequests && bookingRequests.length > 0) {
    const invalidAccounts = bookingRequests
      .filter((req) => !activeUserNames.includes(req.account))
      .map((req) => req.account);

    if (invalidAccounts.length > 0) {
      console.warn(
        `[SYSTEM] The following accounts are not active or do not exist, skipping: ${[
          ...new Set(invalidAccounts),
        ].join(", ")}`,
      );
    }
    bookingRequests = bookingRequests.filter((req) =>
      activeUserNames.includes(req.account),
    );
  } else {
    // 3. 인자가 없으면, 활성 사용자의 예약 요청만 DB에서 가져옵니다.
    const todayStr = moment().tz("Asia/Seoul").format("YYYYMMDD");
    bookingRequests = await Booking.find({
      account: { $in: activeUserNames },
      date: todayStr,
      status: { $nin: ["성공", "실패"] },
    });

    // 3-1. (Optional Cleanup) 활성 사용자가 아닌데 '접수' 상태인 예약을 '실패' 처리
    await Booking.updateMany(
      {
        account: { $nin: activeUserNames },
        date: todayStr,
        status: { $nin: ["성공", "실패"] },
      },
      {
        $set: {
          status: "실패",
          reason: "사용자가 비활성 상태이거나 삭제되었습니다.",
        },
      },
    );
  }

  if (bookingRequests.length === 0) {
    console.log("No valid bookings to process for active users.");
    return { result: "no-bookings" };
  }

  console.log(`Found ${bookingRequests.length} valid booking(s) to process.`);

  // 4. 예약 설정을 생성합니다.
  const configs = bookingRequests
    .map((booking) => {
      const account = accountMap.get(booking.account);
      if (!account) return null; // Should not happen due to earlier checks
      if (!account.debeachLoginPassword) {
        console.warn(
          `[${booking.account}] 골프장 비밀번호가 설정되지 않아 예약을 건너뜁니다.`,
        );
        return null;
      }
      const plainPassword = looksEncryptedCredential(
        account.debeachLoginPassword,
      )
        ? decryptCredential(account.debeachLoginPassword)
        : account.debeachLoginPassword;
      return {
        NAME: booking.account,
        LOGIN_ID: account.debeachLoginId,
        LOGIN_PASSWORD: plainPassword,
        TARGET_DATE: booking.date,
        START_TIME: booking.startTime,
        END_TIME: booking.endTime,
      };
    })
    .filter(Boolean);

  if (configs.length === 0) {
    console.log(
      "No booking configurations found from DB-backed user credentials.",
    );
    return { result: "no-configs" };
  }

  // 날짜별로 설정 그룹화
  const groups = configs.reduce((acc, config) => {
    const date = config.TARGET_DATE;
    if (!acc[date]) {
      acc[date] = { date, configs: [] };
    }
    acc[date].configs.push(config);
    return acc;
  }, {});

  // 각 그룹에 대해 병렬로 예약 프로세스 실행
  const groupPromises = Object.values(groups).map((group) =>
    runBookingGroup(group, options),
  );
  await Promise.all(groupPromises);

  console.log("\nAll booking tasks are complete.");
  return { result: "done", count: configs.length };
}

export { runAutoBooking, getBookingOpenTime };

// sudo pmset -a disablesleep 1 | caffeinate -u -i -dt 14400
