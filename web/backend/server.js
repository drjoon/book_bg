import express from "express";
import cors from "cors";
import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import { User, Booking, Message, PasswordChangeRequest } from "./models.js"; // Import models
import { runAutoBooking, getBookingOpenTime } from "../../auto/debeach_auto.js";
import moment from "moment-timezone";
import connectDB from "./db.js";
import jwt from "jsonwebtoken";
import { ensureTeeBucket } from "./s3.js";
import {
  decryptCredential,
  encryptCredential,
  looksEncryptedCredential,
} from "./crypto.js";

import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, ".env") });

const dbReady = connectDB();

ensureTeeBucket().catch((e) =>
  console.warn("[TEE_S3] ensureTeeBucket error:", e?.message || e),
);

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 8081;

app.use(cors());
app.use(express.json());

const serializeUser = (user) => ({
  id: user._id,
  name: user.name,
  role: user.role,
  granted: user.granted,
  debeachLoginId: user.debeachLoginId || "",
  hasDebeachPassword: Boolean(user.debeachLoginPassword),
});

const getPlainDebeachPassword = (value) => {
  if (!value) return "";
  return looksEncryptedCredential(value) ? decryptCredential(value) : value;
};

const buildRoomKey = (adminUsername, userUsername) =>
  [adminUsername, userUsername].sort().join("::");

const createSystemChatMessage = async ({
  adminUsername,
  userUsername,
  body,
}) => {
  const roomKey = buildRoomKey(adminUsername, userUsername);
  const message = new Message({
    roomKey,
    adminUsername,
    userUsername,
    senderUsername: adminUsername,
    senderRole: "admin",
    body,
    readBy: [adminUsername],
  });
  await message.save();
  return message;
};

const serializeMessage = (message) => ({
  id: message._id,
  roomKey: message.roomKey,
  adminUsername: message.adminUsername,
  userUsername: message.userUsername,
  senderUsername: message.senderUsername,
  senderRole: message.senderRole,
  body: message.body,
  readBy: Array.isArray(message.readBy) ? message.readBy : [],
  bookingContext: message.bookingContext || null,
  createdAt: message.createdAt,
});

const serializePasswordChangeRequest = (request) => ({
  id: request._id,
  requesterName: request.requesterName,
  requestType: request.requestType || "app_password",
  status: request.status,
  createdAt: request.createdAt,
  reviewedAt: request.reviewedAt,
  reviewedBy: request.reviewedBy,
  rejectReason: request.rejectReason || "",
});

const requestTypeLabel = {
  app_password: "비밀번호",
  debeach_password: "드비치 비밀번호",
};

const buildPasswordRequestMessage = (request, action) => {
  const label = requestTypeLabel[request.requestType || "app_password"];
  if (action === "approved") {
    return request.requestType === "debeach_password"
      ? `${label} 변경 요청이 승인되었습니다.`
      : `${label} 변경 요청이 승인되었습니다. 새 비밀번호로 다시 로그인해주세요.`;
  }
  return `${label} 변경 요청이 반려되었습니다.`;
};

const resolveConversationUsers = async (req, otherUsername) => {
  if (!otherUsername) {
    throw new Error("대화 상대가 필요합니다.");
  }

  const me = await User.findById(req.user.userId).select("name role granted");
  if (!me) {
    const error = new Error("User not found.");
    error.statusCode = 404;
    throw error;
  }

  const other = await User.findOne({ name: otherUsername }).select(
    "name role granted",
  );
  if (!other) {
    const error = new Error("대화 상대를 찾을 수 없습니다.");
    error.statusCode = 404;
    throw error;
  }

  if (me.role === "admin") {
    if (other.role !== "user") {
      const error = new Error("관리자는 사용자와만 대화할 수 있습니다.");
      error.statusCode = 400;
      throw error;
    }
    return {
      me,
      other,
      adminUsername: me.name,
      userUsername: other.name,
    };
  }

  if (other.role !== "admin") {
    const error = new Error("사용자는 관리자와만 대화할 수 있습니다.");
    error.statusCode = 403;
    throw error;
  }

  return {
    me,
    other,
    adminUsername: other.name,
    userUsername: me.name,
  };
};

