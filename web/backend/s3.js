// web/backend/s3.js
import {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";

const BUCKET_NAME = process.env.TEE_S3_BUCKET; // 예: golf-book-tee-snapshots
const REGION =
  process.env.TEE_S3_REGION || process.env.AWS_REGION || "ap-northeast-2";
const COURSE_ID = process.env.TEE_COURSE_ID || "debeach";

if (!BUCKET_NAME) {
  console.warn("[TEE_S3] TEE_S3_BUCKET env가 비어 있습니다. 버킷 생성 스킵.");
}

const s3 = new S3Client({ region: REGION });

export async function ensureTeeBucket() {
  if (!BUCKET_NAME) return;

  try {
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET_NAME }));
    console.log(`[TEE_S3] Bucket already exists: ${BUCKET_NAME}`);
    return;
  } catch (e) {
    const status = e?.$metadata?.httpStatusCode;
    const code = e?.name || e?.Code || e?.code;

    if (status !== 404) {
      console.warn(
        "[TEE_S3] HeadBucket error, but continue:",
        JSON.stringify({
          bucket: BUCKET_NAME,
          region: REGION,
          status,
          code,
          message: e?.message,
        }),
      );

      if (status === 301) {
        console.warn(
          "[TEE_S3] Possible region mismatch. Check bucket region vs env AWS_REGION/TEE_S3_REGION.",
        );
      }
      if (status === 403) {
        console.warn(
          "[TEE_S3] Possible permission issue. Check EC2/EBS instance role policy for s3:ListBucket/GetObject/PutObject.",
        );
      }
      return;
    }
  }

  try {
    await s3.send(
      new CreateBucketCommand({
        Bucket: BUCKET_NAME,
        CreateBucketConfiguration: { LocationConstraint: REGION },
      }),
    );
    console.log(`[TEE_S3] Bucket created: ${BUCKET_NAME} (${REGION})`);
  } catch (e) {
    console.error("[TEE_S3] Failed to create bucket:", e.message || e);
  }
}

export async function saveBookingResult(accountName, dateStr, result) {
  if (!BUCKET_NAME) return;

  const key = `${COURSE_ID}/results/${dateStr}/${accountName}.json`;

  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
        Body: JSON.stringify({
          accountName,
          dateStr,
          success: result.success,
          slot: result.slot || null,
          reason: result.reason || null,
          stats: result.stats || null,
          savedAt: new Date().toISOString(),
        }),
        ContentType: "application/json; charset=utf-8",
      }),
    );
    console.log(
      `[TEE_S3] Booking result saved to S3: s3://${BUCKET_NAME}/${key}`,
    );
  } catch (e) {
    console.warn(
      "[TEE_S3] Failed to save booking result:",
      JSON.stringify({
        bucket: BUCKET_NAME,
        region: REGION,
        status: e?.$metadata?.httpStatusCode,
        code: e?.name || e?.Code || e?.code,
        message: e?.message,
      }),
    );
  }
}

export async function saveTeeSnapshot(slots, { roundDate, bookingDate } = {}) {
  if (!BUCKET_NAME) return;
  if (!Array.isArray(slots) || slots.length === 0) return;

  const today = new Date();
  const y = today.getFullYear();
  const m = String(today.getMonth() + 1).padStart(2, "0");
  const d = String(today.getDate()).padStart(2, "0");
  const execDate = `${y}${m}${d}`;

  const booking = bookingDate || execDate;
  const round = roundDate || execDate;
  const key = `${COURSE_ID}/${booking}/${round}.json`;

  try {
    // 1) 기존 스냅샷이 있으면 읽어온다
    let merged = [];
    try {
      const existing = await s3.send(
        new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }),
      );
      const body = await existing.Body?.transformToString();
      if (body) {
        const parsed = JSON.parse(body);
        if (Array.isArray(parsed)) merged = parsed;
      }
    } catch (e) {
      // NotFound 등은 무시하고 새로 쓰기
    }

    // 2) 기존 + 신규 슬롯을 합치고, 코스/파트/시간/홀 기준으로 중복 제거
    const map = new Map();
    const addSlots = (list) => {
      for (const s of list) {
        if (!s || !s.bk_time) continue;
        const keyStr = [s.bk_cours, s.bk_part, s.bk_time, s.bk_hole]
          .map((v) => v ?? "")
          .join("|");
        if (!map.has(keyStr)) {
          map.set(keyStr, s);
        }
      }
    };

    addSlots(merged);
    addSlots(slots);

    const finalSlots = Array.from(map.values());

    // 3) 병합 결과를 다시 저장
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
        Body: JSON.stringify(finalSlots),
        ContentType: "application/json; charset=utf-8",
      }),
    );
    console.log(
      `[TEE_S3] Saved tee snapshot to S3: s3://${BUCKET_NAME}/${key}`,
    );
  } catch (e) {
    console.warn(
      "[TEE_S3] Failed to save tee snapshot:",
      JSON.stringify({
        bucket: BUCKET_NAME,
        region: REGION,
        status: e?.$metadata?.httpStatusCode,
        code: e?.name || e?.Code || e?.code,
        message: e?.message,
      }),
    );
  }
}
