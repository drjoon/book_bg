import axios from "axios";
import { CookieJar } from "tough-cookie";
import { wrapper as axiosCookieJarSupport } from "axios-cookiejar-support";
import ntpClient from "ntp-client";
import moment from "moment-timezone";
import * as cheerio from "cheerio";
import fs from 'fs';

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
  return res.data;
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
        console.warn(`NTP Error with ${server} (Attempt ${i + 1}/${MAX_NTP_RETRIES}):`, err);
      }
    }
  }

  console.error("All NTP servers failed. Falling back to system time.");
  return new Date(); // 모든 시도 실패 시 시스템 시간 사용
};

// 단일 예약 시도를 처리하는 함수
async function attemptBooking(account, targetSlot) {
  const { client, token, config } = account;
  const logPrefix = `[${config.NAME || config.LOGIN_ID}]`;

  try {
    // 0~100ms 사이의 무작위 지연 추가
    const randomDelay = Math.floor(Math.random() * 101);
    await new Promise(resolve => setTimeout(resolve, randomDelay));

    console.log(`${logPrefix} ➡️ Trying to book time: ${targetSlot.bk_time} on course ${targetSlot.bk_cours} (delay: ${randomDelay}ms)`);
    await selectAndConfirmBooking(client, token, targetSlot, config.TARGET_DATE);
    console.log(`${logPrefix} 🎉 Successfully booked time: ${targetSlot.bk_time} on course ${targetSlot.bk_cours}`);

    // 상태 파일 '성공'으로 업데이트
    const successTime = moment().tz("Asia/Seoul").format();
    await updateBookingStatus(config.NAME, config.TARGET_DATE, '성공', {
      successTime: successTime,
      bookedSlot: targetSlot,
    });

    return { success: true, slot: targetSlot };
  } catch (error) {
    if (error.response && error.response.status === 422) {
      console.log(`${logPrefix} ⚠️ Slot ${targetSlot.bk_time} was taken. Retrying with another slot...`);
    } else if (error.response && error.response.status === 429) {
      console.log(`${logPrefix} ⏳ Received 429 (Too Many Requests). Retrying after 1s...`);
      await new Promise(resolve => setTimeout(resolve, 1000));
      return await attemptBooking(account, targetSlot); // 동일 슬롯으로 재시도
    } else {
      console.error(`${logPrefix} ❌ An unexpected error occurred while booking ${targetSlot.bk_time}:`, error.message);
    }
    return { success: false, slot: targetSlot };
  }
}