const getCurrentUserRecord = async (req) => {
  const user = await User.findById(req.user.userId).select("name role granted");
  if (!user) {
    const error = new Error("User not found.");
    error.statusCode = 404;
    throw error;
  }
  return user;
};

const cleanupLegacyAdminUser = async () => {
  const deleted = await User.deleteMany({ name: "drjoon", role: "admin" });
  if (deleted.deletedCount > 0) {
    console.log(
      `[AUTH] Removed legacy admin account drjoon (${deleted.deletedCount})`,
    );
  }
};

const summarizeIndexes = (indexes) =>
  indexes.map(({ name, key, unique, sparse, partialFilterExpression }) => ({
    name,
    key,
    unique: Boolean(unique),
    sparse: Boolean(sparse),
    partialFilterExpression: partialFilterExpression || null,
  }));

const logUserIndexes = async (label) => {
  try {
    const indexes = await User.collection.listIndexes().toArray();
    console.log(`[AUTH] User indexes ${label}:`, summarizeIndexes(indexes));
  } catch (error) {
    console.error(
      `[AUTH] Failed to read User indexes ${label}:`,
      error.message,
    );
  }
};

const syncUserIndexes = async () => {
  try {
    await logUserIndexes("before sync");
    const syncResult = await User.syncIndexes();
    console.log("[AUTH] User.syncIndexes() result:", syncResult);
    await logUserIndexes("after sync");
  } catch (error) {
    console.error("[AUTH] Failed to sync User indexes:", error.message);
  }
};

dbReady
  .then(async () => {
    await syncUserIndexes();
    await cleanupLegacyAdminUser();
  })
  .catch((error) => {
    console.error(
      "[AUTH] Failed to cleanup legacy admin account:",
      error.message,
    );
  });

// Auth routes
app.post("/api/auth/signup", async (req, res) => {
  const { name, password, debeachLoginId, debeachLoginPassword } = req.body;
  if (!name || !password || !debeachLoginId || !debeachLoginPassword) {
    return res.status(400).json({
      message: "이름, 비밀번호, 드비치 아이디/비밀번호를 모두 입력해주세요.",
    });
  }

  try {
    const normalizedName = String(name).trim();
    const normalizedDebeachLoginId = String(debeachLoginId).trim();
    console.log("[AUTH][SIGNUP] Incoming request:", {
      name: normalizedName,
      debeachLoginId: normalizedDebeachLoginId,
      hasPassword: Boolean(password),
      hasDebeachLoginPassword: Boolean(debeachLoginPassword),
    });

    const exactMatch = await User.findOne({
      name: normalizedName,
      debeachLoginId: normalizedDebeachLoginId,
    }).select("_id name debeachLoginId granted role");

    const nameMatch = await User.findOne({ name: normalizedName }).select(
      "_id name debeachLoginId granted role",
    );

    const debeachLoginIdMatch = await User.findOne({
      debeachLoginId: normalizedDebeachLoginId,
    }).select("_id name debeachLoginId granted role");

    console.log("[AUTH][SIGNUP] Pre-check matches:", {
      exactMatch: exactMatch
        ? {
            id: exactMatch._id,
            name: exactMatch.name,
            debeachLoginId: exactMatch.debeachLoginId,
            granted: exactMatch.granted,
            role: exactMatch.role,
          }
        : null,
      nameMatch: nameMatch
        ? {
            id: nameMatch._id,
            name: nameMatch.name,
            debeachLoginId: nameMatch.debeachLoginId,
            granted: nameMatch.granted,
            role: nameMatch.role,
          }
        : null,
      debeachLoginIdMatch: debeachLoginIdMatch
        ? {
            id: debeachLoginIdMatch._id,
            name: debeachLoginIdMatch.name,
            debeachLoginId: debeachLoginIdMatch.debeachLoginId,
            granted: debeachLoginIdMatch.granted,
            role: debeachLoginIdMatch.role,
          }
        : null,
    });

    if (exactMatch) {
      return res.status(409).json({
        message: "이미 사용 중인 이름 + 드비치 아이디 조합입니다.",
      });
    }

    const user = new User({
      name: normalizedName,
      password,
      debeachLoginId: normalizedDebeachLoginId,
      debeachLoginPassword: encryptCredential(debeachLoginPassword),
      role: "user",
      granted: false,
    });
    await user.save();
    res.status(201).json({
      message:
        "가입 신청이 완료되었습니다. 관리자 승인 후 로그인할 수 있습니다.",
    });
  } catch (error) {
    if (error.code === 11000) {
      console.error("[AUTH][SIGNUP] Duplicate key error:", {
        message: error.message,
        keyPattern: error.keyPattern || null,
        keyValue: error.keyValue || null,
        index: error.index || null,
        code: error.code,
      });
      return res
        .status(409)
        .json({ message: "이미 사용 중인 이름 + 드비치 아이디 조합입니다." });
    }
    console.error("[AUTH][SIGNUP] Failed to create user:", error);
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
    res.json({ user: serializeUser(user) });
  } catch (error) {
    res.status(500).json({ message: "Error fetching user data.", error });
  }
});

