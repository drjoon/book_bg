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

// NTP 시간 동기화 함수
const getNtpTime = () => {
  return new Promise((resolve, reject) => {
    ntpClient.getNetworkTime("time.apple.com", 123, (err, date) => {
      if (err) {
        console.warn(`NTP Error: ${err.message}. Falling back to system time.`);
        resolve(new Date()); // NTP 실패 시 시스템 시간 사용
      } else {
        console.log("NTP time synchronized:", date);
        resolve(date);
      }
    });
  });
};

// 단일 예약 시도를 처리하는 함수
async function attemptBooking(account, targetSlot) {
  const { client, token, config } = account;
  const logPrefix = `[${config.NAME || config.LOGIN_ID}]`;

  try {
    console.log(`${logPrefix} ➡️ Trying to book time: ${targetSlot.bk_time} on course ${targetSlot.bk_cours}`);
    await selectAndConfirmBooking(client, token, targetSlot, config.TARGET_DATE);
    console.log(`${logPrefix} 🎉 Successfully booked time: ${targetSlot.bk_time} on course ${targetSlot.bk_cours}`);
    return { success: true, slot: targetSlot };
  } catch (error) {
    if (error.response && error.response.status === 422) {
      console.log(`${logPrefix} ⚠️ Slot ${targetSlot.bk_time} was taken. Retrying with another slot...`);
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

  // 1. 모든 계정 순차 로그인 (서버 부하 방지)
  const accounts = [];
  for (const config of configs) {
    const jar = new CookieJar();
    // 각 계정별로 독립적인 axios 인스턴스 생성
    const client = axiosCookieJarSupport(axios.create({ jar, withCredentials: true, headers: { 'User-Agent': 'Mozilla/5.0' } }));
    const logName = config.NAME || config.LOGIN_ID;
    // Axios 인터셉터 추가 (각 인스턴스에 개별적으로)
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
        console.log(`[${config.NAME || config.LOGIN_ID}] ✅ Login successful.`);
        accounts.push({ client, token, config, active: true });
      } else {
        console.error(`[${config.NAME || config.LOGIN_ID}] 🔴 Login failed.`);
      }
    } catch (error) {
        console.error(`[${config.NAME || config.LOGIN_ID}] 🔴 Login process failed:`, error.message);
    }
    await new Promise(resolve => setTimeout(resolve, 500)); // 로그인 시도 간 500ms 지연
  }

  let activeAccounts = accounts;
  if (activeAccounts.length === 0) {
    console.error(`${logPrefix} 🔴 All logins failed. Aborting group.`);
    return;
  }

  // 2. 예약 오픈 시간까지 대기
  console.log(`${logPrefix} Waiting for booking to open...`);
  await waitForBookingOpen(date);

  // 3. 예약 가능한 시간 목록 가져오기
  const representativeAccount = activeAccounts[0];
  let allAvailableTimes = await fetchBookingTimes(representativeAccount.client, representativeAccount.token, date);

  if (!allAvailableTimes || allAvailableTimes.length === 0) {
    console.log(`${logPrefix} 🔴 No available time slots found.`);
    return;
  }

  // 조회된 시간 목록을 파일로 저장 (파일이 존재하지 않을 경우에만)
  try {
    const dataDir = './data';
    const filePath = `${dataDir}/${date}.json`;
    if (!fs.existsSync(filePath)) {
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      fs.writeFileSync(filePath, JSON.stringify(allAvailableTimes, null, 2));
      console.log(`${logPrefix} ✅ Saved ${allAvailableTimes.length} available slots to ${filePath}`);
    } else {
      console.log(`${logPrefix} ℹ️ File ${filePath} already exists. Skipping save.`);
    }
  } catch (error) {
    console.error(`${logPrefix} 🔴 Failed to save time slots to file:`, error.message);
  }

  // 4. 시간 정렬 방향 결정 (그룹 내 하나라도 역방향이면 전체 역방향 통일)
  const sortDescending = configs.some(c => parseInt(c.START_TIME, 10) > parseInt(c.END_TIME, 10));
  if (sortDescending) {
      console.log(`${logPrefix} Sorting slots in descending order (group policy).`);
      allAvailableTimes.sort((a, b) => b.bk_time.localeCompare(a.bk_time));
  }

  let remainingSlots = [...allAvailableTimes];
  console.log(`${logPrefix} ✅ Found ${remainingSlots.length} available slots in the specified range.`);

  // 5. 예약 시도 및 재시도 루프
  while (activeAccounts.length > 0 && remainingSlots.length > 0) {
    console.log(`${logPrefix} --- New booking round ---`);
    console.log(`${logPrefix} Active accounts: ${activeAccounts.length}, Remaining slots: ${remainingSlots.length}`);

    // 각 활성 계정에 슬롯을 할당하여 병렬로 예약 시도
    const bookingPromises = activeAccounts.map((account, index) => {
      const targetSlot = remainingSlots[index];
      if (!targetSlot) return null;

      // ** 각 계정의 개별 시간 범위 확인 **
      const { START_TIME, END_TIME } = account.config;
      const isDescending = parseInt(START_TIME, 10) > parseInt(END_TIME, 10);
      const minTime = isDescending ? END_TIME : START_TIME;
      const maxTime = isDescending ? START_TIME : END_TIME;

      if (targetSlot.bk_time >= minTime && targetSlot.bk_time <= maxTime) {
        return attemptBooking(account, targetSlot);
      } else {
        // 이 슬롯은 해당 계정의 희망 범위에 맞지 않음
        console.log(`[${account.config.NAME || account.config.LOGIN_ID}] ⏭️ Skipping slot ${targetSlot.bk_time} as it's outside the desired range (${minTime}-${maxTime}).`);
        // 실패와 동일하게 처리하여 다음 라운드에서 다른 슬롯을 시도하도록 함
        return Promise.resolve({ success: false, slot: targetSlot, skipped: true });
      }
    }).filter(promise => promise !== null);

    const results = await Promise.all(bookingPromises);

    // 사용된 슬롯 제거 (실제로 시도된 슬롯만)
    const usedSlots = results.filter(r => !r.skipped).map(r => r.slot);
    remainingSlots = remainingSlots.filter(slot => !usedSlots.some(used => used.bk_time === slot.bk_time && used.bk_cours === slot.bk_cours));

    // 성공한 계정 비활성화
    results.forEach((result, index) => {
      if (result.success) {
        activeAccounts[index].active = false;
      }
    });
    activeAccounts = activeAccounts.filter(acc => acc.active);

    if (activeAccounts.length > 0 && remainingSlots.length === 0) {
      console.log(`${logPrefix} 🔴 No more slots to try for the remaining ${activeAccounts.length} accounts.`);
    }
  }

  console.log(`${logPrefix} --- Booking process finished ---`);
}

