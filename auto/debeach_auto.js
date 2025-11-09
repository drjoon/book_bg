import axios from "axios";
import { CookieJar } from "tough-cookie";
import { wrapper as axiosCookieJarSupport } from "axios-cookiejar-support";
import ntpClient from "ntp-client";
import moment from "moment-timezone";
import * as cheerio from "cheerio";
import { Booking, AvailableSlot, User } from "../web/backend/models.js";
import mongoose from "mongoose";
import connectDB from "../web/backend/db.js";

connectDB();

async function getLoginToken(client) {
  const res = await client.get("https://www.debeach.co.kr/auth/login");
  const $ = cheerio.load(res.data);
  const token = $('meta[name="csrf-token"]').attr("content");
  console.log("✅ XSRF token:", token);
  return token;
}

async function doLogin(client, xsrfToken, loginId, loginPassword) {
  console.log("2) POST login...");

  const payload = new URLSearchParams({
    username: loginId, // 'login_id' -> 'username'
    password: loginPassword, // 'login_password' -> 'password'
    remember: "1",
    _token: xsrfToken,
  });

  const res = await client.post(
    "https://www.debeach.co.kr/auth/login",
    payload.toString(),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-XSRF-TOKEN": xsrfToken,
        Referer: "https://www.debeach.co.kr/auth/login",
      },
    }
  );

  // 로그인 성공 시 '/'로 리다이렉트되고, 실패 시 '/auth/login'에 머무름.
  // 최종 응답의 request.path로 성공 여부를 판별합니다.
  const isLoggedIn = res.request.path === "/";

  if (isLoggedIn) {
    console.log("✅ Login successful! Redirected to homepage.");
  } else {
    console.error("🚨 Login failed! Still on the login page.");
    console.log(`(Final path: ${res.request.path})`);
  }

  return isLoggedIn;
}

async function fetchBookingTimes(client, xsrfToken, dateStr) {
  console.log(`3) Fetch booking times for ${dateStr}...`);

  const res = await client.get(
    `https://www.debeach.co.kr/booking/time/${dateStr}`,
    {
      headers: {
        Accept: "application/json, text/plain, */*",
        "X-Requested-With": "XMLHttpRequest",
        "X-XSRF-TOKEN": xsrfToken,
        Referer: "https://www.debeach.co.kr/booking",
      },
    }
  );

  console.log("📅 booking response:", res.status);
  const slots = res.data;

  // Save to MongoDB
  if (slots && slots.length > 0) {
    const slotsWithDate = slots.map((slot) => ({ ...slot, date: dateStr }));
    await AvailableSlot.deleteMany({ date: dateStr }); // Clear old slots for the date
    await AvailableSlot.insertMany(slotsWithDate);
    console.log(
      `Saved ${slots.length} available slots for ${dateStr} to MongoDB.`
    );
  }

  return slots;
}

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
          err
        );
      }
    }
  }

  console.error("All NTP servers failed. Falling back to system time.");
  return new Date(); // 모든 시도 실패 시 시스템 시간 사용
};

function toMinutes(v) {
  if (v == null) return NaN;
  const str = String(v).trim();
  if (!str) return NaN;
  if (str.includes(":")) {
    const [h, m] = str.split(":");
    const hh = parseInt(h, 10);
    const mm = parseInt(m, 10);
    if (Number.isNaN(hh) || Number.isNaN(mm)) return NaN;
    return hh * 60 + mm;
  }
  if (/^\d{3,4}$/.test(str)) {
    const num = parseInt(str, 10);
    const hh = Math.floor(num / 100);
    const mm = num % 100;
    return hh * 60 + mm;
  }
  if (/^\d{1,2}$/.test(str)) {
    const hh = parseInt(str, 10);
    return hh * 60;
  }
  const n = parseInt(str, 10);
  if (Number.isNaN(n)) return NaN;
  if (n < 24) return n * 60;
  const hh = Math.floor(n / 100);
  const mm = n % 100;
  return hh * 60 + mm;
}