app.put("/api/profile", authMiddleware, async (req, res) => {
  const { name, debeachLoginId, debeachLoginPassword } = req.body;
  if (
    typeof name !== "string" ||
    typeof debeachLoginId !== "string" ||
    (typeof debeachLoginPassword !== "undefined" &&
      typeof debeachLoginPassword !== "string")
  ) {
    return res
      .status(400)
      .json({ message: "프로필 정보가 올바르지 않습니다." });
  }

  try {
    const user = await User.findByIdAndUpdate(
      req.user.userId,
      {
        name: name.trim(),
        debeachLoginId: debeachLoginId.trim(),
      },
      { new: true },
    ).select("-password");

    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    if (
      typeof debeachLoginPassword === "string" &&
      debeachLoginPassword !== ""
    ) {
      user.debeachLoginPassword = encryptCredential(debeachLoginPassword);
      await user.save();
    }

    res.json({
      message: "프로필이 저장되었습니다.",
      user: serializeUser(user),
    });
  } catch (error) {
    res.status(500).json({ message: "프로필 저장에 실패했습니다.", error });
  }
});

app.put("/api/profile/password", authMiddleware, async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword) {
    return res.status(400).json({ message: "새 비밀번호를 입력해주세요." });
  }
  if (String(newPassword).length < 6) {
    return res
      .status(400)
      .json({ message: "새 비밀번호는 최소 6자 이상이어야 합니다." });
  }

  try {
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    const existingPendingRequest = await PasswordChangeRequest.findOne({
      userId: user._id,
      requestType: "app_password",
      status: "pending",
    });
    if (existingPendingRequest) {
      return res.status(409).json({
        message: "이미 관리자 승인 대기 중인 비밀번호 변경 요청이 있습니다.",
      });
    }

    const request = await PasswordChangeRequest.create({
      userId: user._id,
      requesterName: user.name,
      newPassword,
      requestType: "app_password",
      status: "pending",
    });

    res.status(201).json({
      message: "관리자에게 비밀번호 변경 요청을 보냈습니다.",
      request,
    });
  } catch (error) {
    res
      .status(500)
      .json({ message: "비밀번호 변경 요청에 실패했습니다.", error });
  }
});

