import express from "express";
import cors from "cors";
import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { User, Booking } from "./models.js"; // Import models
import { runAutoBooking, getBookingOpenTime } from "../../auto/debeach_auto.js";
import moment from "moment-timezone";
import connectDB from "./db.js";
import jwt from "jsonwebtoken";
import { ensureTeeBucket } from "./s3.js";

import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

connectDB();

ensureTeeBucket().catch((e) =>
  console.warn("[TEE_S3] ensureTeeBucket error:", e?.message || e)
);

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 8081;

app.use(cors());
app.use(express.json());

// Auth routes
app.post("/api/auth/signup", async (req, res) => {
  const { name, username, password } = req.body;
  if (!name || !username || !password) {
    return res
      .status(400)
      .json({ message: "Name, username and password are required." });
  }

  try {
    const user = new User({
      name,
      username,
      password,
      golfPassword: password,
      role: "user",
      granted: false,
    });
    await user.save();
    res.status(201).json({
      message: "User created successfully. Please wait for admin approval.",
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: "Username already exists." });
    }
    res.status(500).json({ message: "Error creating user.", error });
  }
});

const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) {
    return res.status(401).json({ message: "Authentication token required." });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ message: "Invalid or expired token." });
  }
};

const adminOnly = (req, res, next) => {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ message: "Admin access required." });
  }
  next();
};

app.get("/api/auth/check", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select("-password");
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }
    res.json({
      user: {
        id: user._id,
        name: user.name,
        username: user.username,
        role: user.role,
        golfPassword: user.golfPassword || "",
      },
    });
  } catch (error) {
    res.status(500).json({ message: "Error fetching user data.", error });
  }
});

app.put("/api/profile/golf-password", authMiddleware, async (req, res) => {
  const { golfPassword } = req.body;
  if (typeof golfPassword !== "string") {
    return res.status(400).json({ message: "골프장 비밀번호를 입력해주세요." });
  }

  try {
    const user = await User.findByIdAndUpdate(
      req.user.userId,
      { golfPassword },
      { new: true }
    ).select("name username role golfPassword");

    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    res.json({
      message: "골프장 비밀번호가 저장되었습니다.",
      user: {
        id: user._id,
        name: user.name,
        username: user.username,
        role: user.role,
        golfPassword: user.golfPassword || "",
      },
    });
  } catch (error) {
    res.status(500).json({ message: "비밀번호 저장에 실패했습니다.", error });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res
      .status(400)
      .json({ message: "Username and password are required." });
  }

  try {
    const user = await User.findOne({ username });
    if (!user) {
      return res.status(401).json({ message: "Invalid credentials." });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid credentials." });
    }

    if (!user.granted) {
      return res
        .status(403)
        .json({ message: "Account not approved by administrator." });
    }

    if (!user.golfPassword) {
      user.golfPassword = password;
      await user.save();
    }

    const token = jwt.sign(
      { userId: user._id, role: user.role, username: user.username },
      process.env.JWT_SECRET,
      { expiresIn: "1d" }
    );

    res.json({
      token,
      user: {
        id: user._id,
        name: user.name,
        username: user.username,
        role: user.role,
        golfPassword: user.golfPassword || "",
      },
    });
  } catch (error) {
    res.status(500).json({ message: "Error logging in.", error });
  }
});

const CONFIG_PATH = path.resolve(__dirname, "../../auto/booking_configs.json");
const QUEUE_PATH = path.resolve(__dirname, "../../auto/queue.json");
const FRONTEND_DIST_PATH = path.resolve(__dirname, "../frontend/dist");

async function loadQueue() {
  try {
    return JSON.parse(await fs.readFile(QUEUE_PATH, "utf-8"));
  } catch (e) {
    return [];
  }
}

async function saveQueue(queue) {
  await fs.writeFile(QUEUE_PATH, JSON.stringify(queue, null, 2));
}

async function enqueueOrUpdate(job) {
  const normalized = {
    account: job.account ?? job.NAME,
    date: job.date ?? job.TARGET_DATE,
    startTime: job.startTime ?? job.START_TIME,
    endTime: job.endTime ?? job.END_TIME,
    force: job.force === true,
  };
  if (!normalized.account || !normalized.date) return;
  const queue = await loadQueue();
  const idx = queue.findIndex(
    (q) => q.account === normalized.account && q.date === normalized.date
  );
  if (idx >= 0) {
    queue[idx] = { ...queue[idx], ...normalized };
  } else {
    queue.push(normalized);
  }
  await saveQueue(queue);
}

// User management routes (admin only)
app.get("/api/users", authMiddleware, adminOnly, async (req, res) => {
  try {
    const users = await User.find({}, "-password");
    res.json(users);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch users", error });
  }
});

app.put("/api/users/:id", authMiddleware, adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const { granted, role } = req.body;
    const user = await User.findByIdAndUpdate(
      id,
      { granted, role },
      { new: true }
    ).select("-password");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    res.json(user);
  } catch (error) {
    res.status(500).json({ message: "Failed to update user", error });
  }
});

