# debeach 자동 예약 시스템 — 설계 규칙 및 중요 사항

## 전체 흐름

```
T-95s~T-80s : EBS(worker) — [DB 재확인 1단계] 예약 큐 재구성 (Booking.find)
              → 이 윈도우 밖에서는 DB를 읽지 않아 일상 부하 0
T-91s       : EBS — [DB 재확인 2단계] NTP sync + 최신 Booking/User 스냅샷 재조회
T-90s~T-70s : EBS — 각 Lambda를 랜덤 시각에 개별 invoke (Promise.all)
              [DB 재확인 3단계] invoke 직전 계정별 Booking.findOne
              각 Lambda는 발사 즉시 로그인 시도 시작
T-5s   : Lambda 로그인 deadline (preloginDeadline = 오픈시각 - 5s)
T+0.2s : Lambda — 슬롯 fetch 시작 (windowStart = 오픈시각 + 200ms)
T+0s ~ T+60s : Lambda — 예약 윈도우 (60초)
Lambda → EBS : 즉시 결과 반환 (DynamoDB key + 성공여부)
EBS    : MongoDB 상태 업데이트 + S3 영구 저장 + WebSocket broadcast
```

### 예약 오픈 시각 인식 (worker — `getActiveBookingOpenTime`)

- **평일(월~금) 09:00**: 14일 후 평일 라운드 예약 오픈
- **수요일 10:00**: 11일 후 일요일 / 10일 후 토요일 라운드 예약 오픈
- 수요일에는 09:00과 10:00이 모두 후보로 등록되어 **동일한 prelaunch 흐름**을 타며, 3단계 DB 재확인이 그대로 적용된다.

### DB 재확인 3단계 (9시/10시 공통)

| 단계  | 시점          | 위치                                                      | 동작                                                                 |
| ----- | ------------- | --------------------------------------------------------- | -------------------------------------------------------------------- |
| 1단계 | T-95s ~ T-80s | `auto/worker.js` — `processQueue` 내 `shouldRunPrelaunch` | `Booking.find` 로 큐 재구성. 윈도우 밖에서는 즉시 return.            |
| 2단계 | T-91s         | `auto/debeach_auto.js` — `runBookingGroup`                | NTP 동기 직후 `User.find({granted})` + `Booking.find` 스냅샷 재조회. |
| 3단계 | T-90s±stagger | `auto/debeach_auto.js` — invoke 직전                      | 계정별 `Booking.findOne`. 삭제/terminal 상태면 Lambda 발사 스킵.     |

---

## EBS (`auto/debeach_auto.js`)

### Lambda 발사 타이밍

- `95~80초 전`: worker 큐 재구성 (DB 재확인 1단계)
- `91초 전`: NTP sync + DB snapshot 재조회 (DB 재확인 2단계, 1회)
- `90~70초 전`: 리전 묶음(batch) 단위로 10초씩 stagger, 배치 내 ±2초 지터
  - `LOGIN_STAGGER_MS = 10000`, `MAX_TOTAL_STAGGER_MS = 20000`
  - batch 크기 = `LAMBDA_REGIONS.length` (현재 7)
  - batch0(i=0~6): T-90s±2s, batch1(i=7~13): T-80s±2s, batch2: T-70s±2s
- 각 invoke 직전: 계정별 `Booking.findOne` 재확인 (DB 재확인 3단계)

### NTP offset

- NTP 서버: `time.apple.com`, `time.google.com`, `pool.ntp.org` (3서버 × 3회 시도)
- `offsetMs = NTP시각 - 로컬시각` → Lambda payload에 포함
- Lambda 내부에서 `correctedNow() = moment() + offsetMs`로 시각 보정
- **범위 검증**: `|offsetMs| > 5000ms`이면 null 처리 → Lambda가 시스템 시간 사용 (비정상 NTP 응답 방어)

### 시간대 offset 보정 (동일 START_TIME/END_TIME 계정)

- 같은 시간대 계정이 여러 개면 슬롯 충돌 방지를 위해 7분씩 START_TIME 이동
- 정순(`START <= END`): START += 7분/계정
- 역순(`START > END`): START -= 7분/계정, END 고정
- `오수양`은 항상 첫 번째 (원래 시간 유지)
- `PRIMARY_SLOT_OFFSET`: 전체 계정 정렬 후 인덱스 부여 (슬롯 순서 회전용)

### 예약 결과 처리

- Lambda 응답 즉시 수신 (`RequestResponse`, 폴링 없음)
- 성공: MongoDB `성공` 업데이트 + S3 저장 + tee snapshot + WebSocket broadcast
- 실패: MongoDB `실패` 업데이트 + S3 저장 + WebSocket broadcast
- Lambda 호출 오류: MongoDB `실패` + S3 저장

### 예약 오픈 시각 (`getBookingOpenTime`)

| 예약일       | 오픈 시각     |
| ------------ | ------------- |
| 평일 (월~금) | 14일 전 09:00 |
| 토요일       | 10일 전 10:00 |
| 일요일       | 11일 전 10:00 |

---

## Lambda (`lambda/book-debeach/index.js`)

### 인프라