app.put("/api/profile/debeach-password", authMiddleware, async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword) {
    return res
      .status(400)
      .json({ message: "새 드비치 비밀번호를 입력해주세요." });
  }

  try {
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    const existingPendingRequest = await PasswordChangeRequest.findOne({
      userId: user._id,
      requestType: "debeach_password",
      status: "pending",
    });
    if (existingPendingRequest) {
      return res.status(409).json({
        message:
          "이미 관리자 승인 대기 중인 드비치 비밀번호 변경 요청이 있습니다.",
      });
    }

    const request = await PasswordChangeRequest.create({
      userId: user._id,
      requesterName: user.name,
      newPassword,
      requestType: "debeach_password",
      status: "pending",
    });

    res.status(201).json({
      message: "관리자에게 드비치 비밀번호 변경 요청을 보냈습니다.",
      request,
    });
  } catch (error) {
    res.status(500).json({
      message: "드비치 비밀번호 변경 요청에 실패했습니다.",
      error,
    });
  }
});

app.get("/api/profile/password-request", authMiddleware, async (req, res) => {
  try {
    const appPasswordRequest = await PasswordChangeRequest.findOne({
      userId: req.user.userId,
      requestType: "app_password",
    })
      .select("status createdAt reviewedAt reviewedBy rejectReason requestType")
      .sort({ createdAt: -1 });
    const debeachPasswordRequest = await PasswordChangeRequest.findOne({
      userId: req.user.userId,
      requestType: "debeach_password",
    })
      .select("status createdAt reviewedAt reviewedBy rejectReason requestType")
      .sort({ createdAt: -1 });
    res.json({
      appPasswordRequest,
      debeachPasswordRequest,
    });
  } catch (error) {
    res.status(500).json({
      message: "비밀번호 변경 요청 상태를 불러오지 못했습니다.",
      error,
    });
  }
});

app.post("/api/auth/password-request", async (req, res) => {
  const { name, currentPassword, newPassword } = req.body;
  if (!name || !currentPassword || !newPassword) {
    return res.status(400).json({
      message: "이름, 현재 비밀번호, 새 비밀번호를 모두 입력해주세요.",
    });
  }
  if (String(newPassword).length < 6) {
    return res.status(400).json({
      message: "새 비밀번호는 최소 6자 이상이어야 합니다.",
    });
  }

  try {
    const users = await User.find({ name: String(name).trim() });
    if (!users.length) {
      return res.status(404).json({ message: "사용자를 찾을 수 없습니다." });
    }

    let matchedUser = null;
    for (const candidate of users) {
      const isMatch = await candidate.comparePassword(currentPassword);
      if (isMatch) {
        matchedUser = candidate;
        break;
      }
    }

    if (!matchedUser) {
      return res.status(401).json({
        message: "이름 또는 현재 비밀번호가 올바르지 않습니다.",
      });
    }

    const existingPendingRequest = await PasswordChangeRequest.findOne({
      userId: matchedUser._id,
      status: "pending",
    });
    if (existingPendingRequest) {
      return res.status(409).json({
        message: "이미 관리자 승인 대기 중인 비밀번호 변경 요청이 있습니다.",
      });
    }

    const request = await PasswordChangeRequest.create({
      userId: matchedUser._id,
      requesterName: matchedUser.name,
      newPassword,
      status: "pending",
    });

    res.status(201).json({
      message: "관리자에게 비밀번호 변경 요청을 보냈습니다.",
      request,
    });
  } catch (error) {
    res
      .status(500)
      .json({ message: "비밀번호 변경 요청에 실패했습니다.", error });
  }
});