app.delete("/api/users/:id", authMiddleware, adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.findByIdAndDelete(id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    res.status(204).send();
  } catch (error) {
    res.status(500).json({ message: "Failed to delete user", error });
  }
});

// 모든 예약 정보를 MongoDB에서 읽어오는 API
app.get("/api/bookings", authMiddleware, async (req, res) => {
  try {
    const query = {};

    const bookings = await Booking.find(query);
    const bookingsByDate = {};

    for (const booking of bookings) {
      const date = booking.date;
      if (!bookingsByDate[date]) {
        bookingsByDate[date] = [];
      }
      bookingsByDate[date].push(booking);
    }

    // 각 날짜별로 bk_time을 기준으로 정렬
    for (const date in bookingsByDate) {
      bookingsByDate[date].sort((a, b) => {
        const timeA = a.bookedSlot?.bk_time || "9999";
        const timeB = b.bookedSlot?.bk_time || "9999";
        return timeA.localeCompare(timeB);
      });
    }

    res.json(bookingsByDate);
  } catch (error) {
    console.error("Error fetching bookings:", error);
    res.status(500).json({ message: "Failed to fetch bookings" });
  }
});

if (existsSync(FRONTEND_DIST_PATH)) {
  app.use(express.static(FRONTEND_DIST_PATH));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/")) {
      return next();
    }
    res.sendFile(path.join(FRONTEND_DIST_PATH, "index.html"));
  });
}

// 계정 목록을 MongoDB에서 가져오는 API
app.get("/api/accounts", authMiddleware, async (req, res) => {
  try {
    if (req.user.role === "admin") {
      const users = await User.find(
        { role: "user" },
        "name username golfPassword"
      );
      const result = users.map((user) => ({
        name: user.name,
        loginId: user.username,
        loginPassword: user.golfPassword || "",
      }));
      return res.json(result);
    }

    const user = await User.findById(req.user.userId).select(
      "name username golfPassword"
    );
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    res.json([
      {
        name: user.name,
        loginId: user.username,
        loginPassword: user.golfPassword || "",
      },
    ]);
  } catch (error) {
    console.error("Error fetching accounts:", error);
    res.status(500).json({ message: "Failed to fetch accounts" });
  }
});

// 신규 예약 생성 (MongoDB)
app.post("/api/bookings", authMiddleware, async (req, res) => {
  const { NAME, TARGET_DATE, START_TIME, END_TIME, MEMO } = req.body;
  if (!NAME || !TARGET_DATE || !START_TIME || !END_TIME) {
    return res.status(400).json({ message: "필수 정보가 누락되었습니다." });
  }

  try {
    // 오픈 1분 이내 차단
    const now = moment().tz("Asia/Seoul");
    const openTime = getBookingOpenTime(TARGET_DATE);
    if (
      now.isSameOrAfter(openTime.clone().subtract(1, "minute")) &&
      now.isBefore(openTime)
    ) {
      return res
        .status(409)
        .json({ message: "오픈 1분 이내에는 예약을 추가/수정할 수 없습니다." });
    }

    const newBooking = new Booking({
      account: NAME,
      date: TARGET_DATE,
      status: "접수",
      startTime: START_TIME,
      endTime: END_TIME,
      successTime: null,
      bookedSlot: null,
      memo: typeof MEMO === "string" ? MEMO : undefined,
    });

    const savedBooking = await newBooking.save();
    await enqueueOrUpdate(savedBooking.toObject());
    res
      .status(201)
      .json({ message: "예약이 추가되었습니다.", ...savedBooking.toObject() });
  } catch (error) {
    if (error.code === 11000) {
      try {
        const existingBooking = await Booking.findOne({
          account: NAME,
          date: TARGET_DATE,
        });

        if (existingBooking) {
          const isSuccess = existingBooking.status === "성공";
          const shouldUpdateTime =
            existingBooking.startTime !== START_TIME ||
            existingBooking.endTime !== END_TIME;
          const shouldUpdateMemo =
            typeof MEMO === "string" && existingBooking.memo !== MEMO;

          if (shouldUpdateTime || shouldUpdateMemo) {
            existingBooking.startTime = START_TIME;
            existingBooking.endTime = END_TIME;
            if (shouldUpdateMemo) {
              existingBooking.memo = MEMO;
            }
            if (!isSuccess) {
              existingBooking.status = "접수";
              existingBooking.successTime = null;
              existingBooking.bookedSlot = null;
            }
            await existingBooking.save();
          }

          if (!isSuccess) {
            await enqueueOrUpdate(existingBooking.toObject());
            return res.status(200).json({
              message: "기존 예약을 갱신했습니다.",
              ...existingBooking.toObject(),
            });
          }

          return res.status(200).json({
            message: "이미 성공 처리된 예약입니다.",
            ...existingBooking.toObject(),
          });
        }
      } catch (updateError) {
        console.error("중복 예약 처리 중 오류 발생:", updateError);
      }

      return res
        .status(409)
        .json({ message: "해당 날짜에 이미 예약이 존재합니다." });
    }
    console.error("예약 추가 중 오류 발생:", error);
    res.status(500).json({ message: "예약 추가에 실패했습니다." });
  }
});