// 특정 날짜 그룹에 대한 전체 예약 과정을 관리하는 함수
async function runBookingGroup(group) {
  const { date, configs } = group;
  const logPrefix = `[GROUP ${date}]`;

  console.log(`${logPrefix} Starting booking process for ${configs.length} accounts.`);

  // 각 계정별로 상태 파일 생성 및 '접수' 상태로 초기화
  for (const config of configs) {
    await updateBookingStatus(config.NAME, date, '접수', {
      startTime: config.START_TIME,
      endTime: config.END_TIME,
      successTime: null,
      bookedSlot: null,
    });
  }

  // 1. 예약 오픈 1분 전까지 대기
  const bookingOpenTime = getBookingOpenTime(date);
  await waitForBookingReady(bookingOpenTime, date);

  // 2. 모든 계정 로그인
  console.log(`${logPrefix} It's 1 minute to booking. Logging in all accounts...`);
  const accounts = [];
  for (const config of configs) {
    const statusFilePath = `${BOOKLIST_DIR}/${config.NAME}/${date}.json`;
    if (fs.existsSync(statusFilePath)) {
      const statusData = JSON.parse(fs.readFileSync(statusFilePath, 'utf-8'));
      if (statusData.status === '성공' || statusData.status === '실패') {
        console.log(`[${config.NAME}][${date}] ⏭️ Skipping login as status is '${statusData.status}'.`);
        continue;
      }
    }

    const jar = new CookieJar();
    const client = axiosCookieJarSupport(axios.create({ jar, withCredentials: true, headers: { 'User-Agent': 'Mozilla/5.0' } }));
    const logName = config.NAME || config.LOGIN_ID;

    client.interceptors.request.use(request => {
      console.log(`[${logName}][${moment().tz("Asia/Seoul").format()}] ==> ${request.method.toUpperCase()} ${request.url}`);
      return request;
    });
    client.interceptors.response.use(response => {
      console.log(`[${logName}][${moment().tz("Asia/Seoul").format()}] <== ${response.status} ${response.config.url}`);
      return response;
    }, error => {
      if (error.response) {
        console.error(`[${logName}][${moment().tz("Asia/Seoul").format()}] <== ${error.response.status} ${error.response.config.url}`);
      } else {
        console.error(`[${logName}][${moment().tz("Asia/Seoul").format()}] <== ERROR ${error.config ? error.config.url : 'N/A'} (${error.message})`);
      }
      return Promise.reject(error);
    });

    try {
      const token = await getLoginToken(client);
      const isLoggedIn = await doLogin(client, token, config.LOGIN_ID, config.LOGIN_PASSWORD);
      if (isLoggedIn) {
        console.log(`[${logName}] ✅ Login successful.`);
        accounts.push({ client, token, config });
      } else {
        console.error(`[${logName}] 🚨 Login failed.`);
        await updateBookingStatus(config.NAME, date, '실패', { reason: '로그인 실패' });
      }
    } catch (error) {
      console.error(`[${logName}] 🚨 An error occurred during login:`, error.message);
      await updateBookingStatus(config.NAME, date, '실패', { reason: '로그인 중 오류 발생' });
    }
  }

  if (accounts.length === 0) {
    console.log(`${logPrefix} No accounts were successfully logged in. Aborting booking for this group.`);
    return;
  }

  // 3. 예약 시간까지 정밀 대기
  await waitForBookingOpen(bookingOpenTime, date);

  // 3. 각 계정에 대해 병렬로 예약 시도
  const bookingPromises = accounts.map(account => {
    return (async () => {
      const { config } = account;
      const logName = config.NAME || config.LOGIN_ID;

      // 각 계정별로 예약 가능한 시간을 독립적으로 조회
      let allAvailableTimes;
      try {
        allAvailableTimes = await fetchBookingTimes(account.client, account.token, date);
      } catch (e) {
        console.error(`[${logName}] ❌ Failed to fetch booking times:`, e.message);
        await updateBookingStatus(config.NAME, date, '실패', { reason: '시간 조회 실패' });
        return;
      }

      if (!allAvailableTimes || allAvailableTimes.length === 0) {
        console.log(`[${logName}] 🔴 No available time slots found.`);
        await updateBookingStatus(config.NAME, date, '실패', { reason: '예약 가능 시간 없음' });
        return;
      }

      // 해당 계정의 설정(START_TIME, END_TIME)에 맞는 슬롯 필터링
      const targetTimes = allAvailableTimes.filter(slot => {
        const slotTime = parseInt(slot.bk_time, 10);
        const startTime = parseInt(config.START_TIME, 10);
        const endTime = parseInt(config.END_TIME, 10);
        return slotTime >= startTime && slotTime <= endTime;
      });

      if (targetTimes.length === 0) {
        console.log(`[${logName}] 🟡 No available slots in the desired time range (${config.START_TIME}-${config.END_TIME}).`);
        await updateBookingStatus(config.NAME, date, '실패', { reason: '원하는 시간대 없음' });
        return;
      }

      console.log(`[${logName}] 🎯 Found ${targetTimes.length} target slots. Trying to book...`);

      // 첫 번째 슬롯부터 순차적으로 시도
      for (const targetSlot of targetTimes) {
        const result = await attemptBooking(account, targetSlot);
        if (result.success) {
          return; // 성공 시 이 계정의 예약 시도 중단
        }
      }

      // 모든 슬롯 시도 실패
      console.log(`[${logName}] ❌ All attempts failed for the available slots.`);
      await updateBookingStatus(config.NAME, date, '실패', { reason: '모든 슬롯 예약 실패' });
    })();
  });

  await Promise.all(bookingPromises);

  console.log(`${logPrefix} --- Booking process finished ---`);
}

function getBookingOpenTime(targetDateStr) {
  const targetDate = moment.tz(targetDateStr, "YYYYMMDD", "Asia/Seoul");
  const dayOfWeek = targetDate.day();
  let openTime = targetDate.clone().set({ hour: 0, minute: 0, second: 0 });

  if (dayOfWeek === 0) { openTime.add(10, 'hours').subtract(11, 'days'); } // 일요일
  else if (dayOfWeek === 6) { openTime.add(10, 'hours').subtract(10, 'days'); } // 토요일
  else { openTime.add(9, 'hours').subtract(14, 'days'); } // 평일

  return openTime;
}

// 1분 전까지 대기하는 함수
async function waitForBookingReady(openTime, dateStr) {
  const oneMinuteBefore = openTime.clone().subtract(1, 'minute');
  let now = moment();

  // 이미 1분 이내로 남았으면 바로 진행
  if (now.isAfter(oneMinuteBefore)) {
    console.log(`[WAIT ${dateStr}] Less than 1 minute to booking, proceeding to login.`);
    return true;
  }

  while (moment().isBefore(oneMinuteBefore)) {
    const waitTimeMs = oneMinuteBefore.diff(moment());
    const sleepTime = Math.min(waitTimeMs, 30000); // 최대 30초마다 체크
    console.log(`[WAIT ${dateStr}] Booking opens in ${Math.round(openTime.diff(moment())/1000)}s. Waiting for ${sleepTime/1000}s...`);
    await new Promise(resolve => setTimeout(resolve, sleepTime));
  }
  return true;
}