// 단일 예약 시도를 처리하는 함수
async function attemptBooking(account, targetSlot) {
  const { client, token, config } = account;
  const logPrefix = `[${config.NAME || config.LOGIN_ID}]`;

  try {
    // 0~100ms 사이의 무작위 지연 추가
    const randomDelay = Math.floor(Math.random() * 101);
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
      `${logPrefix} 🎉 Successfully booked time: ${targetSlot.bk_time} on course ${targetSlot.bk_cours}`
    );

    // 상태 파일 '성공'으로 업데이트
    const successTime = moment().tz("Asia/Seoul").format();
    await updateBookingStatus(config.NAME, config.TARGET_DATE, "성공", {
      successTime: successTime,
      bookedSlot: targetSlot,
    });

    return { success: true, slot: targetSlot };
  } catch (error) {
    if (error.response && error.response.status === 422) {
      console.log(
        `${logPrefix} ⚠️ Slot ${targetSlot.bk_time} was taken. Retrying with another slot...`
      );
    } else if (error.response && error.response.status === 429) {
      console.log(
        `${logPrefix} ⏳ Received 429 (Too Many Requests). Retrying after 1s...`
      );
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return await attemptBooking(account, targetSlot); // 동일 슬롯으로 재시도
    } else {
      console.error(
        `${logPrefix} ❌ An unexpected error occurred while booking ${targetSlot.bk_time}:`,
        error.message
      );
    }
    return { success: false, slot: targetSlot };
  }
}