// 예약 변경 (MongoDB)
app.put("/api/bookings/:date/:account", authMiddleware, async (req, res) => {
  const { date, account } = req.params;
  const { startTime, endTime, memo } = req.body;

  if (!startTime || !endTime) {
    return res.status(400).json({ message: "시작 및 종료 시간이 필요합니다." });
  }

  try {
    // 오픈 1분 이내 차단
    const now = moment().tz("Asia/Seoul");
    const openTime = getBookingOpenTime(date);
    if (
      now.isSameOrAfter(openTime.clone().subtract(1, "minute")) &&
      now.isBefore(openTime)
    ) {
      return res
        .status(409)
        .json({ message: "오픈 1분 이내에는 예약을 추가/수정할 수 없습니다." });
    }

    const update = { startTime, endTime };
    if (typeof memo === "string") {
      update.memo = memo;
    }

    const updatedBooking = await Booking.findOneAndUpdate(
      { date, account },
      update,
      { new: true } // Return the updated document
    );

    if (!updatedBooking) {
      return res
        .status(404)
        .json({ message: "변경할 예약을 찾을 수 없습니다." });
    }

    await enqueueOrUpdate(updatedBooking.toObject());
    res.json({
      message: "예약이 변경되었습니다.",
      ...updatedBooking.toObject(),
    });
  } catch (error) {
    console.error("예약 변경 중 오류 발생:", error);
    res.status(500).json({ message: "예약 변경에 실패했습니다." });
  }
});

// 예약 삭제 (MongoDB)
app.delete("/api/bookings/:date/:account", authMiddleware, async (req, res) => {
  const { date, account } = req.params;

  try {
    const deletedBooking = await Booking.findOneAndDelete({ date, account });

    if (!deletedBooking) {
      return res
        .status(404)
        .json({ message: "삭제할 예약을 찾을 수 없습니다." });
    }
    // 큐에서 동일한 계정/날짜 조합의 작업 제거 (자동 예약 재실행 방지)
    try {
      const queue = await loadQueue();
      const filteredQueue = queue.filter(
        (job) =>
          !(
            (job.account ?? job.NAME) === account &&
            (job.date ?? job.TARGET_DATE) === date
          )
      );
      await saveQueue(filteredQueue);
    } catch (e) {
      console.error("예약 삭제 후 큐 정리 중 오류:", e.message);
    }

    res.json({ message: "예약이 삭제되었습니다." });
  } catch (error) {
    console.error("예약 삭제 중 오류 발생:", error);
    res.status(500).json({ message: "예약 삭제에 실패했습니다." });
  }
});

// 통합 예약 요청 API
app.post("/api/submit-booking", authMiddleware, async (req, res) => {
  try {
    const body = req.body;
    const job = {
      account: body.account ?? body.NAME,
      date: body.date ?? body.TARGET_DATE,
      startTime: body.startTime ?? body.START_TIME,
      endTime: body.endTime ?? body.END_TIME,
      force: body.force === true,
    };
    // 이미 성공한 예약이면 재실행하지 않음
    try {
      const existing = await Booking.findOne({
        account: job.account,
        date: job.date,
      });
      if (!job.force && existing && existing.status === "성공") {
        return res.json({
          message: "이미 성공 상태입니다. 실행을 생략합니다.",
        });
      }
    } catch (e) {
      console.warn("[API] Pre-check existing booking failed:", e.message);
    }
    const openTime = getBookingOpenTime(job.date);
    const now = moment().tz("Asia/Seoul");

    // 오픈 1분 이내 등록 차단 로직 (큐 등록 시에만)
    if (now.isBefore(openTime)) {
      if (now.isSameOrAfter(openTime.clone().subtract(1, "minute"))) {
        return res.status(409).json({
          message: "오픈 1분 이내에는 자동 예약 등록을 할 수 없습니다.",
        });
      }
    }

    if (now.isAfter(openTime)) {
      // 즉시 실행
      console.log(
        `[API] Booking time has passed. Running immediately for ${job.account} on ${job.date}`
      );
      await runAutoBooking([job], { immediate: true, force: job.force });
      res.json({ message: "즉시 예약을 시작합니다!" });
    } else {
      // 큐에 추가
      console.log(`[API] Queuing booking for ${job.account} on ${job.date}`);
      await enqueueOrUpdate(job);
      res.json({ message: "예약이 큐에 추가되었습니다." });
    }
  } catch (error) {
    console.error("통합 예약 처리 오류:", error);
    res.status(500).json({ message: "예약 처리에 실패했습니다." });
  }
});

app.listen(PORT, () => {
  console.log(`Backend server is running on http://localhost:${PORT}`);
});