// 예약 오픈 시간까지 대기하는 함수
async function waitForBookingOpen(targetDateStr) {
  const targetDate = moment.tz(targetDateStr, "YYYYMMDD", "Asia/Seoul");
  const dayOfWeek = targetDate.day();
  let openTime = targetDate.clone().set({ hour: 0, minute: 0, second: 0 });

  if (dayOfWeek === 0) { openTime.add(10, 'hours').subtract(11, 'days'); }
  else if (dayOfWeek === 6) { openTime.add(10, 'hours').subtract(10, 'days'); }
  else { openTime.add(9, 'hours').subtract(14, 'days'); }

  console.log(`[WAIT ${targetDateStr}] Calculated booking open time: ${openTime.format()}`);

  // ... (이전에 구현한 정밀 대기 로직) ...
  let ntpTime = await getNtpTime();
  let offset = moment(ntpTime).diff(moment());
  let correctedTime = () => moment().add(offset, 'ms');
  let waitTime = openTime.diff(correctedTime());
  const PRECISION_THRESHOLD = 60000; // 1분

  while (waitTime > 5) {
    let sleepTime = (waitTime > PRECISION_THRESHOLD) ? 30000 : 5000;
    const finalSleepTime = Math.min(waitTime - 5, sleepTime);
    if (finalSleepTime <= 0) break;

    console.log(`[WAIT ${targetDateStr}] Booking opens in ${Math.round(waitTime / 1000)}s. Waiting for ${finalSleepTime / 1000}s...`);
    await new Promise(resolve => setTimeout(resolve, finalSleepTime));

    ntpTime = await getNtpTime();
    offset = moment(ntpTime).diff(moment());
    waitTime = openTime.diff(correctedTime());
  }

  console.log(`[WAIT ${targetDateStr}] Booking time! Applying 300ms delay...`);
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

async function main() {
  const configs = JSON.parse(fs.readFileSync('./booking_configs.json', 'utf-8'));

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