// 특정 날짜 그룹에 대한 전체 예약 과정을 관리하는 함수
async function runBookingGroup(group, options) {
  const { date, configs } = group;
  const logPrefix = `[GROUP ${date}]`;
  const force = options && options.force === true;

  console.log(
    `${logPrefix} Starting booking process for ${configs.length} accounts.`
  );

  // 각 계정별 상태 초기화
  for (const config of configs) {
    if (!force) {
      try {
        const existing = await Booking.findOne({ account: config.NAME, date });
        if (
          existing &&
          (existing.status === "성공" || existing.status === "실패")
        ) {
          console.log(
            `[${config.NAME}][${date}] Skip initializing status as it's already '${existing.status}'.`
          );
          continue;
        }
      } catch (e) {
        console.warn(
          `[${config.NAME}][${date}] Failed to read existing status: ${e.message}`
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

  // For queued jobs, wait for the precise time. For immediate jobs, skip waiting.
  if (!options.immediate) {
    const bookingOpenTime = getBookingOpenTime(date);
    await waitForBookingReady(bookingOpenTime, date);
    console.log(
      `${logPrefix} It's 1 minute to booking. Logging in all accounts...`
    );
  } else {
    console.log(`${logPrefix} Immediate execution. Logging in accounts...`);
  }

  // 2. 로그인
  const accounts = [];
  for (const config of configs) {
    const bookingStatus = await Booking.findOne({
      account: config.NAME,
      date: date,
    });
    if (!force) {
      if (
        bookingStatus &&
        (bookingStatus.status === "성공" || bookingStatus.status === "실패")
      ) {
        console.log(
          `[${config.NAME}][${date}] ⏭️ Skipping login as status is '${bookingStatus.status}'.`
        );
        continue;
      }
    }

    const jar = new CookieJar();
    const client = axiosCookieJarSupport(
      axios.create({
        jar,
        withCredentials: true,
        headers: { "User-Agent": "Mozilla/5.0" },
      })
    );
    const logName = config.NAME || config.LOGIN_ID;

    client.interceptors.request.use((request) => {
      console.log(
        `[${logName}][${moment()
          .tz("Asia/Seoul")
          .format()}] ==> ${request.method.toUpperCase()} ${request.url}`
      );
      return request;
    });
    client.interceptors.response.use(
      (response) => {
        console.log(
          `[${logName}][${moment().tz("Asia/Seoul").format()}] <== ${
            response.status
          } ${response.config.url}`
        );
        return response;
      },
      (error) => {
        if (error.response) {
          console.error(
            `[${logName}][${moment().tz("Asia/Seoul").format()}] <== ${
              error.response.status
            } ${error.response.config.url}`
          );
        } else {
          console.error(
            `[${logName}][${moment().tz("Asia/Seoul").format()}] <== ERROR ${
              error.config ? error.config.url : "N/A"
            } (${error.message})`
          );
        }
        return Promise.reject(error);
      }
    );

    try {
      const token = await getLoginToken(client);
      const isLoggedIn = await doLogin(
        client,
        token,
        config.LOGIN_ID,
        config.LOGIN_PASSWORD
      );
      if (isLoggedIn) {
        console.log(`[${logName}] ✅ Login successful.`);
        accounts.push({ client, token, config });
      } else {
        console.error(`[${logName}] 🚨 Login failed.`);
        await updateBookingStatus(config.NAME, date, "실패", {
          reason: "로그인 실패",
        });
      }
    } catch (error) {
      console.error(
        `[${logName}] 🚨 An error occurred during login:`,
        error.message
      );
      await updateBookingStatus(config.NAME, date, "실패", {
        reason: "로그인 중 오류 발생",
      });
    }
  }

  if (accounts.length === 0) {
    console.log(
      `${logPrefix} No accounts were successfully logged in. Aborting booking for this group.`
    );
    return;
  }

  // 3. 예약 시간까지 정밀 대기 (큐 실행 시에만)
  if (!options.immediate) {
    const bookingOpenTime = getBookingOpenTime(date);
    await waitForBookingOpen(bookingOpenTime, date);
  }

  // 4. 슬롯은 계정별로 개별 LIVE 조회 (동시 실행)

  // 5. 각 계정에 대해 병렬로 예약 시도
  const bookingPromises = accounts.map((account) => {
    return (async () => {
      const { config } = account;
      const logName = config.NAME || config.LOGIN_ID;

      // 계정별 LIVE 슬롯 조회
      let availableTimes = [];
      try {
        availableTimes = await fetchBookingTimes(
          account.client,
          account.token,
          date
        );
      } catch (e) {
        console.warn(`[${logName}] Live fetch failed: ${e.message}`);
        availableTimes = [];
      }
      console.log(
        `[${logName}] Using ${availableTimes.length} available slots (source: LIVE), sample: ${availableTimes
          .slice(0, 6)
          .map((x) => x.bk_time)
          .join(',')}`
      );

      // 해당 계정의 설정(START_TIME, END_TIME)에 맞는 슬롯 필터링
      const startMin = toMinutes(config.START_TIME);
      const endMin = toMinutes(config.END_TIME);
      const s = startMin <= endMin ? startMin : endMin;
      const e = startMin <= endMin ? endMin : startMin;
      const descending = startMin > endMin;

      console.log(
        `[${logName}] Range(min): ${s}-${e}, available: ${availableTimes.length}, sample: ${availableTimes
          .slice(0, 6)
          .map((x) => x.bk_time)
          .join(',')}`
      );

      const targetTimes = availableTimes.filter((slot) => {
        const slotMin = toMinutes(slot.bk_time);
        if (Number.isNaN(slotMin) || Number.isNaN(s) || Number.isNaN(e)) return false;
        return slotMin >= s && slotMin <= e;
      });

      targetTimes.sort((a, b) => {
        const am = toMinutes(a.bk_time);
        const bm = toMinutes(b.bk_time);
        return descending ? bm - am : am - bm;
      });

      if (targetTimes.length > 0) {
        console.log(
          `[${logName}] Direction: ${descending ? 'DESC' : 'ASC'}, first pick: ${targetTimes[0].bk_time}, last: ${targetTimes[targetTimes.length - 1].bk_time}`
        );
      }

      if (targetTimes.length === 0) {
        console.log(
          `${logPrefix} [${logName}] No available slots in the desired time range.`
        );
        await updateBookingStatus(config.NAME, date, "실패", {
          reason: "원하는 시간대 없음",
        });
        return;
      }

      if (targetTimes.length === 0) {
        console.log(
          `[${logName}] 🟡 No available slots in the desired time range (${config.START_TIME}-${config.END_TIME}).`
        );
        await updateBookingStatus(config.NAME, date, "실패", {
          reason: "원하는 시간대 없음",
        });
        return;
      }

      console.log(
        `[${logName}] 🎯 Found ${targetTimes.length} target slots. Trying to book...`
      );

      // 첫 번째 슬롯부터 순차적으로 시도
      for (const targetSlot of targetTimes) {
        const result = await attemptBooking(account, targetSlot);
        if (result.success) {
          return; // 성공 시 이 계정의 예약 시도 중단
        }
      }

      // 모든 슬롯 시도 실패
      console.log(
        `[${logName}] ❌ All attempts failed for the available slots.`
      );
      await updateBookingStatus(config.NAME, date, "실패", {
        reason: "모든 슬롯 예약 실패",
      });
    })();
  });

  await Promise.all(bookingPromises);

  console.log(`${logPrefix} --- Booking process finished ---`);
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
    openTime.add(9, "hours").subtract(14, "days");
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
      `[WAIT ${dateStr}] Less than 1 minute to booking, proceeding to login.`
    );
    return true;
  }

  while (moment().tz("Asia/Seoul").isBefore(oneMinuteBefore)) {
    const waitTimeMs = oneMinuteBefore.diff(moment().tz("Asia/Seoul"));
    const sleepTime = Math.min(waitTimeMs, 30000); // 최대 30초마다 체크
    console.log(
      `[WAIT ${dateStr}] Booking opens in ${Math.round(
        openTime.diff(moment().tz("Asia/Seoul")) / 1000
      )}s. Waiting for ${sleepTime / 1000}s...`
    );
    await new Promise((resolve) => setTimeout(resolve, sleepTime));
  }
  return true;
}

// 예약 시간까지 정밀 대기하는 함수
async function waitForBookingOpen(openTime, dateStr) {
  console.log(
    `[WAIT ${dateStr}] Starting precision wait. Booking open time: ${openTime.format()}`
  );

  // 초기 NTP 시간 동기화 (한 번만)
  let ntpTime = await getNtpTime();
  let offset = moment(ntpTime).diff(moment().tz("Asia/Seoul"));
  let correctedTime = () => moment().tz("Asia/Seoul").add(offset, "ms");
  let waitTime = openTime.diff(correctedTime());

  if (waitTime <= 5) {
    console.log(
      `[WAIT ${dateStr}] Booking time has already passed. Proceeding immediately.`
    );
  } else {
    // 5분 이상 남았으면 5분 전까지 대기
    if (waitTime > 300000) {
      const sleepUntilFiveMinBefore = waitTime - 300000; // 5분 전까지의 시간
      console.log(
        `[WAIT ${dateStr}] Booking opens in ${Math.round(
          waitTime / 1000
        )}s. Sleeping until 5 minutes before...`
      );
      await new Promise((resolve) =>
        setTimeout(resolve, sleepUntilFiveMinBefore)
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
          waitTime / 1000
        )}s. Waiting for ${sleepTime / 1000}s...`
      );
      await new Promise((resolve) => setTimeout(resolve, sleepTime));

      // 로컬 시간으로만 계산 (NTP 재동기화 없음)
      waitTime = openTime.diff(correctedTime());
    }
  }

  console.log(`[WAIT ${dateStr}] Booking time! Applying 300ms delay...`);
  await new Promise((resolve) => setTimeout(resolve, 300));
}

async function selectAndConfirmBooking(
  client,
  xsrfToken, // 세션 XSRF 토큰
  timeSlot,
  // peopleCount, // HTML에서 파싱하므로 제거
  dateStr
) {
  // 1. 예약 시간 선택 및 토큰 추출
  console.log(
    `4) Selecting time and preparing to confirm: ${timeSlot.bk_time} on course ${timeSlot.bk_cours}...`
  );
  const { bk_cours: cours, bk_time: time, bk_hole: hole } = timeSlot;
  const createUrl = `https://www.debeach.co.kr/booking/create?date=${dateStr}&cours=${cours}&time=${time}&hole=${hole}`;

  const createRes = await client.get(createUrl, {
    headers: {
      Accept: "*/*",
      "X-Requested-With": "XMLHttpRequest",
      "X-XSRF-TOKEN": xsrfToken,
      Referer: "https://www.debeach.co.kr/booking",
    },
  });

  const $ = cheerio.load(createRes.data);
  const bookingToken = $('form#form-create input[name="_token"]').val();
  const peopleCount = $('form#form-create input[name="incnt"]:checked').val();

  if (!bookingToken) {
    console.error("🚨 Could not find booking token. Skipping slot.");
    // 이 경우, 루프에서 다음 슬롯으로 넘어가도록 null을 반환하거나 에러를 던지지 않음
    return;
  }
  console.log(`✅ Got booking token: ${bookingToken}`);

  // 브라우저의 confirm 창과 유사한 지연을 주기 위해 1초 대기
  console.log("⏳ Simulating user confirmation delay (1s)...");
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // 2. 예약 확정 요청
  if (!peopleCount) {
    console.error(
      "🚨 Could not find checked people count (incnt). Skipping slot."
    );
    return;
  }
  console.log(`✅ Parsed people count: ${peopleCount}`);

  console.log(`5) Confirming booking for ${peopleCount} people...`);
  const payload = new URLSearchParams();
  payload.append("_token", bookingToken);
  payload.append("date", dateStr);
  payload.append("cours", cours);
  payload.append("time", time);
  payload.append("hole", hole);
  payload.append("incnt", peopleCount);
  payload.append("booking_agree", "0");
  payload.append("booking_agree", "1");

  const confirmRes = await client.post(
    "https://www.debeach.co.kr/booking",
    payload.toString(),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
        "X-XSRF-TOKEN": xsrfToken,
        Referer: "https://www.debeach.co.kr/booking",
      },
      validateStatus: (status) => status >= 200 && status < 400, // 422를 에러로 처리
    }
  );

  console.log("✅ Booking confirmation response:", confirmRes.status);
  console.log("📋 Response data:", confirmRes.data);

  // `redirect` 키가 있으면 성공으로 간주
  if (confirmRes.data && confirmRes.data.redirect) {
    console.log(
      `🎉🎉🎉 Booking successful! Message: ${confirmRes.data.message} 🎉🎉🎉`
    );
  } else {
    const errorMessage =
      (confirmRes.data && confirmRes.data.message) ||
      "Booking failed for an unknown reason.";
    console.error(`🚨 Booking failed: ${errorMessage}`);
    throw new Error(errorMessage);
  }
}