- **함수명**: `book-debeach` (7개 리전 동일 이름)
- **리전** (`LAMBDA_REGIONS`, IP 분산 용 순환):
  - i%7=0: 서울 (`ap-northeast-2`, PRIMARY)
  - i%7=1: 도쿄 (`ap-northeast-1`)
  - i%7=2: 오사카 (`ap-northeast-3`)
  - i%7=3: 싱가포르 (`ap-southeast-1`)
  - i%7=4: 홍콩 (`ap-east-1`)
  - i%7=5: 타이페이 (`ap-east-2`)
  - i%7=6: 방콕 (`ap-southeast-7`)
- **타임아웃**: 180초
- **IAM 역할**: `book-debeach-lambda-role` (각 리전에 동일 역할 적용)
  - DynamoDB: `PutItem`, `Scan`, `DeleteItem` — 두 테이블 모두 (`UpdateItem` 미사용)

### DynamoDB 테이블

| 테이블명                   | 용도                             | TTL   |
| -------------------------- | -------------------------------- | ----- |
| `book-debeach-slot-claims` | 슬롯 claim (race condition 방지) | 60초  |
| `book-debeach-results`     | 예약 결과 임시 저장              | 1시간 |

### 로그인 로직 (`loginWithRetriesBeforeOpen`)

- Lambda 발사 즉시 루프 진입 (`waitUntil` 없음)
- `preloginDeadline = 오픈시각 - 5초`까지 반복
- 각 attempt budget = `min(10000ms, remaining)`
- attempt 실패 후 sleep = `min(700, max(150, remaining-50))`ms
- deadline 초과 시 fallback login (20초 타임아웃)

### 슬롯 필터링 및 선택

- `s = min(START_TIME, END_TIME)`, `e = max(START_TIME, END_TIME)` (역순 자동 정규화)
- `getClaimedSlots`: TTL 미만료 항목만 반환 (`#ttl > now` 필터)
- `sortSlotsByProximity`: HHMM → 분 단위 변환 후 START_TIME과의 거리 순으로 정렬 (시간 경계 오류 방지)
- `rotateSlotsForAccount`: PRIMARY_SLOT_OFFSET만큼 슬롯 목록 회전
- `fetchBookingTimes` 반환값이 배열 아닌 경우(세션 만료 후 200+HTML 등) → 400ms 후 재시도 (Lambda 종료 방지)

### DynamoDB claim 규칙

- `claimSlot`: `attribute_not_exists(PK) OR #ttl <= :now` — 만료 레코드 덮어쓰기 허용
- 422 수신 시 `markSlotTaken`: TTL 20초 연장 + `serverTaken=true` — 다른 Lambda 재시도 방지
- 파싱 실패(`!error.response`) 시: `failedSlots`에 추가 (동일 Lambda 재시도 방지)

### 예약 윈도우 (queued 모드)

- `windowStart = 오픈시각 + 200ms` (정밀 대기 후 첫 fetch)
- `windowEnd = 오픈시각 + 40초`
- 루프: fetch → claimedSlots 조회 → filter → claimSlot → attemptBooking
- 슬롯 없음: 600ms 대기 후 재시도
- 429: 1200~2000ms backoff 후 재시도 (`hasRetried401` 플래그 유지)
- 401: re-login 1회 후 재시도 (2회째 401은 해당 슬롯 포기)

### HTTP 타임아웃

| 요청                  | 타임아웃                        |
| --------------------- | ------------------------------- |
| 로그인 GET/POST       | 10초 (LOGIN_ATTEMPT_TIMEOUT_MS) |
| `/booking/create` GET | 3초                             |
| `/booking` POST       | 3초                             |
| fallback login        | 20초                            |

---

## S3 영구 저장 (`web/backend/s3.js`)

- **버킷**: `process.env.TEE_S3_BUCKET`
- **리전**: `process.env.TEE_S3_REGION || AWS_REGION || "ap-northeast-2"`
- 예약 결과: `debeach/results/{dateStr}/{accountName}.json`
- tee snapshot: `saveTeeSnapshot(slots, { roundDate: date })`
- Lambda DynamoDB 저장은 임시 (1시간 TTL), S3가 영구 저장

---

## 변경 시 주의사항

1. **Lambda 코드 수정 후 반드시 재빌드 및 배포 필요**

   ```bash
   cd lambda/book-debeach
   npm run build
   aws lambda update-function-code --function-name book-debeach \
     --zip-file fileb://deployment_package.zip --region ap-south-1
   ```

2. **Lambda timeout 변경 시**
   - 최대 실행 시간 = 로그인(최대 90s) + 예약 윈도우(40s) = 130s
   - 현재 설정: **180초** (여유 50초)

3. **IAM 정책 변경 시**
   - `aws iam put-role-policy`로 인라인 정책 업데이트
   - 두 DynamoDB 테이블 ARN 모두 포함 필수

4. **`getBookingOpenTime` 수정 시**
   - EBS(`auto/debeach_auto.js`)와 Lambda(`lambda/book-debeach/index.js`) 양쪽 동기화 필수

5. **계정 이름 하드코딩**
   - 현재 `오수양`이 시간대 정렬에서 항상 첫 번째로 하드코딩됨
   - 계정 구성 변경 시 `runBookingGroup`의 정렬 로직 검토 필요
