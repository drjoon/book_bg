import axios from "axios";
import { CookieJar } from "tough-cookie";
import { wrapper } from "axios-cookiejar-support";
import * as cheerio from "cheerio";
import dotenv from "dotenv";

dotenv.config();

async function getLoginToken(client) {
  const res = await client.get("https://www.debeach.co.kr/auth/login");
  const $ = cheerio.load(res.data);
  const token = $('meta[name="csrf-token"]').attr("content");
  console.log("✅ XSRF token:", token);
  return token;
}

async function doLogin(client, xsrfToken) {
  console.log("2) POST login...");

  const payload = new URLSearchParams({
    username: process.env.LOGIN_ID, // ✅ 'id' → 'username'
    password: process.env.LOGIN_PASSWORD,
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

async function main() {
  const jar = new CookieJar();
  const client = wrapper(
    axios.create({
      jar,
      withCredentials: true,
      headers: {
        Accept: "*/*",
        "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
      },
    })
  );

  const token = await getLoginToken(client);
  const isLoggedIn = await doLogin(client, token);

  if (!isLoggedIn) {
    return; // 로그인 실패 시 여기서 실행 종료
  }

  // ✅ 로그인 성공 후 예약시간 조회
  let availableTimes = await fetchBookingTimes(
    client,
    token,
    process.env.TARGET_DATE
  );

  if (availableTimes && availableTimes.length > 0) {
    // .env 파일에서 START_TIME과 END_TIME을 읽어 필터링
    const { START_TIME, END_TIME } = process.env;
    if (START_TIME && END_TIME) {
      const minTime = START_TIME > END_TIME ? END_TIME : START_TIME;
      const maxTime = START_TIME > END_TIME ? START_TIME : END_TIME;
      console.log(`Filtering slots between ${minTime} and ${maxTime}...`);

      availableTimes = availableTimes.filter(
        (slot) => slot.bk_time >= minTime && slot.bk_time <= maxTime
      );

      // 정렬 순서 결정
      if (START_TIME > END_TIME) {
        console.log("Sorting in descending order (reverse).");
        availableTimes.sort((a, b) => b.bk_time.localeCompare(a.bk_time));
      } else {
        console.log("Sorting in ascending order (forward).");
        // 기본값이 오름차순이므로 별도 정렬 필요 없음
      }
    }

    console.log(`✅ Found ${availableTimes.length} available time slots in the specified range.`);
    let bookingSuccessful = false;
    for (const targetSlot of availableTimes) {
      try {
        console.log(
          `\n➡️ Trying to book time: ${targetSlot.bk_time} on course ${targetSlot.bk_cours}`
        );

        // const bookingPayload = JSON.parse(process.env.BOOKING_PAYLOAD);
        // const peopleCount = bookingPayload.people; // HTML에서 파싱하므로 주석 처리

        await selectAndConfirmBooking(
          client,
          token,
          targetSlot,
          process.env.TARGET_DATE
        );

        bookingSuccessful = true;
        console.log(
          `🎉 Successfully booked time: ${targetSlot.bk_time} on course ${targetSlot.bk_cours}`
        );
        break; // 성공 시 루프 중단
      } catch (error) {
        if (error.response && error.response.status === 422) {
          console.log(
            `🟡 Slot ${targetSlot.bk_time} is already taken or unavailable, trying next...`
          );
        } else {
          console.error(
            `🚨 An unrecoverable error occurred while trying to book slot ${targetSlot.bk_time}.`
          );
          // 다른 종류의 에러는 루프를 중단하고 스크립트를 종료합니다.
          throw error;
        }
      }
    }

    if (!bookingSuccessful) {
      console.log("😢 All available time slots failed to book.");
    }
  } else {
    console.log("😢 No available time slots found.");
  }
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

  if (confirmRes.data && confirmRes.data.message === '예약이 완료되었습니다.') {
    console.log("🎉🎉🎉 Booking successful! 🎉🎉🎉");
  } else {
    // 성공이 아닌 다른 모든 경우
    const errorMessage = (confirmRes.data && (confirmRes.data.message || confirmRes.data.error)) || "Booking failed for an unknown reason.";
    console.error(`🚨 Booking failed: ${errorMessage}`);
    throw new Error(errorMessage);
  }
}

main().catch(console.error);