app.get("/api/auth/password-request-status", async (req, res) => {
  const name = String(req.query.name || "").trim();
  if (!name) {
    return res.json({ request: null });
  }

  try {
    const users = await User.find({ name });
    if (!users.length) {
      return res.json({ request: null });
    }

    const userIds = users.map((user) => user._id);
    const request = await PasswordChangeRequest.findOne({
      userId: { $in: userIds },
    })
      .select(
        "status createdAt reviewedAt reviewedBy rejectReason requesterName",
      )
      .sort({ createdAt: -1 });

    return res.json({ request });
  } catch (error) {
    return res.status(500).json({
      message: "최근 비밀번호 변경 요청 상태를 불러오지 못했습니다.",
      error,
    });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const { name, password } = req.body;
  if (!name || !password) {
    return res.status(400).json({ message: "이름과 비밀번호를 입력해주세요." });
  }

  try {
    const users = await User.find({ name: String(name).trim() });
    if (!users.length) {
      return res
        .status(401)
        .json({ message: "이름 또는 비밀번호가 올바르지 않습니다." });
    }

    let matchedUser = null;
    for (const candidate of users) {
      const isMatch = await candidate.comparePassword(password);
      if (isMatch) {
        matchedUser = candidate;
        break;
      }
    }

    if (!matchedUser) {
      return res
        .status(401)
        .json({ message: "이름 또는 비밀번호가 올바르지 않습니다." });
    }

    if (!matchedUser.granted) {
      return res
        .status(403)
        .json({ message: "관리자 승인 후 로그인할 수 있습니다." });
    }

    const token = jwt.sign(
      {
        userId: matchedUser._id,
        role: matchedUser.role,
        name: matchedUser.name,
      },
      process.env.JWT_SECRET,
      { expiresIn: "365d" },
    );

    res.json({
      token,
      user: serializeUser(matchedUser),
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
    (q) => q.account === normalized.account && q.date === normalized.date,
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
    const users = await User.find({}, "-password").sort({
      createdAt: 1,
      name: 1,
      debeachLoginId: 1,
    });
    res.json(users.map((user) => serializeUser(user)));
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch users", error });
  }
});

app.put("/api/users/:id", authMiddleware, adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const { granted, role, name, debeachLoginId, debeachLoginPassword } =
      req.body;
    const update = {};
    if (typeof granted === "boolean") update.granted = granted;
    if (typeof role === "string") update.role = role;
    if (typeof name === "string") update.name = name.trim();
    if (typeof debeachLoginId === "string")
      update.debeachLoginId = debeachLoginId.trim();
    if (
      typeof debeachLoginPassword === "string" &&
      debeachLoginPassword.trim() !== ""
    )
      update.debeachLoginPassword = encryptCredential(debeachLoginPassword);
    const user = await User.findByIdAndUpdate(id, update, { new: true }).select(
      "-password",
    );
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    res.json(serializeUser(user));
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

app.get(
  "/api/password-change-requests",
  authMiddleware,
  adminOnly,
  async (req, res) => {
    try {
      const requests = await PasswordChangeRequest.find({})
        .select(
          "requesterName requestType status createdAt reviewedAt reviewedBy rejectReason",
        )
        .sort({ createdAt: -1 });
      res.json(
        requests.map((request) => serializePasswordChangeRequest(request)),
      );
    } catch (error) {
      res.status(500).json({
        message: "비밀번호 변경 요청 목록을 불러오지 못했습니다.",
        error,
      });
    }
  },
);

app.post(
  "/api/password-change-requests/:id/approve",
  authMiddleware,
  adminOnly,
  async (req, res) => {
    try {
      const request = await PasswordChangeRequest.findById(req.params.id);
      if (!request || request.status !== "pending") {
        return res
          .status(404)
          .json({ message: "처리할 요청을 찾을 수 없습니다." });
      }

      const user = await User.findById(request.userId);
      if (!user) {
        return res.status(404).json({ message: "사용자를 찾을 수 없습니다." });
      }

      if (request.requestType === "debeach_password") {
        user.debeachLoginPassword = encryptCredential(request.newPassword);
      } else {
        await user.setPassword(request.newPassword);
      }
      await user.save();

      request.status = "approved";
      request.rejectReason = "";
      request.reviewedBy = req.user.name;
      request.reviewedAt = new Date();
      await request.save();

      await createSystemChatMessage({
        adminUsername: req.user.name,
        userUsername: request.requesterName,
        body: buildPasswordRequestMessage(request, "approved"),
      });

      res.json({
        message: `${request.requesterName}님의 ${requestTypeLabel[request.requestType || "app_password"]} 변경을 승인했습니다.`,
      });
    } catch (error) {
      res
        .status(500)
        .json({ message: "비밀번호 변경 승인에 실패했습니다.", error });
    }
  },
);

app.post(
  "/api/password-change-requests/:id/reject",
  authMiddleware,
  adminOnly,
  async (req, res) => {
    try {
      const request = await PasswordChangeRequest.findById(req.params.id);
      if (!request || request.status !== "pending") {
        return res
          .status(404)
          .json({ message: "처리할 요청을 찾을 수 없습니다." });
      }

      request.status = "rejected";
      request.rejectReason = "";
      request.reviewedBy = req.user.name;
      request.reviewedAt = new Date();
      await request.save();

      await createSystemChatMessage({
        adminUsername: req.user.name,
        userUsername: request.requesterName,
        body: buildPasswordRequestMessage(request, "rejected"),
      });

      res.json({
        message: `${request.requesterName}님의 ${requestTypeLabel[request.requestType || "app_password"]} 변경 요청을 반려했습니다.`,
      });
    } catch (error) {
      res
        .status(500)
        .json({ message: "비밀번호 변경 반려에 실패했습니다.", error });
    }
  },
);

app.get("/api/messages/contacts", authMiddleware, async (req, res) => {
  try {
    const currentUser = await getCurrentUserRecord(req);
    if (req.user.role === "admin") {
      const users = await User.find({ role: "user" })
        .select("name granted debeachLoginId")
        .sort({ granted: 1, name: 1, debeachLoginId: 1 });
      const unreadCounts = await Message.aggregate([
        {
          $match: {
            adminUsername: currentUser.name,
            senderRole: "user",
            readBy: { $ne: currentUser.name },
          },
        },
        { $group: { _id: "$userUsername", count: { $sum: 1 } } },
      ]);
      const unreadMap = new Map(
        unreadCounts.map((item) => [item._id, item.count]),
      );
      return res.json(
        users.map((user) => ({
          username: user.name,
          name: user.name,
          granted: user.granted,
          unreadCount: unreadMap.get(user.name) || 0,
        })),
      );
    }

    const admins = await User.find({ role: "admin" })
      .select("name granted")
      .sort({ name: 1 });
    if (!admins.length) {
      return res.status(404).json({ message: "관리자를 찾을 수 없습니다." });
    }
    const unreadCounts = await Message.aggregate([
      {
        $match: {
          userUsername: currentUser.name,
          senderRole: "admin",
          readBy: { $ne: currentUser.name },
        },
      },
      { $group: { _id: "$adminUsername", count: { $sum: 1 } } },
    ]);
    const unreadMap = new Map(
      unreadCounts.map((item) => [item._id, item.count]),
    );
    return res.json(
      admins.map((admin) => ({
        username: admin.name,
        name: admin.name,
        granted: admin.granted,
        unreadCount: unreadMap.get(admin.name) || 0,
      })),
    );
  } catch (error) {
    return res
      .status(500)
      .json({ message: "연락처를 불러오지 못했습니다.", error });
  }
});

app.get("/api/messages", authMiddleware, async (req, res) => {
  try {
    const otherUsername = String(req.query.with || "").trim();
    const { adminUsername, userUsername } = await resolveConversationUsers(
      req,
      otherUsername,
    );
    const roomKey = buildRoomKey(adminUsername, userUsername);
    const currentUser = await getCurrentUserRecord(req);
    await Message.updateMany(
      {
        roomKey,
        senderUsername: { $ne: currentUser.name },
        readBy: { $ne: currentUser.name },
      },
      { $addToSet: { readBy: currentUser.name } },
    );
    const messages = await Message.find({ roomKey }).sort({ createdAt: 1 });
    return res.json(messages.map((message) => serializeMessage(message)));
  } catch (error) {
    return res
      .status(error.statusCode || 500)
      .json({ message: error.message || "메시지를 불러오지 못했습니다." });
  }
});

app.post("/api/messages", authMiddleware, async (req, res) => {
  try {
    const { toUsername, body, bookingContext } = req.body;
    if (!body || !String(body).trim()) {
      return res.status(400).json({ message: "메시지 내용을 입력해주세요." });
    }

    const { me, adminUsername, userUsername } = await resolveConversationUsers(
      req,
      String(toUsername || "").trim(),
    );
    const roomKey = buildRoomKey(adminUsername, userUsername);
    const message = new Message({
      roomKey,
      adminUsername,
      userUsername,
      senderUsername: me.name,
      senderRole: me.role,
      body: String(body).trim(),
      readBy: [me.name],
      bookingContext:
        bookingContext && typeof bookingContext === "object"
          ? {
              account: bookingContext.account || "",
              date: bookingContext.date || "",
              startTime: bookingContext.startTime || "",
              endTime: bookingContext.endTime || "",
              memo: bookingContext.memo || "",
              status: bookingContext.status || "",
              bookedTime: bookingContext.bookedTime || "",
            }
          : undefined,
    });
    await message.save();
    return res.status(201).json({ message: serializeMessage(message) });
  } catch (error) {
    return res
      .status(error.statusCode || 500)
      .json({ message: error.message || "메시지 전송에 실패했습니다." });
  }
});

// 모든 예약 정보를 MongoDB에서 읽어오는 API
app.get("/api/bookings", authMiddleware, async (req, res) => {
  try {
    const currentUser = await getCurrentUserRecord(req);
    const query =
      currentUser.role === "admin"
        ? {}
        : {
            $or: [{ account: currentUser.name }, { createdByRole: "admin" }],
          };

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
        { role: "user", granted: true },
        "name debeachLoginId debeachLoginPassword granted",
      );
      const result = users.map((user) => ({
        name: user.name,
        loginId: user.debeachLoginId || "",
        loginPassword: getPlainDebeachPassword(user.debeachLoginPassword),
        granted: user.granted,
      }));
      return res.json(result);
    }

    const user = await User.findById(req.user.userId).select(
      "name debeachLoginId debeachLoginPassword granted",
    );
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    res.json([
      {
        name: user.name,
        loginId: user.debeachLoginId || "",
        loginPassword: getPlainDebeachPassword(user.debeachLoginPassword),
        granted: user.granted,
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
    const currentUser = await getCurrentUserRecord(req);
    if (currentUser.role !== "admin" && NAME !== currentUser.name) {
      return res
        .status(403)
        .json({ message: "본인 예약만 등록할 수 있습니다." });
    }
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
      createdByName: currentUser.name,
      createdByRole: currentUser.role,
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
      { new: true }, // Return the updated document
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
    const currentUser = await getCurrentUserRecord(req);
    if (currentUser.role !== "admin" && account !== currentUser.name) {
      return res
        .status(403)
        .json({ message: "본인 예약만 삭제할 수 있습니다." });
    }
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
          ),
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
    const currentUser = await getCurrentUserRecord(req);
    const body = req.body;
    const job = {
      account: body.account ?? body.NAME,
      date: body.date ?? body.TARGET_DATE,
      startTime: body.startTime ?? body.START_TIME,
      endTime: body.endTime ?? body.END_TIME,
      force: body.force === true,
    };
    if (currentUser.role !== "admin" && job.account !== currentUser.name) {
      return res
        .status(403)
        .json({ message: "본인 예약만 실행할 수 있습니다." });
    }
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
        `[API] Booking time has passed. Running immediately for ${job.account} on ${job.date}`,
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

// Create HTTP server and WebSocket server
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

// WebSocket connection handler
wss.on("connection", (ws) => {
  console.log("WebSocket client connected");

  ws.on("error", (error) => {
    console.error("WebSocket error:", error);
  });

  ws.on("close", () => {
    console.log("WebSocket client disconnected");
  });
});

// Broadcast function for Lambda results
export function broadcastLambdaResult(data) {
  const message = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      // WebSocket.OPEN
      client.send(message);
    }
  });
}

if (!process.env.BOOKING_WORKER) {
  httpServer.listen(PORT, "localhost", () => {
    console.log(`Backend server is running on http://localhost:${PORT}`);
    console.log(`WebSocket server is running on ws://localhost:${PORT}`);
  });
}