// 예약 시간까지 정밀 대기하는 함수
async function waitForBookingOpen(openTime, dateStr) {
  console.log(`[WAIT ${dateStr}] Starting precision wait. Booking open time: ${openTime.format()}`);

  let ntpTime = await getNtpTime();
  let offset = moment(ntpTime).diff(moment());
  let correctedTime = () => moment().add(offset, 'ms');
  let waitTime = openTime.diff(correctedTime());

  if (waitTime <= 5) {
    console.log(`[WAIT ${dateStr}] Booking time has already passed. Proceeding immediately.`);
  } else {
    while (waitTime > 5) {
      const sleepTime = Math.min(waitTime - 5, 5000); // 5초 또는 남은 시간
      if (sleepTime <= 0) break;

      console.log(`[WAIT ${dateStr}] Booking opens in ${Math.round(waitTime / 1000)}s. Waiting for ${sleepTime / 1000}s...`);
      await new Promise(resolve => setTimeout(resolve, sleepTime));

      // 루프마다 시간 재동기화
      ntpTime = await getNtpTime();
      offset = moment(ntpTime).diff(moment());
      waitTime = openTime.diff(correctedTime());
    }
  }

  console.log(`[WAIT ${dateStr}] Booking time! Applying 300ms delay...`);
  await new Promise(resolve => setTimeout(resolve, 300));
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
  await new Promise(resolve => setTimeout(resolve, 1000));

  // 2. 예약 확정 요청
  if (!peopleCount) {
    console.error("🚨 Could not find checked people count (incnt). Skipping slot.");
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
    console.log(`🎉🎉🎉 Booking successful! Message: ${confirmRes.data.message} 🎉🎉🎉`);
  } else {
    const errorMessage = (confirmRes.data && confirmRes.data.message) || "Booking failed for an unknown reason.";
    console.error(`🚨 Booking failed: ${errorMessage}`);
    throw new Error(errorMessage);
  }
}

const BOOKLIST_DIR = './booklist';

// 예약 상태를 파일에 저장/업데이트하는 함수
async function updateBookingStatus(accountName, date, status, accountData = {}) {
  const accountDir = `${BOOKLIST_DIR}/${accountName}`;
  if (!fs.existsSync(accountDir)) {
    fs.mkdirSync(accountDir, { recursive: true });
  }
  const filePath = `${accountDir}/${date}.json`;

  let currentData = {};
  if (fs.existsSync(filePath)) {
    try {
      currentData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (e) {
      console.error(`Error reading or parsing status file ${filePath}:`, e);
    }
  }

  // status가 제공될 때만 newData에 status를 포함시킴
  const updatePayload = status ? { status, ...accountData } : accountData;
  const newData = { ...currentData, ...updatePayload };

  fs.writeFileSync(filePath, JSON.stringify(newData, null, 2));
}

async function main() {
  const allConfigs = JSON.parse(fs.readFileSync('./booking_configs.json', 'utf-8'));

  // 오늘 예약해야 할 설정만 필터링
  const today = moment().tz('Asia/Seoul');
  const configsToBookToday = allConfigs.filter(config => {
    const openTime = getBookingOpenTime(config.TARGET_DATE);
    return openTime.isSame(today, 'day');
  });

  if (configsToBookToday.length === 0) {
    console.log(`No bookings to be made today (${today.format('YYYY-MM-DD')}).`);
    return;
  }

  console.log(`Found ${configsToBookToday.length} booking(s) to be made today.`);

  const configs = configsToBookToday.filter(config => {
    const { NAME, TARGET_DATE } = config;
    const statusFilePath = `${BOOKLIST_DIR}/${NAME}/${TARGET_DATE}.json`;

    if (fs.existsSync(statusFilePath)) {
      try {
        const statusData = JSON.parse(fs.readFileSync(statusFilePath, 'utf-8'));
        if (statusData.status === '성공' || statusData.status === '실패') {
          console.log(`[${NAME}][${TARGET_DATE}] ⏭️ Already processed with status '${statusData.status}'. Skipping.`);
          return false; // 이미 처리되었으므로 필터링
        }
      } catch (e) {
        console.error(`Error reading status for ${NAME} on ${TARGET_DATE}. Proceeding anyway...`, e);
      }
    }
    return true; // 처리해야 할 예약
  });

  if (configs.length === 0) {
    console.log("No booking configurations found in .env file.");
    return;
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
  const groupPromises = Object.values(groups).map(group => runBookingGroup(group));
  await Promise.all(groupPromises);

  console.log("\nAll booking tasks are complete.");
}

main().catch(console.error);