// 예약 상태를 파일에 저장/업데이트하는 함수
async function updateBookingStatus(name, date, status, bookingData = {}) {
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // 연결 상태 확인 (0: disconnected, 1: connected, 2: connecting, 3: disconnecting)
      if (mongoose.connection.readyState !== 1) {
        console.warn(
          `[DB] MongoDB not fully connected (state: ${mongoose.connection.readyState}). Retrying...`
        );
      }
      await Booking.updateOne(
        { account: name, date: date },
        { $set: { status, ...bookingData } },
        { upsert: true }
      );
      return;
    } catch (error) {
      const wait = 300 * attempt;
      console.warn(
        `Retry ${attempt}/${maxRetries} updating booking status for ${name} ${date}: ${error.message}. Waiting ${wait}ms...`
      );
      await new Promise((r) => setTimeout(r, wait));
      if (attempt === maxRetries) {
        console.error(
          `Failed to update booking status for ${name} on ${date} in DB after retries:`,
          error
        );
      }
    }
  }
}

async function runAutoBooking(bookingRequests, options = { immediate: false }) {
  // If no specific requests, fetch from DB for today
  if (!bookingRequests || bookingRequests.length === 0) {
    const todayStr = moment().tz("Asia/Seoul").format("YYYYMMDD");
    bookingRequests = await Booking.find({
      date: todayStr,
      status: { $nin: ["성공", "실패"] },
    });
  }

  if (bookingRequests.length === 0) {
    console.log("No bookings to process for today.");
    return { result: "no-bookings" };
  }

  console.log(`Found ${bookingRequests.length} booking(s) to process.`);

  // Fetch account details for the bookings
  const accountNames = [...new Set(bookingRequests.map((b) => b.account))];
  const accounts = await User.find({ name: { $in: accountNames } }).select(
    "name username golfPassword"
  );
  const accountMap = new Map(
    accounts.map((account) => [account.name, account])
  );

  const configs = bookingRequests
    .map((booking) => {
      const account = accountMap.get(booking.account);
      if (!account) return null; // Skip if account not found
      if (!account.golfPassword) {
        console.warn(
          `[${booking.account}] 골프장 비밀번호가 설정되지 않아 예약을 건너뜁니다.`
        );
        return null;
      }
      return {
        NAME: booking.account,
        LOGIN_ID: account.username,
        LOGIN_PASSWORD: account.golfPassword,
        TARGET_DATE: booking.date,
        START_TIME: booking.startTime,
        END_TIME: booking.endTime,
      };
    })
    .filter(Boolean); // Filter out nulls

  if (configs.length === 0) {
    console.log("No booking configurations found in .env file.");
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
    runBookingGroup(group, options)
  );
  await Promise.all(groupPromises);

  console.log("\nAll booking tasks are complete.");
  return { result: "done", count: configs.length };
}

export { runAutoBooking, getBookingOpenTime };
